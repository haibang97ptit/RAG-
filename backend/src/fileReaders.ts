import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import * as cheerio from "cheerio";

export interface ParsedDocument {
  text: string;
  metadata: {
    fileName: string;
    filePath: string;
    category: string;
    fileType: string;
    sheetName?: string;
  };
}

async function readPDF(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

function htmlTableToMarkdown($: cheerio.CheerioAPI, tableEl: any): string {
  const rows: string[][] = [];

  $(tableEl)
    .find("tr")
    .each((_, tr) => {
      const cells: string[] = [];
      $(tr)
        .find("th, td")
        .each((_, cell) => {
          const text = $(cell)
            .text()
            .replace(/\s+/g, " ")
            .replace(/\|/g, "\\|")
            .trim();
          cells.push(text || " ");
        });
      if (cells.length > 0) rows.push(cells);
    });

  if (rows.length === 0) return "";

  const maxCols = Math.max(...rows.map((r) => r.length));
  rows.forEach((row) => {
    while (row.length < maxCols) row.push(" ");
  });

  const lines: string[] = [];
  lines.push("| " + rows[0].join(" | ") + " |");
  lines.push("| " + rows[0].map(() => "---").join(" | ") + " |");
  for (let i = 1; i < rows.length; i++) {
    lines.push("| " + rows[i].join(" | ") + " |");
  }

  return lines.join("\n");
}

async function readDOCX(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;

  const $ = cheerio.load(html);
  const parts: string[] = [];

  $("body")
    .children()
    .each((_, el) => {
      const tag = (el as any).tagName?.toLowerCase();

      if (tag === "table") {
        const md = htmlTableToMarkdown($, el);
        if (md) parts.push("\n\n" + md + "\n\n");
      } else if (tag === "ul" || tag === "ol") {
        $(el).find("li").each((idx, li) => {
          const bullet = tag === "ol" ? `${idx + 1}.` : "-";
          parts.push(`${bullet} ${$(li).text().trim()}\n`);
        });
        parts.push("\n");
      } else {
        const text = $(el).text().trim();
        if (text) {
          if (tag && /^h[1-6]$/.test(tag)) {
            const level = parseInt(tag.slice(1));
            parts.push("\n" + "#".repeat(level) + " " + text + "\n\n");
          } else {
            parts.push(text + "\n\n");
          }
        }
      }
    });

  if (parts.length === 0) {
    const fallback = await mammoth.extractRawText({ buffer });
    return fallback.value;
  }

  return parts.join("");
}

async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8");
}

async function readXLSX(filePath: string): Promise<{ sheetName: string; content: string }[]> {
  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const results: { sheetName: string; content: string }[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (!csv.trim()) continue;

    const rows = csv.split("\n").filter((r) => r.trim());
    if (rows.length === 0) continue;

    const headers = rows[0].split(",");
    let md = `# Sheet: ${sheetName}\n\n`;
    md += `| ${headers.join(" | ")} |\n`;
    md += `| ${headers.map(() => "---").join(" | ")} |\n`;
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].split(",");
      md += `| ${cells.join(" | ")} |\n`;
    }

    results.push({ sheetName, content: md });
  }

  return results;
}

function extractCategory(filePath: string, dataDir: string): string {
  const rel = path.relative(dataDir, filePath);
  const parts = rel.split(path.sep);
  return parts.length > 1 ? parts[0] : "Chung";
}

export async function readFile(
  filePath: string,
  dataDir: string
): Promise<ParsedDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const category = extractCategory(filePath, dataDir);
  const fileType = ext.replace(".", "");

  const contextHeader = `[Tài liệu: ${fileName} | Phòng ban: ${category}]\n\n`;

  try {
    switch (ext) {
      case ".pdf": {
        const text = await readPDF(filePath);
        return [{ text: contextHeader + text, metadata: { fileName, filePath, category, fileType } }];
      }
      case ".docx": {
        const text = await readDOCX(filePath);
        return [{ text: contextHeader + text, metadata: { fileName, filePath, category, fileType } }];
      }
      case ".txt":
      case ".md": {
        const text = await readText(filePath);
        return [{ text: contextHeader + text, metadata: { fileName, filePath, category, fileType } }];
      }
      case ".xlsx":
      case ".xls": {
        const sheets = await readXLSX(filePath);
        return sheets.map((s) => ({
          text: contextHeader + s.content,
          metadata: { fileName, filePath, category, fileType: "excel", sheetName: s.sheetName },
        }));
      }
      default:
        return [];
    }
  } catch (err) {
    console.warn(`   ⚠️  Lỗi đọc ${fileName}: ${(err as Error).message}`);
    return [];
  }
}

export async function walkDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];
  const allowedExts = new Set([".pdf", ".docx", ".txt", ".md", ".xlsx", ".xls"]);

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (allowedExts.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

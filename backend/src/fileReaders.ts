import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import * as cheerio from "cheerio";
import { readPdf } from "./pdfReader.js";

export interface ParsedDocument {
  text: string;
  metadata: {
    fileName: string;
    filePath: string;
    category: string;
    fileType: string;
    sheetName?: string;
    ocr?: boolean; // có trang lấy chữ bằng nhận dạng từ ảnh (PDF scan)
  };
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

    // Đọc theo từng ô (không qua CSV) để ô có dấu phẩy / xuống dòng không làm lệch cột
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });

    const rows = rawRows
      .map((row) =>
        row.map((cell) =>
          String(cell ?? "")
            .replace(/\s+/g, " ")
            .replace(/\|/g, "\\|")
            .trim()
        )
      )
      .filter((row) => row.some((cell) => cell !== ""));
    if (rows.length === 0) continue;

    // Bỏ các cột trống ở cuối, pad các dòng ngắn cho đủ cột
    const filledCols = (row: string[]) => {
      let n = row.length;
      while (n > 0 && row[n - 1] === "") n--;
      return n;
    };
    const colCount = rows.reduce((max, row) => Math.max(max, filledCols(row)), 0);
    const toLine = (row: string[]) => {
      const cells = Array.from({ length: colCount }, (_, i) => row[i] || " ");
      return `| ${cells.join(" | ")} |\n`;
    };

    let md = `# Sheet: ${sheetName}\n\n`;
    md += toLine(rows[0]);
    md += `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |\n`;
    for (let i = 1; i < rows.length; i++) {
      md += toLine(rows[i]);
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

/**
 * Throw nếu file không parse được (caller quyết định retry / báo lỗi).
 * Trả về [] nếu parse được nhưng không có text (vd PDF scan) - không index chunk rỗng.
 */
export async function readFile(
  filePath: string,
  dataDir: string
): Promise<ParsedDocument[]> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const category = extractCategory(filePath, dataDir);
  const fileType = ext.replace(".", "");

  const contextHeader = `[Tài liệu: ${fileName} | Phòng ban: ${category}]\n\n`;

  let text: string;
  let ocr = false;
  switch (ext) {
    case ".pdf": {
      // Trang scan được nhận dạng chữ (OCR) nếu máy có tesseract; xem pdfReader.ts
      const pdf = await readPdf(filePath);
      text = pdf.text;
      ocr = pdf.ocrPages > 0;
      break;
    }
    case ".docx":
      text = await readDOCX(filePath);
      break;
    case ".txt":
    case ".md":
      text = await readText(filePath);
      break;
    case ".xlsx":
    case ".xls": {
      const sheets = await readXLSX(filePath);
      if (sheets.length === 0) {
        console.warn(`   ⚠️  ${fileName}: không có dữ liệu trong sheet nào`);
      }
      return sheets.map((s) => ({
        text: contextHeader + s.content,
        metadata: { fileName, filePath, category, fileType: "excel", sheetName: s.sheetName },
      }));
    }
    default:
      return [];
  }

  if (!text.trim()) {
    console.warn(`   ⚠️  ${fileName}: không trích được text (file scan/ảnh?) - bỏ qua`);
    return [];
  }

  return [{ text: contextHeader + text, metadata: { fileName, filePath, category, fileType, ...(ocr ? { ocr } : {}) } }];
}

export const UPLOAD_EXTENSIONS = [".docx", ".pdf", ".xlsx", ".xls", ".txt", ".md"];

export interface UploadedText {
  text: string;
  ocrPages: number;
  ocrSkippedPages: number; // trang scan không được OCR vì vượt giới hạn
}

/**
 * Đọc file người dùng upload (so sánh / tìm đoạn, không index): như readFile nhưng không thêm dòng
 * "[Tài liệu: ...]" và không ghi gì ra đĩa (kể cả cache OCR). Định dạng không hỗ trợ → throw.
 */
export async function readUploadedText(filePath: string, fileName: string, maxOcrPages: number): Promise<UploadedText> {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".pdf": {
      const pdf = await readPdf(filePath, { persist: false, maxOcrPages });
      return { text: pdf.text, ocrPages: pdf.ocrPages, ocrSkippedPages: pdf.ocrSkippedPages ?? 0 };
    }
    case ".docx":
      return { text: await readDOCX(filePath), ocrPages: 0, ocrSkippedPages: 0 };
    case ".txt":
    case ".md":
      return { text: await readText(filePath), ocrPages: 0, ocrSkippedPages: 0 };
    case ".xlsx":
    case ".xls": {
      const sheets = await readXLSX(filePath);
      return { text: sheets.map((s) => `${s.sheetName}\n${s.content}`).join("\n\n"), ocrPages: 0, ocrSkippedPages: 0 };
    }
    default:
      throw new Error(`Không hỗ trợ định dạng ${ext || "(không có đuôi)"}`);
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
      } else if (entry.name.startsWith("~$")) {
        // File khóa tạm của Word/Excel (tạo ra khi có người đang mở tài liệu) - không phải tài liệu thật
        continue;
      } else if (/^glossary\.(xlsx|csv)$/i.test(entry.name)) {
        // Bảng thuật ngữ (glossary.ts đọc riêng), không phải tài liệu SOP
        continue;
      } else if (allowedExts.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

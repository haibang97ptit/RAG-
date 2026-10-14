import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";
import { config } from "./config.js";

/**
 * Bảng thuật ngữ của công ty: các cách gọi khác nhau của cùng một thứ ("phiếu thay đổi" = CCN,
 * "tự thanh tra" = self inspection, "BM" = biểu mẫu). Dùng để:
 *  - bước hiểu câu hỏi biết cách gọi nội bộ;
 *  - tìm tài liệu bằng cả các tên gọi khác (người dùng hỏi tiếng Việt, tài liệu phần lớn tiếng Anh).
 *
 * Hai nguồn, gộp lại:
 *  - src/knowledge/glossary.csv: bảng mặc định đi kèm code;
 *  - GLOSSARY_PATH (mặc định <DATA_DIR>/glossary.xlsx hoặc glossary.csv): bảng QA tự sửa trong thư mục
 *    tài liệu chung, được đồng bộ cùng tài liệu, không cần deploy lại. Đọc lại tự động khi file đổi.
 * Định dạng: cột 1 = các cách gọi, cách nhau bằng "|"; cột 2 = giải thích. Dòng đầu là tiêu đề.
 * Giải thích bắt đầu bằng "Phòng ban:" → chỉ dùng để nhận diện phòng ban, không thêm vào câu tìm kiếm.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILT_IN_PATH = path.join(__dirname, "knowledge", "glossary.csv");
const RELOAD_CHECK_MS = 60 * 1000;
const MAX_MATCHES = 8;

export interface GlossaryEntry {
  terms: string[];
  meaning: string;
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** CSV đơn giản: tự nhận dấu phân cách (Excel tiếng Việt hay lưu bằng ";"), hỗ trợ ô trong ngoặc kép. */
function parseCsv(content: string): string[][] {
  const text = content.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [";", "\t", ","].find((d) => firstLine.includes(d)) ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function readTable(filePath: string): Promise<string[][]> {
  if (/\.xlsx?$/i.test(filePath)) {
    const workbook = XLSX.read(await fs.readFile(filePath));
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][]).map((r) => r.map(String));
  }
  return parseCsv(await fs.readFile(filePath, "utf-8"));
}

function toEntries(rows: string[][]): GlossaryEntry[] {
  return rows
    .slice(1) // dòng tiêu đề
    .map(([terms = "", meaning = ""]) => ({
      terms: terms.split("|").map((t) => t.trim()).filter(Boolean),
      meaning: meaning.trim(),
    }))
    .filter((e) => e.terms.length > 0);
}

function userGlossaryPaths(): string[] {
  if (process.env.GLOSSARY_PATH) return [process.env.GLOSSARY_PATH];
  return [path.join(config.dataDir, "glossary.xlsx"), path.join(config.dataDir, "glossary.csv")];
}

let cache: { entries: GlossaryEntry[]; signature: string; checkedAt: number } | null = null;

async function fileSignature(paths: string[]): Promise<string> {
  const parts = await Promise.all(
    paths.map(async (p) => {
      try {
        const stat = await fs.stat(p);
        return `${p}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${p}:-`;
      }
    })
  );
  return parts.join("|");
}

export async function getGlossary(): Promise<GlossaryEntry[]> {
  if (cache && Date.now() - cache.checkedAt < RELOAD_CHECK_MS) return cache.entries;

  const paths = [BUILT_IN_PATH, ...userGlossaryPaths()];
  const signature = await fileSignature(paths);
  if (cache && cache.signature === signature) {
    cache.checkedAt = Date.now();
    return cache.entries;
  }

  const entries: GlossaryEntry[] = [];
  for (const p of paths) {
    try {
      entries.push(...toEntries(await readTable(p)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Không đọc được bảng thuật ngữ ${p}:`, (err as Error).message);
      }
    }
  }
  cache = { entries, signature, checkedAt: Date.now() };
  return entries;
}

/** Các mục thuật ngữ có cách gọi xuất hiện trong câu (so khớp nguyên từ, không phân biệt dấu). */
export async function glossaryMatches(text: string): Promise<GlossaryEntry[]> {
  const haystack = ` ${normalize(text)} `;
  if (!haystack.trim()) return [];
  const entries = await getGlossary().catch(() => []);
  return entries
    .filter((e) => e.terms.some((t) => {
      const needle = normalize(t);
      return needle.length > 0 && haystack.includes(` ${needle} `);
    }))
    .slice(0, MAX_MATCHES);
}

/** Dòng gợi ý cho bước hiểu câu hỏi. */
export function glossaryHint(entries: GlossaryEntry[]): string {
  if (entries.length === 0) return "";
  return `THUẬT NGỮ CÔNG TY (liên quan tới câu hỏi):\n${entries
    .map((e) => `- ${e.terms.join(" / ")}${e.meaning ? `: ${e.meaning}` : ""}`)
    .join("\n")}`;
}

/** Câu tìm kiếm kèm các tên gọi khác, để khớp cả tài liệu viết bằng tên khác (thường là tiếng Anh). */
export async function expandWithGlossary(query: string): Promise<string> {
  // Tên phòng ban chỉ để bước hiểu câu hỏi nhận diện, thêm vào câu tìm kiếm chỉ gây nhiễu
  // ("sop it 1012" không nên kéo theo mọi đoạn có chữ "công nghệ thông tin")
  const matches = (await glossaryMatches(query)).filter((e) => !/^phòng ban\s*:/i.test(e.meaning));
  if (matches.length === 0) return query;
  const haystack = ` ${normalize(query)} `;
  const extra = Array.from(
    new Set(matches.flatMap((e) => e.terms).filter((t) => !haystack.includes(` ${normalize(t)} `)))
  );
  return extra.length > 0 ? `${query} (${extra.join(", ")})` : query;
}

import { listIndexedFileEntries, type IndexedFile } from "./qdrantService.js";

/**
 * Tra danh mục file theo mã tài liệu trong câu hỏi.
 *
 * Vector search chỉ trả về vài đoạn trích giống câu hỏi nhất, nên câu hỏi dạng
 * "SOP-GEN 0005 có bao nhiêu biểu mẫu" / "liệt kê phụ lục của QA.1017" không thể trả lời
 * đúng từ đoạn trích: thông tin nằm ở DANH SÁCH TÊN FILE. Module này tìm các file có mã
 * khớp với câu hỏi để đưa nguyên danh sách vào prompt.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CATALOG_FILES = 80;

export interface CatalogMatch {
  files: IndexedFile[]; // tối đa MAX_CATALOG_FILES
  total: number;
}

let cache: { files: IndexedFile[]; loadedAt: number } | null = null;

async function getIndexedFiles(): Promise<IndexedFile[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.files;
  const files = await listIndexedFileEntries();
  cache = { files, loadedAt: Date.now() };
  return files;
}

// Tách thành cụm chữ / cụm số: "FRM.QA.SOP-GEN.0005-F11-03" → frm, qa, sop, gen, 0005, f, 11, 03
function tokenize(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(/\p{L}+|\p{N}+/gu) || [];
}

// Số tài liệu: cụm >= 3 chữ số ("0005", "1017"). Số ngắn hơn (phiên bản, số thứ tự) không đủ để định danh.
const isDocNumber = (t: string) => /^\d{3,}$/.test(t);
// Token có thể là một phần của mã tài liệu: chữ ASCII ngắn (sop, gen, qa, frm) hoặc số
const isCodeToken = (t: string) => /^[a-z]{2,6}$/.test(t) || /^\d+$/.test(t);

/**
 * Với mỗi số tài liệu trong câu hỏi: lấy các file có số đó trong tên, rồi chỉ giữ nhóm khớp
 * nhiều phần mã nhất (để "SOP-GEN 0005 QA" không lẫn với "SOP-PRD 0005").
 */
export function matchFilesByCode(query: string, files: IndexedFile[]): IndexedFile[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  const docNumbers = queryTokens.filter(isDocNumber);
  if (docNumbers.length === 0) return [];

  const codeTokens = queryTokens.filter(isCodeToken);
  const tokenized = files.map((file) => ({
    file,
    tokens: new Set(tokenize(file.fileName.replace(/\.[^.]+$/, ""))),
  }));

  const matched = new Set<IndexedFile>();
  for (const docNumber of docNumbers) {
    const candidates = tokenized
      .filter(({ tokens }) => tokens.has(docNumber))
      .map(({ file, tokens }) => ({
        file,
        score: codeTokens.filter((t) => tokens.has(t)).length,
      }));
    const best = Math.max(0, ...candidates.map((c) => c.score));
    for (const c of candidates) {
      if (c.score === best) matched.add(c.file);
    }
  }

  return Array.from(matched).sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** Lỗi khi tra danh mục không được làm hỏng câu trả lời → trả về null. */
export async function findCatalogForQuery(query: string): Promise<CatalogMatch | null> {
  try {
    const matched = matchFilesByCode(query, await getIndexedFiles());
    if (matched.length === 0) return null;
    return { files: matched.slice(0, MAX_CATALOG_FILES), total: matched.length };
  } catch (err) {
    console.warn("File catalog lookup failed:", (err as Error).message);
    return null;
  }
}

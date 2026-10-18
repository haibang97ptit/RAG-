import { config } from "./config.js";
import { listIndexedFileEntries, type IndexedFile } from "./qdrantService.js";
import { fileMatchesCode, parseDocCodes, parseFileCode } from "./docCode.js";

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
  // Mỗi mã tài liệu nhắc trong câu hỏi là một nhóm (dùng khi so sánh 2 tài liệu với nhau)
  groups: IndexedFile[][];
}

let cache: { files: IndexedFile[]; loadedAt: number } | null = null;

export async function getIndexedFiles(): Promise<IndexedFile[]> {
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
// Token có thể là một phần của mã tài liệu: chữ ASCII ngắn (sop, gen, qa, frm) hoặc số tài liệu.
// Số ngắn bị loại để "SOP 0005 có 17 biểu mẫu?" không bị thu hẹp nhầm về file F17.
const isCodeToken = (t: string) => /^[a-z]{2,6}$/.test(t) || isDocNumber(t);

// Phần mã của tên file = cụm (không chứa khoảng trắng) có số tài liệu:
// "FRM-QA-SOP-GEN-0005-F17-02 SELF INSPECTION CHECKLIST – IT" → "FRM-QA-SOP-GEN-0005-F17-02".
// Chỉ chấm điểm trên phần này, để chữ trong tiêu đề ("IT") không bị coi là mã phòng ban.
function codePartTokens(fileName: string, docNumber: string): Set<string> {
  const segments = stripExtension(fileName).split(/\s+/);
  const codeSegment = segments.find((s) => tokenize(s).includes(docNumber));
  return new Set(tokenize(codeSegment || ""));
}

/**
 * Với mỗi số tài liệu trong câu hỏi: lấy các file có số đó trong tên, rồi chỉ giữ nhóm khớp
 * nhiều phần mã nhất (để "SOP-GEN 0005 QA" không lẫn với "SOP-PRD 0005").
 */
export function matchFilesByCode(
  query: string,
  files: IndexedFile[],
  preferredCategory: string = ""
): IndexedFile[] {
  const matched = new Set(matchFileGroupsByCode(query, files, preferredCategory).flat());
  return Array.from(matched).sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** Như matchFilesByCode nhưng giữ riêng từng nhóm: mỗi mã tài liệu trong câu hỏi là một nhóm file (theo thứ tự xuất hiện). */
export function matchFileGroupsByCode(
  query: string,
  files: IndexedFile[],
  preferredCategory: string = ""
): IndexedFile[][] {
  const groups: IndexedFile[][] = [];
  const preferInCategory = (group: IndexedFile[]) => {
    const preferred = group.filter((f) => f.category.toLowerCase() === preferredCategory.toLowerCase());
    return preferred.length > 0 && preferred.length < group.length ? preferred : group;
  };

  // Mã viết theo kiểu SOP ("sop qa 13", "sopqa13", "FRM/IT/SOP-GEN/0013-F01"): so theo mã đã chuẩn hoá
  const covered = new Set<string>();
  for (const code of parseDocCodes(query)) {
    covered.add(code.number);
    let group = files.filter((f) => {
      const fileCode = parseFileCode(f.fileName);
      return !!fileCode && fileMatchesCode(fileCode, f.category, code);
    });
    // Nêu đích danh biểu mẫu / phụ lục ("...-F02") → chỉ file đó, nếu có
    const exact = group.filter((f) => {
      const s = parseFileCode(f.fileName)?.sub;
      return !!code.sub && s?.kind === code.sub.kind && Number(s.number) === Number(code.sub.number);
    });
    if (exact.length > 0) group = exact;
    if (!code.department) group = preferInCategory(group);
    if (group.length > 0) groups.push(group.sort((a, b) => a.fileName.localeCompare(b.fileName)));
  }

  // Cách viết khác ("0005 và 0017 của QA", "P.IT.1016"): chấm điểm theo các phần mã như trước
  const queryTokens = Array.from(new Set(tokenize(query)));
  const docNumbers = queryTokens.filter((t) => isDocNumber(t) && !covered.has(t.padStart(4, "0")));
  const codeTokens = queryTokens.filter(isCodeToken);
  for (const docNumber of docNumbers) {
    const candidates = files
      .map((file) => ({ file, tokens: codePartTokens(file.fileName, docNumber) }))
      .filter(({ tokens }) => tokens.has(docNumber))
      .map(({ file, tokens }) => ({
        file,
        score: codeTokens.filter((t) => tokens.has(t)).length,
      }));
    const best = Math.max(0, ...candidates.map((c) => c.score));
    // Gọi tắt ("0005") mà nhiều phòng ban cùng có số này → lấy phòng ban mặc định.
    // Nếu user ghi rõ phòng ban thì bước chấm điểm ở trên đã chọn đúng rồi.
    const group = preferInCategory(candidates.filter((c) => c.score === best).map((c) => c.file));

    if (group.length > 0) groups.push(group.sort((a, b) => a.fileName.localeCompare(b.fileName)));
  }

  return groups;
}

// Ký hiệu biểu mẫu / phụ lục trong mã: -F01, -A03 (F = Format, A = Appendix)
const FORM_OR_APPENDIX = /(?<![\p{L}\p{N}])[fa]\d{1,3}(?![\p{L}\p{N}])/iu;

// Chỉ bỏ đuôi file thật: tên kiểu "FRM.QA.SOP-GEN.0005-F11-03 ..." có dấu chấm trong mã,
// bỏ "phần sau dấu chấm cuối" với tên đã mất đuôi sẽ cắt mất cả mã
export const stripExtension = (fileName: string) => fileName.replace(/\.(docx?|pdf|xlsx?|txt|md)$/i, "");

/** File không có ký hiệu F/A trong tên là SOP chính. */
export function isMainDocument(fileName: string): boolean {
  return !FORM_OR_APPENDIX.test(stripExtension(fileName));
}

/** Câu hỏi có nhắc đích danh một biểu mẫu / phụ lục ("F07 của SOP 0005") không. */
export function mentionsFormOrAppendix(query: string): boolean {
  return FORM_OR_APPENDIX.test(query.normalize("NFC"));
}

/** Lỗi khi tra danh mục không được làm hỏng câu trả lời → trả về null. */
export async function findCatalogForQuery(query: string): Promise<CatalogMatch | null> {
  try {
    const groups = matchFileGroupsByCode(query, await getIndexedFiles(), config.defaultCategory);
    const matched = Array.from(new Set(groups.flat())).sort((a, b) => a.fileName.localeCompare(b.fileName));
    if (matched.length === 0) return null;
    return { files: matched.slice(0, MAX_CATALOG_FILES), total: matched.length, groups };
  } catch (err) {
    console.warn("File catalog lookup failed:", (err as Error).message);
    return null;
  }
}

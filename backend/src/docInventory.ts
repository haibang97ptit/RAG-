import { getIndexedFiles, isMainDocument, stripExtension } from "./fileCatalog.js";
import type { IndexedFile } from "./qdrantService.js";

/**
 * Câu hỏi về KHO tài liệu: "phòng QA có bao nhiêu SOP", "liệt kê các biểu mẫu của IT".
 *
 * Đoạn trích tìm bằng vector không trả lời được (chỉ có ~10 đoạn), nên đếm thẳng trên danh mục
 * file đã index. Danh sách do server tự in; LLM chỉ nhận số liệu để viết phần mở đầu.
 */

type DocType = "sop" | "form" | "appendix";

const WORD_START = "(?<![\\p{L}\\p{N}])";
const WORD_END = "(?![\\p{L}\\p{N}])";
const words = (alternation: string) => new RegExp(`${WORD_START}(?:${alternation})${WORD_END}`, "iu");

const DOC_NOUNS = "sop|sops|quy trình|biểu mẫu|form|forms|format|formats|phụ lục|appendix|appendices|tài liệu|văn bản";
// Đối tượng được đếm / liệt kê phải là chính loại tài liệu: "bao nhiêu SOP", "liệt kê các biểu mẫu".
// "quy trình X có mấy bước" không khớp vì thứ được đếm là "bước".
const COUNTED_DOCUMENTS = new RegExp(
  `${WORD_START}(?:bao nhiêu|mấy|số lượng|tổng số|đếm|liệt kê|danh sách|kể tên|tất cả|toàn bộ|các|những)\\s+` +
    `(?:(?:các|những|cái|file|bản)\\s+)?(?:${DOC_NOUNS})${WORD_END}`,
  "iu"
);
const COUNT_WORDS = words("bao nhiêu|mấy|số lượng|tổng số|đếm|tổng cộng");
const LIST_WORDS = words("liệt kê|danh sách|kể tên|gồm những|có những|những (?:sop|biểu mẫu|phụ lục|tài liệu) nào|các (?:sop|biểu mẫu|phụ lục|tài liệu) nào");
// Hỏi theo NỘI DUNG ("các SOP về vệ sinh", "SOP nào quy định...") → để luồng tìm kiếm thường xử lý
const TOPIC_WORDS = words("về|liên quan|đề cập|nói|quy định|hướng dẫn|yêu cầu|nội dung|áp dụng|khi|nếu|trùng|giống|khác|so sánh");

const TYPE_WORDS: [DocType[], RegExp][] = [
  [["form"], words("biểu mẫu|form|forms|format|formats")],
  [["appendix"], words("phụ lục|appendix|appendices")],
  [["sop"], words("sop|sops|quy trình")],
  [["sop", "form", "appendix"], words("tài liệu|văn bản|file")],
];

// Tên gọi phòng ban → mã (= tên thư mục cấp 1 trong DATA_DIR)
const DEPARTMENT_ALIASES: [string, RegExp][] = [
  ["QA", words("đảm bảo chất lượng|quality assurance")],
  ["QC", words("kiểm tra chất lượng|kiểm nghiệm|quality control")],
  ["IT", words("công nghệ thông tin")],
  ["PD", words("sản xuất|production")],
  ["WH", words("kho|warehouse")],
  ["ME", words("cơ điện")],
  ["HR", words("nhân sự|hành chính")],
  ["RA", words("đăng ký")],
  ["PU", words("kế hoạch|cung ứng|mua hàng")],
];

const TYPE_LABELS: Record<DocType, string> = { sop: "SOP chính", form: "Biểu mẫu", appendix: "Phụ lục" };
const LIST_LINE_CHARS = 110;
const MAX_LIST_LINES = 300;
// Câu chỉ hỏi số lượng: vẫn in danh sách nếu không quá dài, để người dùng kiểm lại được
const COUNT_ONLY_LIST_LIMIT = 150;

export const INVENTORY_LIST_HEADING = "**Danh sách tài liệu";

export interface InventoryReply {
  summaryJson: string;
  list: { markdown: string; fallbackIntro: string };
}

const tokenize = (text: string) => text.normalize("NFC").toLowerCase().match(/\p{L}+|\p{N}+/gu) || [];

function docTypeOf(fileName: string): DocType {
  const name = stripExtension(fileName);
  if (isMainDocument(name)) return "sop";
  return /(?<![\p{L}\p{N}])a\d{1,3}(?![\p{L}\p{N}])/iu.test(name) ? "appendix" : "form";
}

/**
 * Một tài liệu có thể có nhiều file (bản dịch, bản PDF + Word, nhiều phiên bản): gom theo mã.
 * Mã = phần đầu tên file tới hết số tài liệu (+ ký hiệu F/A nếu là biểu mẫu / phụ lục):
 * "FRM-QA-SOP-GEN-0005-03 SELF INSPECTION.docx" → "frm qa sop gen 0005".
 */
function documentKey(fileName: string): string {
  const name = stripExtension(fileName);
  const segment = name.split(/\s+/).find((s) => /\d{3,}/.test(s));
  if (!segment) return name.toLowerCase();
  const tokens = tokenize(segment);
  const numberAt = tokens.findIndex((t) => /^\d{3,}$/.test(t));
  let end = numberAt + 1;
  // Biểu mẫu / phụ lục: giữ thêm "f 17" / "a 03"
  if (/^[fa]$/.test(tokens[end] ?? "") && /^\d{1,3}$/.test(tokens[end + 1] ?? "")) end += 2;
  return tokens.slice(0, end).join(" ");
}

const DEPARTMENT_CODES = ["qa", "qc", "pd", "wh", "me", "it", "hr", "ra", "fd", "ad", "ds", "pu", "ts"];

/** Mã phòng ban người dùng nhắc tới, kể cả phòng không có thư mục nào trong kho. */
function mentionedDepartmentCodes(query: string): string[] {
  const queryTokens = new Set(tokenize(query));
  const aliasCodes = DEPARTMENT_ALIASES.filter(([, re]) => re.test(query)).map(([code]) => code.toLowerCase());
  return Array.from(new Set([...DEPARTMENT_CODES.filter((c) => queryTokens.has(c)), ...aliasCodes]));
}

function departmentsIn(query: string, categories: string[]): string[] {
  const queryTokens = new Set(tokenize(query));
  const aliasCodes = DEPARTMENT_ALIASES.filter(([, re]) => re.test(query)).map(([code]) => code.toLowerCase());
  return categories.filter((category) => {
    const categoryTokens = tokenize(category);
    if (categoryTokens.length === 0) return false;
    // Tên thư mục dạng mã ("QA") hoặc có chứa mã ("1. QA", "QA - Quality Assurance")
    return (
      categoryTokens.some((t) => /^[a-z]{2,3}$/.test(t) && (queryTokens.has(t) || aliasCodes.includes(t))) ||
      query.toLowerCase().includes(category.toLowerCase())
    );
  });
}

export function isInventoryQuestion(query: string): boolean {
  const text = query.normalize("NFC");
  if (/\d{3,}/.test(text)) return false; // có mã tài liệu → luồng danh mục theo mã xử lý
  if (!COUNTED_DOCUMENTS.test(text)) return false;
  if (!COUNT_WORDS.test(text) && !LIST_WORDS.test(text)) return false;
  return !TOPIC_WORDS.test(text);
}

interface DocumentEntry {
  key: string;
  type: DocType;
  category: string;
  fileName: string;
  fileCount: number;
}

function collectDocuments(files: IndexedFile[]): DocumentEntry[] {
  const byKey = new Map<string, DocumentEntry>();
  for (const file of files) {
    const type = docTypeOf(file.fileName);
    const key = `${file.category}|${type}|${documentKey(file.fileName)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.fileCount++;
      // Hiển thị tên file ngắn gọn nhất trong nhóm (thường là bản gốc, không có "translation")
      if (file.fileName.length < existing.fileName.length) existing.fileName = file.fileName;
    } else {
      byKey.set(key, { key, type, category: file.category, fileName: file.fileName, fileCount: 1 });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.fileName.localeCompare(b.fileName)
  );
}

const countBy = (entries: DocumentEntry[], keyOf: (e: DocumentEntry) => string) => {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[keyOf(e)] = (counts[keyOf(e)] ?? 0) + 1;
  return counts;
};

function renderList(entries: DocumentEntry[], types: DocType[], groupByCategory: boolean): string {
  const shown = entries.slice(0, MAX_LIST_LINES);
  const lines = [`${INVENTORY_LIST_HEADING} (${shown.length}/${entries.length})**`];
  const groups = new Map<string, DocumentEntry[]>();
  for (const e of shown) {
    const group = [groupByCategory ? `Phòng ${e.category}` : "", types.length > 1 ? TYPE_LABELS[e.type] : ""]
      .filter(Boolean)
      .join(" · ");
    groups.set(group, [...(groups.get(group) ?? []), e]);
  }
  for (const [group, groupEntries] of groups) {
    if (group) lines.push("", `**${group}** (${groupEntries.length})`);
    lines.push(
      "",
      ...groupEntries.map((e) => {
        const name = stripExtension(e.fileName);
        const short = name.length > LIST_LINE_CHARS ? `${name.slice(0, LIST_LINE_CHARS)}…` : name;
        return `- ${short}${e.fileCount > 1 ? ` _(${e.fileCount} file)_` : ""}`;
      })
    );
  }
  if (entries.length > shown.length) {
    lines.push("", `_Mới hiển thị ${shown.length}/${entries.length}. Hỏi theo từng phòng ban hoặc từng loại tài liệu để xem phần còn lại._`);
  }
  return `\n\n${lines.join("\n")}`;
}

/** Trả lời câu hỏi về kho tài liệu; null nếu không phải loại câu hỏi này (hoặc không đọc được danh mục). */
export async function inventoryReplyFor(
  query: string,
  indexedFiles?: IndexedFile[] // để thử nghiệm; mặc định đọc từ Qdrant
): Promise<InventoryReply | null> {
  if (!isInventoryQuestion(query)) return null;

  let files: IndexedFile[];
  try {
    files = indexedFiles ?? (await getIndexedFiles());
  } catch (err) {
    console.warn("Không đọc được danh mục file:", (err as Error).message);
    return null;
  }
  if (files.length === 0) return null;

  const text = query.normalize("NFC");
  const types = TYPE_WORDS.find(([, re]) => re.test(text))?.[0] ?? ["sop"];
  const categories = Array.from(new Set(files.map((f) => f.category))).sort();
  const departments = departmentsIn(text, categories);
  // Nhắc tới phòng ban không có trong kho ("phòng HR") → kết quả 0, không phải đếm cả công ty
  const missingDepartments = departments.length === 0 ? mentionedDepartmentCodes(text).map((c) => c.toUpperCase()) : [];

  const inScope = files.filter((f) =>
    missingDepartments.length > 0 ? false : departments.length === 0 || departments.includes(f.category)
  );
  const entries = collectDocuments(inScope).filter((e) => types.includes(e.type));
  const wantsList = LIST_WORDS.test(text) || entries.length <= COUNT_ONLY_LIST_LIMIT;

  const summary = {
    phamVi:
      departments.length > 0
        ? `phòng ${departments.join(", ")}`
        : missingDepartments.length > 0
          ? `phòng ${missingDepartments.join(", ")}`
          : "tất cả phòng ban",
    phongBanCoTrongKho: missingDepartments.length > 0 ? categories : undefined,
    loaiTaiLieu: types.map((t) => TYPE_LABELS[t]).join(", "),
    tongSo: entries.length,
    soFile: entries.reduce((sum, e) => sum + e.fileCount, 0),
    theoPhongBan: departments.length === 1 || missingDepartments.length > 0 ? undefined : countBy(entries, (e) => e.category),
    theoLoai: types.length > 1 ? countBy(entries, (e) => TYPE_LABELS[e.type]) : undefined,
    cachDem:
      "Mỗi mã tài liệu tính là 1 (nhiều file cùng mã như bản dịch, bản PDF và Word chỉ tính 1). " +
      "SOP chính = file không có ký hiệu F (biểu mẫu) hay A (phụ lục) trong mã.",
    danhSachBenDuoi: wantsList,
  };

  const scope = summary.phamVi;
  const fallbackIntro = `Theo danh mục tài liệu trợ lý đang có, ${scope} có **${entries.length}** ${summary.loaiTaiLieu.toLowerCase()}.`;
  return {
    summaryJson: JSON.stringify(summary, null, 1),
    list: {
      markdown: wantsList && entries.length > 0 ? renderList(entries, types, departments.length !== 1) : "",
      fallbackIntro,
    },
  };
}

import { getCatalogFiles, isMainDocument, stripExtension } from "./fileCatalog.js";
import type { IndexedFile } from "./qdrantService.js";
import {
  DEPARTMENT_CODES,
  expandAbbreviations,
  fileMatchesCode,
  parseDocCodes,
  parseFileCode,
  sopLabel,
  textWithoutCodes,
  type DocCode,
  type FileCode,
} from "./docCode.js";

/**
 * Câu hỏi về KHO tài liệu: "phòng QA có bao nhiêu SOP", "liệt kê các biểu mẫu của IT",
 * "sop qa 13 có mấy biểu mẫu", "F02 thuộc sop nào".
 *
 * Đoạn trích tìm bằng vector không trả lời được (chỉ có ~10 đoạn), nên đếm thẳng trên danh mục: danh mục
 * chính thức của Docuzen nếu bật (bản đang hiệu lực, có loại / phiên bản / tài liệu mẹ), không thì danh mục
 * file đã index (đoán loại từ tên file). Danh sách do server tự in; LLM chỉ nhận số liệu để viết phần mở đầu.
 * Quy tắc hiểu câu hỏi theo docs/training-ver2.docx.
 */

// list / other chỉ có khi danh mục lấy từ Docuzen (List thiết bị, đặc tính kỹ thuật, hồ sơ lô, thẩm định...)
export type DocType = "sop" | "form" | "appendix" | "list" | "other";

// Mọi mẫu dưới đây chạy trên câu đã expandAbbreviations(): chữ thường, không dấu
const WORD_START = "(?<![a-z0-9])";
const WORD_END = "(?![a-z0-9])";
const words = (alternation: string) => new RegExp(`${WORD_START}(?:${alternation})${WORD_END}`);

const SOP_WORDS = "sop|sops|quy trinh|qt|procedures?";
const FORM_WORDS = "bieu mau|mau bieu|bm|forms?|formats?|mau";
const APPENDIX_WORDS = "phu luc|pl|appendix|appendices|annex(?:es)?";
const ALL_WORDS = "tai lieu|van ban|files?|documents?";
const LIST_TYPE_WORDS = "list|lists|danh sach thiet bi";
// Loại tài liệu khác của Docuzen gọi theo mã ("có bao nhiêu SPE của QC", "các SOP-CAL của QC"). Đặt trước "sop"
// để "sop-cal" khớp trọn. Bỏ các mã trùng chữ tiếng Việt (gap, sat, fat) và "ar" (quá ngắn).
const TYPE_FAMILY_WORDS =
  "sop[\\s._-]*(?:gen|opc|cal|ppm|gtp|mic|chp)|spe|stp|bmr|bpr|bom|bop|mfr|urs|vmp|smf|qm|apqr|pvp|pvr|iqp|oqp|pqp|mtp|mtr|ssp|ssr";
const DOC_NOUNS = `${TYPE_FAMILY_WORDS}|${SOP_WORDS}|${FORM_WORDS}|${APPENDIX_WORDS}|${LIST_TYPE_WORDS}|${ALL_WORDS}`;

// Đối tượng được đếm / liệt kê phải là chính loại tài liệu: "bao nhiêu SOP", "liệt kê các biểu mẫu".
// "quy trình X có mấy bước" không khớp vì thứ được đếm là "bước".
const COUNTED_DOCUMENTS = new RegExp(
  `${WORD_START}(?:bao nhieu|may|so luong|tong so|so|dem|liet ke|danh sach|ke ten|tat ca|toan bo|cac|nhung|how many|list)\\s+` +
    `(?:(?:cac|nhung|cai|file|ban)\\s+)?(?:${DOC_NOUNS})${WORD_END}`
);
const COUNT_WORDS = words(
  `bao nhieu|may(?! tinh)|so luong|tong so|dem|tong cong|how many|number of|so(?= (?:cac |nhung )?(?:${DOC_NOUNS})${WORD_END})`
);
const LIST_WORDS = new RegExp(
  `${WORD_START}(?:liet ke|danh sach|ke ten|gom nhung|co nhung|gom gi|co gi|list|(?:nhung|cac) (?:${DOC_NOUNS}) nao|(?:${DOC_NOUNS}) (?:nao|gi))${WORD_END}`
);
// Hỏi theo NỘI DUNG ("các SOP về vệ sinh", "SOP nào quy định...") → để luồng tìm kiếm thường xử lý
const TOPIC_WORDS = words("ve|lien quan|de cap|noi|quy dinh|huong dan|yeu cau|noi dung|ap dung|khi|neu|trung|giong|khac|so sanh");
// Hỏi nội dung của một SOP cụ thể ("liệt kê các bước của sop qa 13"): luôn là hỏi nội dung (mục 4.1 tài liệu training)
const CONTENT_WORDS = words(
  "buoc|cac buoc|noi dung|quy dinh|noi gi|noi ve|dung de|dung lam|lam gi|tom tat|huong dan|trach nhiem|muc dich|pham vi|nhu the nao|the nao|ra sao|tai sao|vi sao|cach|yeu cau|tieu chuan|thoi gian|bao lau"
);
// Tra ngược: biểu mẫu / phụ lục này thuộc SOP nào
const PARENT_WORDS = words("thuoc|nam trong|nam o|la cua|cua sop nao|o sop nao|sop me|belongs?|part of");
// Hỏi thông tin của tài liệu (tên, phiên bản, ngày ban hành, hiệu lực)
const INFO_WORDS = words("ten (?:la )?gi|ten sop|ten day du|ten tai lieu|title|phien ban|version|revision|ngay ban hanh|ban hanh|hieu luc|hien hanh khong");
const VERSION_WORDS = words("phien ban|version|revision|ngay ban hanh|ban hanh|hieu luc|hien hanh khong");

const TYPE_WORDS: [DocType, RegExp][] = [
  ["form", words(FORM_WORDS)],
  ["appendix", words(APPENDIX_WORDS)],
  ["list", words(LIST_TYPE_WORDS)],
  ["sop", words(SOP_WORDS)],
];
const TYPE_ORDER: DocType[] = ["sop", "form", "appendix", "list", "other"];
// "tài liệu" chung chung → mọi loại có trong danh mục (danh mục theo tên file chỉ có 3 loại đầu)
const typesIn = (files: IndexedFile[]): DocType[] => {
  const present = new Set(files.map(docTypeOf));
  return TYPE_ORDER.filter((t) => present.has(t));
};

// Tên gọi phòng ban → mã (= tên thư mục cấp 1 trong DATA_DIR), theo mục 1.1 tài liệu training
const DEPARTMENT_ALIASES: [string, RegExp][] = [
  ["QA", words("dam bao chat luong|phong chat luong|quality assurance")],
  ["QC", words("kiem tra chat luong|kiem soat chat luong|kiem nghiem|quality control")],
  ["IT", words("cong nghe thong tin|cntt|phong may tinh|information technology")],
  ["PD", words("san xuat|(?:phan|ben|cua|phong|o|tai) xuong|production")],
  // "kho" một mình thường là kho tài liệu ("kho có bao nhiêu biểu mẫu"), không phải phòng kho
  ["WH", words("(?:phong|bo phan|ben|cua|thu) kho|kho hang|warehouse")],
  ["ME", words("co dien|maintenance")],
  ["HR", words("nhan su|hanh chinh nhan su|hanh chinh|hcns|human resources?")],
  ["RA", words("dang ky|dang ki|regulatory affairs|regulatory")],
  ["FD", words("phat trien cong thuc|formula development")],
  ["PU", words("ke hoach|cung ung|mua hang|purchasing")],
];

const TYPE_LABELS: Record<DocType, string> = { sop: "SOP chính", form: "Biểu mẫu", appendix: "Phụ lục", list: "List", other: "Tài liệu khác" };
const TYPE_NOUNS: Record<DocType, string> = { sop: "SOP", form: "biểu mẫu", appendix: "phụ lục", list: "list", other: "tài liệu khác" };
const LIST_LINE_CHARS = 140;
const MAX_LIST_LINES = 300;
const MAX_SUGGESTIONS = 5;

export const INVENTORY_LIST_HEADING = "**Danh sách tài liệu";

export type InventoryReply =
  // Số liệu cho LLM viết phần mở đầu + danh sách do server in
  | { kind: "list"; summaryJson: string; list: { markdown: string; fallbackIntro: string } }
  // Câu trả lời dựng sẵn (hỏi lại, không tìm thấy, biểu mẫu của một SOP, tra ngược): không cần LLM
  | { kind: "text"; text: string; summary: Record<string, unknown> };

const tokenize = (text: string) => text.normalize("NFC").toLowerCase().match(/\p{L}+|\p{N}+/gu) || [];

function docTypeOf(file: IndexedFile): DocType {
  if (file.docuzen) return file.docuzen.group;
  const name = stripExtension(file.fileName);
  if (isMainDocument(name)) return "sop";
  return /(?<![\p{L}\p{N}])a\d{1,3}(?![\p{L}\p{N}])/iu.test(name) ? "appendix" : "form";
}

/** Mã của một tài liệu: từ Docuzen nếu có, không thì đọc từ tên file. */
function codeOf(file: IndexedFile): FileCode | null {
  const m = file.docuzen;
  if (!m) return parseFileCode(file.fileName);
  return {
    department: file.category.toUpperCase(),
    series: /^SOP-/i.test(m.typeCode) ? m.typeCode.slice(4).toUpperCase() : null,
    number: m.serial ?? "",
    sub: m.sub,
    code: m.number,
    title: m.title,
  };
}

/**
 * Một tài liệu có thể có nhiều file (bản dịch, bản PDF + Word, nhiều phiên bản): gom theo mã.
 * Mã = phần đầu tên file tới hết số tài liệu (+ ký hiệu F/A nếu là biểu mẫu / phụ lục):
 * "FRM-QA-SOP-GEN-0005-03 SELF INSPECTION.docx" → "frm qa sop gen 0005".
 */
function documentKey(file: IndexedFile): string {
  if (file.docuzen) return `dz ${file.docuzen.documentId}`;
  const name = stripExtension(file.fileName);
  const segment = name.split(/\s+/).find((s) => /\d{3,}/.test(s));
  if (!segment) return name.toLowerCase();
  const tokens = tokenize(segment);
  const numberAt = tokens.findIndex((t) => /^\d{3,}$/.test(t));
  let end = numberAt + 1;
  // Biểu mẫu / phụ lục: giữ thêm "f 17" / "a 03"
  if (/^[fa]$/.test(tokens[end] ?? "") && /^\d{1,3}$/.test(tokens[end + 1] ?? "")) end += 2;
  return tokens.slice(0, end).join(" ");
}

/**
 * Các từ có thể là mã phòng: so trên chữ CÒN DẤU để "ít" không thành IT, và bỏ chữ viết tắt đã được
 * hiểu theo nghĩa khác ("ds sop" = danh sách, không phải phòng DS).
 */
function departmentTokens(query: string): Set<string> {
  const kept = new Set(tokenize(expandAbbreviations(query)));
  return new Set(tokenize(query).filter((t) => kept.has(t)));
}

const aliasDepartments = (folded: string) => DEPARTMENT_ALIASES.filter(([, re]) => re.test(folded)).map(([code]) => code);

/** Mã phòng ban người dùng nhắc tới, kể cả phòng không có thư mục nào trong kho. */
function mentionedDepartmentCodes(query: string): string[] {
  const queryTokens = departmentTokens(query);
  const codes = DEPARTMENT_CODES.filter((c) => c !== "prd" && queryTokens.has(c)).map((c) => c.toUpperCase());
  return Array.from(new Set([...codes, ...aliasDepartments(expandAbbreviations(query))]));
}

/** "sop phòng ABC": tên phòng viết hoa không phải phòng ban nào đã biết. */
function unknownDepartments(query: string): string[] {
  const known = new Set(DEPARTMENT_CODES.map((c) => c.toUpperCase()));
  const found = [...query.normalize("NFC").matchAll(/(?:phòng|bộ phận|bên|phong|bo phan|department)\s+([A-Z]{2,5})(?![\p{L}\p{N}])/gu)];
  return found.map((m) => m[1]).filter((code) => !known.has(code));
}

function departmentsIn(query: string, categories: string[]): string[] {
  const queryTokens = departmentTokens(query);
  const aliasCodes = aliasDepartments(expandAbbreviations(query)).map((c) => c.toLowerCase());
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

/** Phòng ban nhắc RIÊNG ngoài mã tài liệu: "biểu mẫu sop IT 13 của phòng QA" → QA. */
function departmentsBesideCode(query: string, codes: DocCode[]): string[] {
  const rest = textWithoutCodes(query, codes);
  const named = [...rest.matchAll(/(?<![a-z])(?:phong|bo phan|ben|cua|thuoc)\s+([a-z]{2,3})(?![a-z0-9])/g)]
    .map((m) => (m[1] === "prd" ? "pd" : m[1]))
    .filter((c) => DEPARTMENT_CODES.includes(c))
    .map((c) => c.toUpperCase());
  return Array.from(new Set([...named, ...aliasDepartments(rest)]));
}

// Từ đệm khi chỉ nêu loại tài liệu + phòng / mã: "các SOP hiện tại của QA", "biểu mẫu sop IT 13 của phòng QA".
// "hiện tại / hiện hành / mới nhất": kho không lưu trạng thái hiệu lực nên bỏ qua (mục 4.3 tài liệu training).
const FILLERS = words(
  "cac|nhung|cua|phong|bo phan|ben|va|voi|thuoc|hien tai|hien hanh|hien co|moi nhat|dang co|dang dung|cho|xin|toi|em|minh|xem|nhe|nha|a|di|hay|giup|tat ca|toan bo"
);

/** Câu chỉ gồm loại tài liệu + phạm vi (phòng ban, đã bỏ mã), không hỏi gì thêm: là câu liệt kê. */
function onlyTypeAndScope(foldedRest: string, extraWords: string[] = []): boolean {
  let rest = foldedRest;
  const strip = (re: RegExp) => (rest = rest.replace(new RegExp(re.source, "g"), " "));
  strip(words(DOC_NOUNS));
  for (const [, re] of DEPARTMENT_ALIASES) strip(re);
  strip(words(DEPARTMENT_CODES.join("|")));
  for (const w of extraWords) strip(words(w.toLowerCase()));
  strip(FILLERS);
  return rest.replace(/[^a-z0-9]/g, "") === "";
}

/** "các sop của qa", "sop qa", "sop của QA và QC", "sop phòng ABC" */
export function isTypeAndDepartmentOnly(query: string): boolean {
  const folded = expandAbbreviations(query);
  const unknown = unknownDepartments(query);
  const hasDepartment = mentionedDepartmentCodes(query).length > 0 || unknown.length > 0;
  return hasDepartment && words(DOC_NOUNS).test(folded) && onlyTypeAndScope(folded, unknown);
}

/** Câu cụt chỉ có tên loại tài liệu ("sop", "các biểu mẫu"): chưa biết phòng nào → hỏi lại. */
function isBareTypeQuery(folded: string): boolean {
  const rest = folded
    .replace(new RegExp(`${WORD_START}(?:${DOC_NOUNS})${WORD_END}`, "g"), " ")
    .replace(/(?<![a-z])(?:cac|nhung|cho|xin|toi|em|minh|di|nhe|nha|a|voi|oi|ad|bot)(?![a-z])/g, " ");
  return rest.replace(/[^a-z0-9]/g, "") === "" && words(DOC_NOUNS).test(folded);
}

export function isBareTypeQuestion(query: string): boolean {
  return isBareTypeQuery(expandAbbreviations(query));
}

/** Biểu mẫu / phụ lục của MỘT SOP được nêu mã: "có mấy f sop qa 13", "sopqa13 có form nào", "sop qa 13 gồm những gì". */
export function isSopScopeInventoryQuestion(query: string): boolean {
  const codes = parseDocCodes(query);
  if (codes.length === 0 || codes.some((c) => c.sub)) return false;
  const text = textWithoutCodes(query, codes);
  if (CONTENT_WORDS.test(text) || INFO_WORDS.test(text)) return false;
  const namesType = words(`${FORM_WORDS}|${APPENDIX_WORDS}`).test(text);
  const asksWhatItHas = words("gom nhung gi|co nhung gi|gom gi|co gi|gom nhung (?:file|tai lieu) nao|co nhung (?:file|tai lieu) nao").test(text);
  return (namesType && (COUNT_WORDS.test(text) || LIST_WORDS.test(text) || onlyTypeAndScope(text))) || asksWhatItHas;
}

/** "biểu mẫu FRM/QA/SOP-GEN/0013-F02 thuộc sop nào" */
export function isParentLookupQuestion(query: string): boolean {
  const codes = parseDocCodes(query);
  return codes.some((c) => c.sub) && PARENT_WORDS.test(textWithoutCodes(query, codes));
}

/** "sop qa 0013 tên là gì", "SOP IT 13 đang ở phiên bản mấy" */
export function isDocInfoQuestion(query: string): boolean {
  const codes = parseDocCodes(query);
  return codes.length > 0 && INFO_WORDS.test(textWithoutCodes(query, codes));
}

/** Có mã SOP nhưng hỏi nội dung ("liệt kê các bước của sop qa 13"): không phải đếm / liệt kê kho. */
export function isSopContentQuestion(query: string): boolean {
  const codes = parseDocCodes(query);
  return codes.length > 0 && CONTENT_WORDS.test(textWithoutCodes(query, codes));
}

export function isInventoryQuestion(query: string): boolean {
  if (isBareTypeQuestion(query)) return true;
  if (parseDocCodes(query).length > 0) return isSopScopeInventoryQuestion(query);
  if (/\d{3,}/.test(query)) return false; // mã viết kiểu khác → luồng danh mục theo mã xử lý
  if (isTypeAndDepartmentOnly(query)) return true;
  const text = expandAbbreviations(query);
  if (!COUNTED_DOCUMENTS.test(text)) return false;
  if (!COUNT_WORDS.test(text) && !LIST_WORDS.test(text)) return false;
  return !TOPIC_WORDS.test(text);
}

interface DocumentEntry {
  key: string;
  type: DocType;
  typeLabel: string; // nhóm hiển thị / đếm riêng: "SOP chính", "Biểu mẫu"... loại khác theo mã loại ("SPE-FCT")
  category: string;
  fileName: string;
  file: IndexedFile; // file đại diện (tên ngắn nhất)
  fileCount: number;
}

function collectDocuments(files: IndexedFile[]): DocumentEntry[] {
  const byKey = new Map<string, DocumentEntry>();
  for (const file of files) {
    const type = docTypeOf(file);
    const key = `${file.category}|${type}|${documentKey(file)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.fileCount++;
      // Hiển thị tên file ngắn gọn nhất trong nhóm (thường là bản gốc, không có "translation")
      if (file.fileName.length < existing.fileName.length) {
        existing.fileName = file.fileName;
        existing.file = file;
      }
    } else {
      const typeLabel = type === "other" && file.docuzen ? file.docuzen.typeCode : TYPE_LABELS[type];
      byKey.set(key, { key, type, typeLabel, category: file.category, fileName: file.fileName, file, fileCount: 1 });
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

/** Đếm theo nhóm loại, theo thứ tự SOP, biểu mẫu, phụ lục, list, rồi các loại khác theo ABC. */
function countByType(entries: DocumentEntry[]): Record<string, number> {
  const rank = (e: DocumentEntry) => TYPE_ORDER.indexOf(e.type);
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b) || a.typeLabel.localeCompare(b.typeLabel));
  return countBy(sorted, (e) => e.typeLabel);
}

/** "FRM-QA-SOP-GEN-0005-F17-02 – SELF INSPECTION CHECKLIST"; Docuzen: "FRM/QA/SOP-GEN/0005 – SELF INSPECTION · bản 10" */
function entryName(e: DocumentEntry): string {
  const m = e.file.docuzen;
  const parsed = m ? null : parseFileCode(e.fileName);
  const display = m
    ? `${m.number}${m.title ? ` – ${m.title}` : ""} · bản ${m.version}`
    : parsed && parsed.title
      ? `${parsed.code} – ${parsed.title}`
      : stripExtension(e.fileName);
  return display.length > LIST_LINE_CHARS ? `${display.slice(0, LIST_LINE_CHARS)}…` : display;
}

const numberedLines = (entries: DocumentEntry[]) =>
  entries.map((e, i) => `${i + 1}. ${entryName(e)}${e.fileCount > 1 ? ` _(${e.fileCount} file)_` : ""}`);

function renderList(entries: DocumentEntry[], groupByType: boolean, groupByCategory: boolean): string {
  const rank = (e: DocumentEntry) => TYPE_ORDER.indexOf(e.type);
  const ordered = groupByType
    ? [...entries].sort(
        (a, b) =>
          a.category.localeCompare(b.category) || rank(a) - rank(b) || a.typeLabel.localeCompare(b.typeLabel) || a.fileName.localeCompare(b.fileName)
      )
    : entries;
  const shown = ordered.slice(0, MAX_LIST_LINES);
  const lines = [`${INVENTORY_LIST_HEADING} (${shown.length}/${entries.length})**`];
  const groups = new Map<string, DocumentEntry[]>();
  for (const e of shown) {
    const group = [groupByCategory ? `Phòng ${e.category}` : "", groupByType ? e.typeLabel : ""]
      .filter(Boolean)
      .join(" · ");
    groups.set(group, [...(groups.get(group) ?? []), e]);
  }
  for (const [group, groupEntries] of groups) {
    if (group) lines.push("", `**${group}** (${groupEntries.length})`);
    lines.push("", ...numberedLines(groupEntries));
  }
  if (entries.length > shown.length) {
    lines.push("", `_Mới hiển thị ${shown.length}/${entries.length}. Hỏi theo từng phòng ban hoặc từng loại tài liệu để xem phần còn lại._`);
  }
  return `\n\n${lines.join("\n")}`;
}

export interface InventoryOptions {
  files?: IndexedFile[]; // để thử nghiệm; mặc định đọc từ Qdrant
  // Bước hiểu câu hỏi đã xác định đây là câu hỏi về kho: bỏ qua nhận diện bằng từ khóa,
  // và dùng các thông tin nó đã tách ra (trống = tự nhận diện từ câu hỏi như cũ)
  routed?: boolean;
  departments?: string[];
  docTypes?: DocType[];
  wantsList?: boolean;
  docCodes?: string[]; // mã tài liệu bước hiểu câu hỏi tách ra (kể cả mã nằm trong lịch sử)
}

async function loadFiles(options: InventoryOptions): Promise<IndexedFile[] | null> {
  try {
    const files = options.files ?? (await getCatalogFiles());
    return files.length > 0 ? files : null;
  } catch (err) {
    console.warn("Không đọc được danh mục file:", (err as Error).message);
    return null;
  }
}

/**
 * Cùng một mã viết hai kiểu (câu hỏi "sop qa 5", bước hiểu câu hỏi tách ra "FRM/QA/SOP-GEN/0005"): gộp làm một,
 * giữ phần nào cụ thể hơn.
 */
function mergeCodes(codes: DocCode[]): DocCode[] {
  const merged: DocCode[] = [];
  for (const c of codes) {
    const same = merged.find(
      (m) =>
        m.number === c.number &&
        (!m.department || !c.department || m.department === c.department) &&
        (!m.series || !c.series || m.series === c.series) &&
        (!m.sub || !c.sub || (m.sub.kind === c.sub.kind && Number(m.sub.number) === Number(c.sub.number))) &&
        (!m.typeCode || !c.typeCode || m.typeCode === c.typeCode)
    );
    if (!same) {
      merged.push({ ...c });
      continue;
    }
    same.department ??= c.department;
    same.series ??= c.series;
    same.sub ??= c.sub;
    same.typeCode ??= c.typeCode;
  }
  return merged;
}

const text = (value: string, summary: Record<string, unknown>): InventoryReply => ({ kind: "text", text: value, summary });

function askDepartment(categories: string[], type: DocType): InventoryReply {
  return text(
    `Bạn muốn xem ${TYPE_NOUNS[type]} của phòng nào? Kho hiện có tài liệu của các phòng: ${categories.join(", ")}.`,
    { hoiLai: "chua_neu_phong_ban" }
  );
}

/** Trả lời câu hỏi về kho tài liệu; null nếu không phải loại câu hỏi này (hoặc không đọc được danh mục). */
export async function inventoryReplyFor(query: string, options: InventoryOptions = {}): Promise<InventoryReply | null> {
  if (!options.routed && !isInventoryQuestion(query)) return null;
  const files = await loadFiles(options);
  if (!files) return null;

  const folded = expandAbbreviations(query);
  const categories = Array.from(new Set(files.map((f) => f.category))).sort();
  const typesNamed = TYPE_WORDS.filter(([, re]) => re.test(folded)).map(([type]) => type);

  if (isBareTypeQuery(folded)) return askDepartment(categories, typesNamed[0] ?? "sop");

  const codeSource = [query, ...(options.docCodes ?? [])].join(" ; ");
  const codes = mergeCodes(parseDocCodes(codeSource));
  if (codes.length > 0) return sopScopeReply(codeSource, codes, files, options, typesNamed);

  return departmentReply(query, files, categories, options, typesNamed);
}

// Họ mã loại trùng chữ tiếng Việt thường gặp (gặp, sát / sắt, ...): chỉ nhận khi ghi đủ mã ("GAP-..." không có)
const AMBIGUOUS_TYPE_FAMILIES = new Set(["gap", "sat", "fat", "sop", "l"]);

/**
 * Mã loại tài liệu Docuzen nêu trong câu (câu đã fold): mã đầy đủ ("spe-fct", "sop cal") hoặc cả họ ("spe" →
 * SPE-API, SPE-FCT...). Biểu mẫu / phụ lục / list đã có từ riêng nên không xét ở đây.
 */
function namedTypeCodes(folded: string, files: IndexedFile[]): Set<string> {
  const codes = Array.from(new Set(files.map((f) => f.docuzen?.typeCode).filter((c): c is string => !!c)));
  const named = new Set<string>();
  for (const code of codes) {
    if (["formats", "annexures", "l"].includes(code.toLowerCase())) continue;
    const parts = code.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (parts.length === 1 && AMBIGUOUS_TYPE_FAMILIES.has(parts[0])) continue;
    if (parts.length > 0 && words(parts.join("[\\s._-]*")).test(folded)) named.add(code);
  }
  // Họ mã chỉ xét khi câu không nêu mã đầy đủ nào của họ đó ("spe-fct" thì chỉ SPE-FCT, "spe" thì cả họ)
  const exactFamilies = new Set([...named].map((n) => n.toLowerCase().split("-")[0]));
  for (const code of codes) {
    const family = code.toLowerCase().split("-")[0];
    if (!code.includes("-") || family.length < 2 || AMBIGUOUS_TYPE_FAMILIES.has(family) || exactFamilies.has(family)) continue;
    if (words(family).test(folded)) named.add(code);
  }
  return named;
}

// ---------- Theo phòng ban: "QA có bao nhiêu SOP", "liệt kê biểu mẫu của IT" ----------

function departmentReply(
  query: string,
  files: IndexedFile[],
  categories: string[],
  options: InventoryOptions,
  typesNamed: DocType[]
): InventoryReply {
  const folded = expandAbbreviations(query);
  // Câu nêu rõ loại thì theo câu, không theo model. Không cộng gộp các loại. "tài liệu" chung chung → cả ba, đếm riêng.
  const namedSpecific = typesNamed.includes("form") || typesNamed.includes("appendix")
    ? typesNamed.filter((t) => t !== "sop")
    : typesNamed;
  // Mã loại cụ thể của Docuzen ("có bao nhiêu SPE của QC", "BMR của FD", "SOP-CAL của QC")
  const typeCodes = namedTypeCodes(folded, files);
  const types: DocType[] =
    typeCodes.size > 0
      ? typesIn(files.filter((f) => f.docuzen && typeCodes.has(f.docuzen.typeCode)))
      : namedSpecific.length > 0
        ? namedSpecific
        : words(ALL_WORDS).test(folded)
          ? typesIn(files)
          : options.docTypes?.length
            ? options.docTypes
            : ["sop"];
  // Phòng model tách ra + phòng ghi rõ trong câu ("sop của QA và QC": model đôi khi bỏ sót một phòng)
  const routedDepartments = (options.departments ?? []).filter((d) => categories.includes(d));
  const departments = Array.from(new Set([...routedDepartments, ...departmentsIn(query, categories)])).sort();
  // Phòng được nhắc nhưng không có trong kho ("phòng HR", "phòng ABC"): báo riêng, không đếm nhầm sang cả công ty
  const inCatalog = new Set(categories.map((c) => c.toUpperCase()));
  const missingDepartments = Array.from(new Set([...mentionedDepartmentCodes(query), ...unknownDepartments(query)])).filter(
    (d) => !inCatalog.has(d) && !departments.some((found) => found.toUpperCase() === d)
  );
  const onlyMissing = departments.length === 0 && missingDepartments.length > 0;

  const inScope = files.filter((f) => !onlyMissing && (departments.length === 0 || departments.includes(f.category)));
  const entries = collectDocuments(inScope).filter((e) =>
    typeCodes.size > 0 ? !!e.file.docuzen && typeCodes.has(e.file.docuzen.typeCode) : types.includes(e.type)
  );
  // Nhóm đếm riêng: SOP, biểu mẫu, phụ lục, list; loại khác của Docuzen theo từng mã loại (SPE-FCT, BMR-TAB...)
  const labels = Array.from(new Set(entries.map((e) => e.typeLabel)));
  // "tài liệu" chung chung: chỉ nêu các loại phạm vi này có (không in "0 list" cho phòng không có list nào)
  const askedAll = typeCodes.size === 0 && namedSpecific.length === 0 && words(ALL_WORDS).test(folded);
  const shownTypes = askedAll ? types.filter((t) => entries.some((e) => e.type === t)) : types;
  const typeNames = typeCodes.size > 0 ? [...typeCodes].sort() : shownTypes.map((t) => TYPE_LABELS[t]);
  const fromDocuzen = files.some((f) => f.docuzen);
  // Câu đếm chỉ trả số; liệt kê khi người dùng yêu cầu. Câu không có từ đếm ("các sop của qa", "sop qa") là liệt kê.
  const wantsList = options.wantsList === true || LIST_WORDS.test(folded) || !COUNT_WORDS.test(folded);

  const summary = {
    phamVi:
      departments.length > 0
        ? `phòng ${departments.join(", ")}`
        : onlyMissing
          ? `phòng ${missingDepartments.join(", ")}`
          : "tất cả phòng ban",
    phongBanKhongCoTrongKho: missingDepartments.length > 0 ? missingDepartments : undefined,
    phongBanCoTrongKho: missingDepartments.length > 0 ? categories : undefined,
    loaiTaiLieu: typeNames.join(", "),
    tongSo: entries.length,
    soFile: entries.reduce((sum, e) => sum + e.fileCount, 0),
    theoPhongBan: departments.length === 1 || onlyMissing ? undefined : countBy(entries, (e) => e.category),
    theoLoai: labels.length > 1 || types.length > 1 ? countByType(entries) : undefined,
    cachDem: fromDocuzen
      ? "Theo danh mục chính thức của Docuzen, chỉ tính phiên bản đang hiệu lực; mỗi số tài liệu tính là 1. Các loại đếm riêng, không cộng gộp."
      : "Mỗi mã tài liệu tính là 1 (nhiều file cùng mã như bản dịch, bản PDF và Word chỉ tính 1). " +
        "SOP chính = file không có ký hiệu F (biểu mẫu) hay A (phụ lục) trong mã. Các loại đếm riêng, không cộng gộp.",
    danhSachBenDuoi: wantsList,
  };

  // Câu mở đầu dựng sẵn khi LLM lỗi. Các loại nêu riêng từng con số, không cộng gộp.
  const counts =
    typeCodes.size > 0 || labels.length > shownTypes.length
      ? Object.entries(countByType(entries)).map(([label, n]) => `**${n}** ${label}`).join(", ") || "**0** tài liệu"
      : shownTypes.map((t) => `**${entries.filter((e) => e.type === t).length}** ${TYPE_NOUNS[t]}`).join(", ") || "**0** tài liệu";
  const missingNote =
    missingDepartments.length > 0
      ? `Kho tài liệu trợ lý đang có không có tài liệu của phòng ${missingDepartments.join(", ")}. Các phòng hiện có: ${categories.join(", ")}.`
      : "";
  const fallbackIntro = onlyMissing
    ? missingNote
    : `Theo danh mục tài liệu trợ lý đang có, ${summary.phamVi} có ${counts}.` +
      (missingNote ? ` ${missingNote}` : "") +
      (wantsList || entries.length === 0 ? "" : " Bạn có muốn xem danh sách không?");
  return {
    kind: "list",
    summaryJson: JSON.stringify(summary, null, 1),
    list: {
      markdown: wantsList && entries.length > 0 ? renderList(entries, labels.length > 1, departments.length !== 1) : "",
      fallbackIntro,
    },
  };
}

// ---------- Theo một SOP: biểu mẫu / phụ lục của SOP được nêu mã ----------

interface SopGroup {
  label: string; // "SOP QA 0013"
  department: string;
  number: string;
  main: DocumentEntry | null; // file SOP chính (null nếu kho chỉ có biểu mẫu / phụ lục)
  forms: DocumentEntry[];
  appendices: DocumentEntry[];
}

const compactCode = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const vnDate = (iso: string) => iso.split("-").reverse().join("/"); // "2026-09-29" → "29/09/2026"
const today = () => new Date().toISOString().slice(0, 10);

/** Tài liệu Docuzen có khớp mã người dùng hỏi không (chỉ xét tài liệu chính, không xét biểu mẫu / phụ lục). */
function docuzenParentMatches(file: IndexedFile, code: DocCode): boolean {
  const m = file.docuzen;
  if (!m || m.group === "form" || m.group === "appendix" || m.serial !== code.number) return false;
  if (code.department && file.category.toUpperCase() !== code.department) return false;
  if (code.typeCode) {
    // "FRM/QC/SPE-FCT/0008" → đúng loại SPE-FCT; "list pd 1" → loại L
    return compactCode(m.typeCode) === compactCode(code.typeCode);
  }
  // Mã SOP ("sop qa 13", "FRM/QA/SOP-GEN/0013"): chỉ các loại SOP-..., đúng nhóm nếu có nêu
  return m.group === "sop" && (!code.series || m.typeCode.toUpperCase() === `SOP-${code.series}`);
}

/** Danh mục Docuzen: tài liệu mẹ khớp mã + biểu mẫu / phụ lục trỏ về nó (LinkedDocumentID). */
function docuzenGroupsFor(code: DocCode, files: IndexedFile[]): SopGroup[] {
  const parents = files.filter((f) => docuzenParentMatches(f, code));
  // Cùng phòng, cùng số nhưng khác nhóm (SOP-GEN 0003 và SOP-CAL 0003): ghi rõ nhóm trong tên
  const sameNumber = (f: IndexedFile) => parents.filter((p) => p.category === f.category).length > 1;
  return parents
    .map((parent) => {
      const m = parent.docuzen!;
      const children = collectDocuments(files.filter((f) => f.docuzen?.parentId === m.documentId));
      const isSop = m.group === "sop";
      return {
        label: sopLabel({
          department: parent.category.toUpperCase(),
          series: isSop && (sameNumber(parent) || code.series) ? m.typeCode.slice(4).toUpperCase() : null,
          number: m.serial ?? code.number,
          typeCode: isSop ? null : m.typeCode,
        }),
        department: parent.category.toUpperCase(),
        number: m.serial ?? code.number,
        main: collectDocuments([parent])[0] ?? null,
        forms: children.filter((e) => e.type === "form"),
        appendices: children.filter((e) => e.type === "appendix"),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Các SOP khớp mã (một mã không nêu phòng có thể khớp nhiều phòng). */
function sopGroupsFor(code: DocCode, files: IndexedFile[]): SopGroup[] {
  if (files.some((f) => f.docuzen)) return docuzenGroupsFor(code, files);
  const byDepartment = new Map<string, IndexedFile[]>();
  for (const file of files) {
    const fileCode = parseFileCode(file.fileName);
    if (!fileCode || !fileMatchesCode(fileCode, file.category, { ...code, sub: null })) continue;
    const department = fileCode.department ?? file.category.toUpperCase();
    byDepartment.set(department, [...(byDepartment.get(department) ?? []), file]);
  }

  const groups: SopGroup[] = [];
  for (const [department, groupFiles] of byDepartment) {
    // Cùng phòng, cùng số nhưng khác nhóm (SOP-GEN 0003 và SOP-CAL 0003) là hai SOP khác nhau
    const seriesOf = (f: IndexedFile) => parseFileCode(f.fileName)?.series ?? "";
    const seriesList = Array.from(new Set(groupFiles.map(seriesOf).filter(Boolean)));
    const split = seriesList.length > 1 ? seriesList : [null];
    for (const series of split) {
      const inSeries = series === null ? groupFiles : groupFiles.filter((f) => seriesOf(f) === series || seriesOf(f) === "");
      const entries = collectDocuments(inSeries);
      groups.push({
        label: sopLabel({ department, series, number: code.number }),
        department,
        number: code.number,
        main: entries.find((e) => e.type === "sop") ?? null,
        forms: entries.filter((e) => e.type === "form"),
        appendices: entries.filter((e) => e.type === "appendix"),
      });
    }
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label));
}

/** "SOP QA 0999" không có: gợi ý SOP cùng phòng có số gần nhất và SOP cùng số ở phòng khác. */
function suggestionsFor(code: DocCode, files: IndexedFile[]): string[] {
  // Gợi ý cùng loại với mã đang hỏi: hỏi SOP thì gợi ý SOP, hỏi SPE-FCT thì gợi ý SPE-FCT
  const sameKind = (f: IndexedFile) =>
    !f.docuzen || (code.typeCode ? compactCode(f.docuzen.typeCode) === compactCode(code.typeCode) : f.docuzen.group === "sop");
  const mains = collectDocuments(files.filter((f) => docTypeOf(f) !== "form" && docTypeOf(f) !== "appendix" && sameKind(f)))
    .map((e) => ({ e, code: codeOf(e.file) }))
    .filter((x): x is { e: DocumentEntry; code: NonNullable<typeof x.code> } => !!x.code && !!x.code.number);
  const departmentOf = (x: (typeof mains)[number]) => x.code.department ?? x.e.category.toUpperCase();
  const target = Number(code.number);
  const sameDepartment = mains
    .filter((x) => !code.department || departmentOf(x) === code.department)
    .sort((a, b) => Math.abs(Number(a.code.number) - target) - Math.abs(Number(b.code.number) - target))
    .slice(0, 3);
  const sameNumber = mains.filter((x) => x.code.number === code.number && departmentOf(x) !== code.department).slice(0, 2);
  return Array.from(new Set([...sameDepartment, ...sameNumber].map((x) => entryName(x.e)))).slice(0, MAX_SUGGESTIONS);
}

function notFound(code: DocCode, files: IndexedFile[], what: string): InventoryReply {
  const suggestions = suggestionsFor(code, files);
  return text(
    `Không tìm thấy ${what} trong kho tài liệu trợ lý đang có.` +
      (suggestions.length > 0 ? `\n\nMã gần giống:\n${suggestions.map((s) => `- ${s}`).join("\n")}` : ""),
    { khongTimThay: sopLabel(code), goiY: suggestions }
  );
}

const sopTitle = (g: SopGroup) => (g.main ? `**${g.label}** (${entryName(g.main)})` : `**${g.label}**`);

/** "có 3 biểu mẫu và 1 phụ lục", "không có biểu mẫu nào" */
function countSentence(g: SopGroup, types: DocType[]): string {
  const counts = types.map((t) => ({ t, n: (t === "form" ? g.forms : g.appendices).length }));
  if (counts.every((c) => c.n === 0)) {
    return `${g.label} không có ${counts.map((c) => TYPE_NOUNS[c.t]).join(" hay ")} nào.`;
  }
  const parts = counts.map((c) => (c.n > 0 ? `**${c.n}** ${TYPE_NOUNS[c.t]}` : `không có ${TYPE_NOUNS[c.t]} nào`));
  return `${sopTitle(g)} có ${parts.join(", ")}.`;
}

function sopScopeReply(
  query: string,
  codes: DocCode[],
  files: IndexedFile[],
  options: InventoryOptions,
  typesNamed: DocType[]
): InventoryReply {
  const folded = expandAbbreviations(query);
  const code = codes[0];

  // Phòng ban nói riêng khác phòng trong mã → hỏi lại (mục 5 tài liệu training)
  const beside = departmentsBesideCode(query, parseDocCodes(query));
  if (code.department && beside.some((d) => d !== code.department)) {
    const other = beside.find((d) => d !== code.department)!;
    const asked = { ...code, department: other };
    return text(
      `Bạn hỏi ${sopLabel(code)} (mã của phòng ${code.department}) nhưng lại nhắc phòng ${other}. ` +
        `Bạn muốn xem của ${sopLabel(code)} hay ${sopLabel(asked)}?`,
      { hoiLai: "phong_ban_mau_thuan_voi_ma", ma: sopLabel(code), phongBanNhacRieng: other }
    );
  }
  if (!code.department && beside.length > 1) {
    return text(`Bạn muốn xem SOP số ${code.number} của phòng nào: ${beside.join(" hay ")}?`, { hoiLai: "nhieu_phong_ban" });
  }
  const resolved: DocCode = !code.department && beside.length === 1 ? { ...code, department: beside[0] } : code;

  // SOP + biểu mẫu → biểu mẫu của SOP đó; SOP + phụ lục → phụ lục; không nói loại → cả hai, tách 2 nhóm
  const routedTypes = (options.docTypes ?? []).filter((t) => t !== "sop");
  const namedTypes = typesNamed.filter((t) => t !== "sop");
  const types: DocType[] = namedTypes.length > 0 ? namedTypes : routedTypes.length > 0 ? routedTypes : ["form", "appendix"];

  const groups = sopGroupsFor(resolved, files);
  if (groups.length === 0) return notFound(resolved, files, sopLabel(resolved));

  const wantsList = options.wantsList === true || LIST_WORDS.test(folded) || !COUNT_WORDS.test(folded);
  const summary = {
    ma: groups.map((g) => g.label),
    loaiTaiLieu: types.map((t) => TYPE_LABELS[t]),
    theoSop: Object.fromEntries(groups.map((g) => [g.label, { bieuMau: g.forms.length, phuLuc: g.appendices.length, coFileSopChinh: !!g.main }])),
    danhSach: wantsList,
  };

  const blocks: string[] = [];
  for (const g of groups) {
    const lines = [countSentence(g, types)];
    if (!g.main) lines.push("_(Kho chưa có file SOP chính của mã này, chỉ có biểu mẫu / phụ lục.)_");
    if (wantsList) {
      for (const t of types) {
        const entries = t === "form" ? g.forms : g.appendices;
        if (entries.length === 0) continue;
        lines.push("", types.length > 1 ? `**${TYPE_LABELS[t]}** (${entries.length})` : "", ...numberedLines(entries));
      }
    }
    blocks.push(lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n"));
  }
  if (codes.length > 1) {
    blocks.push(`_Câu hỏi có nhiều mã tài liệu; trên đây là ${sopLabel(code)}. Hỏi riêng từng mã để xem các mã còn lại._`);
  }
  const hasAny = groups.some((g) => types.some((t) => (t === "form" ? g.forms : g.appendices).length > 0));
  if (!wantsList && hasAny) blocks.push("Bạn có muốn xem danh sách không?");
  return text(blocks.join("\n\n"), summary);
}

// ---------- Tra một tài liệu: thuộc SOP nào, tên, phiên bản ----------

/**
 * "biểu mẫu FRM/QA/SOP-GEN/0013-F02 thuộc sop nào" → SOP mẹ.
 * "sop qa 0013 tên là gì", "SOP IT 13 đang ở phiên bản mấy" → thông tin có trong danh mục.
 * null nếu câu hỏi không có mã (để luồng tìm kiếm thường xử lý).
 */
export async function docLookupReplyFor(query: string, options: InventoryOptions = {}): Promise<InventoryReply | null> {
  const codeSource = [query, ...(options.docCodes ?? [])].join(" ; ");
  const codes = mergeCodes(parseDocCodes(codeSource));
  if (codes.length === 0) return null;
  const files = await loadFiles(options);
  if (!files) return null;

  const code = codes.find((c) => c.sub) ?? codes[0];
  const groups = sopGroupsFor(code, files);

  if (code.sub) {
    const subLabel = `${code.sub.kind === "form" ? "F" : "A"}${code.sub.number}`;
    const noun = TYPE_NOUNS[code.sub.kind];
    if (groups.length === 0) return notFound(code, files, `${noun} ${subLabel} của ${sopLabel(code)}`);
    const lines: string[] = [];
    for (const g of groups) {
      const pool = code.sub.kind === "form" ? g.forms : g.appendices;
      const match = pool.find((e) => Number(codeOf(e.file)?.sub?.number) === Number(code.sub!.number));
      const parent = g.main ? `**${g.label}** – ${entryName(g.main)}` : `**${g.label}** (kho chưa có file SOP chính)`;
      if (match) {
        lines.push(`${noun[0].toUpperCase()}${noun.slice(1)} ${entryName(match)} thuộc ${parent}.`);
      } else {
        const others = pool.map((e) => codeOf(e.file)?.sub).filter(Boolean).map((s) => `${s!.kind === "form" ? "F" : "A"}${s!.number}`);
        lines.push(
          `Không tìm thấy ${noun} ${subLabel} trong kho. Theo mã thì ${noun} này thuộc ${parent}.` +
            (others.length > 0 ? ` SOP này hiện có các ${noun}: ${others.join(", ")}.` : ` SOP này không có ${noun} nào trong kho.`)
        );
      }
    }
    return text(lines.join("\n\n"), { traNguoc: `${sopLabel(code)} ${subLabel}`, sop: groups.map((g) => g.label) });
  }

  if (groups.length === 0) return notFound(code, files, sopLabel(code));
  const folded = expandAbbreviations(query);
  const lines = groups.map((g) => {
    const m = g.main?.file.docuzen;
    const head = g.main
      ? `**${g.label}** (phòng ${g.main.category}): ${entryName(g.main)}${g.main.fileCount > 1 ? ` _(${g.main.fileCount} file)_` : ""}.`
      : `**${g.label}**: kho chưa có file SOP chính, chỉ có biểu mẫu / phụ lục.`;
    // Docuzen có phiên bản và ngày hiệu lực của bản đang hiệu lực
    const version = m
      ? ` Phiên bản ${m.version} đang hiệu lực` +
        (m.effectiveDate ? ` từ ${vnDate(m.effectiveDate)}` : "") +
        (m.expirationDate ? `, hạn rà soát ${vnDate(m.expirationDate)}${m.expirationDate < today() ? " (đã quá hạn)" : ""}` : "") +
        "."
      : "";
    return `${head}${version} Có ${g.forms.length} biểu mẫu, ${g.appendices.length} phụ lục.`;
  });
  const hasVersionInfo = groups.some((g) => g.main?.file.docuzen);
  if (VERSION_WORDS.test(folded) && !hasVersionInfo) {
    lines.push(
      "Kho tài liệu chưa lưu phiên bản, ngày ban hành hay trạng thái hiệu lực của tài liệu, nên tôi không trả lời được phần này. Bạn kiểm tra trên bản gốc hoặc danh mục tài liệu của phòng nhé."
    );
  }
  return text(lines.join("\n\n"), { thongTin: groups.map((g) => g.label) });
}

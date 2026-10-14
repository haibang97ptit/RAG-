import { config } from "./config.js";
import { getIndexedFiles, isMainDocument, matchFileGroupsByCode, stripExtension } from "./fileCatalog.js";
import { callRouter, type ChatMessage } from "./llmService.js";
import { getQualzenPool } from "./qualzenDb.js";
import {
  COMPACT_TEXT_CHARS,
  DEFAULT_LIST_LIMIT,
  DEPT_CODES,
  FULL_LIST_LIMIT,
  formatDate,
  getActionItemDetail,
  getCapaDetail,
  getCcnDetail,
  listCcnStatuses,
  searchActionItems,
  searchCapas,
  searchCcns,
  type ActionItemStatus,
  type DateField,
} from "./qualzenQueries.js";

/**
 * Trả lời câu hỏi về hồ sơ QualZen (Action Item, CCN, CAPA):
 *   câu hỏi → kế hoạch truy vấn (module + bộ lọc) → chạy truy vấn cố định → dữ liệu cho LLM diễn đạt.
 * LLM không viết SQL; nó chỉ điền các bộ lọc đã định nghĩa sẵn trong qualzenQueries.ts.
 */

type Module = "action_item" | "ccn" | "capa";

export interface QualzenPlan {
  module: Module;
  number: string | null;
  sourceNumber: string | null;
  sourceType: "CCN" | "CAPA" | null;
  department: string | null;
  status: ActionItemStatus | null;
  person: string | null;
  keyword: string | null;
  fromDate: string | null;
  toDate: string | null;
  dateField: DateField | null;
  listAll: boolean;
  // Phiếu có nội dung nhắc tới các tài liệu này (vd CCN đề xuất sửa SOP nào)
  relatedDocuments: string[];
  relatedDocPatterns: string[];
  // CCN: chỉ lấy / bỏ các trạng thái này (tên đúng như trong hệ thống)
  ccnStatusIn: string[];
  ccnStatusNotIn: string[];
}

// Mã phiếu đầy đủ: AI/FRM/QC/2026/1139, PCC/FRM/IT/2026/009, CAPA/FRM/QC/2026/136
const FULL_CODE: [Module, RegExp][] = [
  ["action_item", /(?<![A-Za-z])AI(?:\/[A-Za-z0-9]+){3,}/i],
  ["capa", /(?<![A-Za-z])CAPA(?:\/[A-Za-z0-9]+){3,}/i],
  ["ccn", /(?<![A-Za-z])(?:DFT\/)?PCC(?:\/[A-Za-z0-9]+){3,}/i],
];

// Từ khóa gợi ý câu hỏi có thể về hồ sơ QualZen. Chỉ là bước lọc sơ bộ để khỏi gọi LLM cho mọi câu:
// câu hỏi về QUY TRÌNH (SOP) cũng chứa các từ này, bước lập kế hoạch sẽ phân biệt.
const QUALZEN_HINT =
  /(?<![\p{L}\p{N}])(?:action\s*items?|action\s*plans?|ai\s*\d{1,5}|ccn|pcc|change\s*controls?|mã\s*change|change|capa|qualzen)(?![\p{L}\p{N}])/iu;

export function looksLikeQualzenQuestion(text: string): boolean {
  const normalized = text.normalize("NFC");
  return FULL_CODE.some(([, re]) => re.test(normalized)) || QUALZEN_HINT.test(normalized);
}

// ============== Mã tài liệu (SOP) được nhắc trong câu hỏi ==============

// Mã viết liền bằng dấu phân cách, cho phép 1 khoảng trắng trước số: "FRM/IT/SOP-GEN 0016", "P.IT.1016"
const TIGHT_DOC_CODE =
  /(?<![\p{L}\p{N}])[A-Za-z]{1,6}(?:[\/.\-_][A-Za-z0-9]{1,8}){1,7}(?:[ \/.\-_]+\d{3,6})?(?![\p{L}\p{N}])/gu;
// Gọi tắt: "SOP IT 0006", "SOP 0006"
const LOOSE_SOP_CODE = /(?<![\p{L}\p{N}])sop\s+(?:([A-Za-z]{2,3})\s+)?(\d{3,6})(?![\p{L}\p{N}])/giu;
// Mã của chính phiếu QualZen, không phải mã tài liệu
const RECORD_CODE_PREFIX = /^(AI|PCC|DFT|CAPA|DR|LIR|OOS)(?![A-Za-z])/i;

// Mã chép từ Word / QualZen hay mang ký tự "trông giống": gạch nối không ngắt (U+2011), gạch dài,
// khoảng trắng không ngắt, ký tự vô hình. Đưa hết về dạng ASCII trước khi nhận diện mã.
const cleanCodeText = (text: string) =>
  text
    .normalize("NFC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\p{Pd}\u2212]/gu, "-")
    .replace(/[\u2044\u2215\uFF0F]/g, "/")
    .replace(/\p{Zs}/gu, " ");

const squashCode = (text: string) => (text.match(/[A-Za-z0-9]+/g) || []).join("").toUpperCase();

export interface DocumentRef {
  label: string; // như người dùng viết
  patterns: string[]; // mẫu LIKE trên chuỗi đã bỏ dấu phân cách
}

/** Tìm các mã tài liệu trong câu hỏi và đổi thành mẫu tìm kiếm không phụ thuộc cách viết mã. */
export async function extractDocumentRefs(query: string): Promise<DocumentRef[]> {
  const text = cleanCodeText(query);
  const refs: DocumentRef[] = [];
  const covered: [number, number][] = [];

  for (const match of text.matchAll(TIGHT_DOC_CODE)) {
    const code = match[0];
    if (RECORD_CODE_PREFIX.test(code) || !/\d{3,}/.test(code)) continue;
    covered.push([match.index!, match.index! + code.length]);
    refs.push({ label: code.trim(), patterns: [`%${squashCode(code)}%`] });
  }

  for (const match of text.matchAll(LOOSE_SOP_CODE)) {
    const start = match.index!;
    if (covered.some(([a, b]) => start < b && start + match[0].length > a)) continue;
    const dept = match[1]?.toUpperCase();
    const number = match[2];
    const patterns: string[] = [];

    // Nếu SOP này có trong kho tài liệu thì lấy mã đầy đủ từ tên file
    try {
      const groups = matchFileGroupsByCode(`sop ${dept ?? ""} ${number}`, await getIndexedFiles(), config.defaultCategory);
      for (const file of (groups[0] ?? []).filter((f) => isMainDocument(f.fileName)).slice(0, 3)) {
        const segment = stripExtension(file.fileName).split(/\s+/).find((s) => s.includes(number));
        if (segment) patterns.push(`%${squashCode(segment.slice(0, segment.indexOf(number) + number.length))}%`);
      }
    } catch {
      // không tra được danh mục thì dùng mẫu dự phòng bên dưới
    }
    // Dự phòng theo cách đặt mã của công ty: FRM/<phòng>/SOP-<loại 3 chữ>/<số> và P.<phòng>.<số>
    if (dept) {
      patterns.push(`%${dept}SOP[A-Z][A-Z][A-Z]${number}%`, `%P${dept}${number}%`);
      // Mã kiểu cũ đánh số từ 1000: trong dữ liệu, "P.IT.1001" và "FRM/IT/SOP-GEN/0001" là cùng một SOP
      if (/^0\d{3}$/.test(number)) patterns.push(`%P${dept}1${number.slice(1)}%`);
    } else {
      patterns.push(`%SOP[A-Z][A-Z][A-Z]${number}%`);
    }

    refs.push({ label: match[0].trim(), patterns: Array.from(new Set(patterns)) });
  }
  return refs;
}

// "tìm các CCN liên quan đến sửa SOP X": loại phiếu + ý "liên quan / sửa / thay đổi" + mã tài liệu
const RELATED_WORDS =
  /(?<![\p{L}\p{N}])(liên quan|sửa|sửa đổi|chỉnh sửa|thay đổi|cập nhật|đề xuất|đề cập|nhắc tới|nhắc đến|ảnh hưởng|revise|revised|revision|update|updated|related)(?![\p{L}\p{N}])/iu;
// Dấu hiệu đang hỏi CÁCH LÀM / nội dung quy trình ("quy trình change control theo SOP X gồm mấy bước"):
// khi đó không tự định tuyến, để bước lập kế hoạch bằng LLM phân biệt.
const PROCEDURE_QUESTION_WORDS =
  /(?<![\p{L}\p{N}])(quy trình|quy định|hướng dẫn|các bước|mấy bước|bước nào|thế nào|như thế nào|là gì|cách|how|procedure|steps?)(?![\p{L}\p{N}])/iu;
const ACTION_ITEM_WORDS = /(?<![\p{L}\p{N}])action\s*(items?|plans?)(?![\p{L}\p{N}])/iu;
const CAPA_WORDS = /(?<![\p{L}\p{N}])capa(?![\p{L}\p{N}])/iu;
const CCN_WORDS = /(?<![\p{L}\p{N}])(ccn|pcc|change\s*controls?|change)(?![\p{L}\p{N}])/iu;

function moduleMentioned(text: string): Module | null {
  if (ACTION_ITEM_WORDS.test(text)) return "action_item";
  if (CCN_WORDS.test(text)) return "ccn";
  if (CAPA_WORDS.test(text)) return "capa";
  return null;
}

const STATUSES: ActionItemStatus[] = [
  "open",
  "closed",
  "overdue",
  "pending_responsible",
  "pending_hod",
  "pending_qa",
  "draft",
];

const emptyPlan = (module: Module): QualzenPlan => ({
  module,
  number: null,
  sourceNumber: null,
  sourceType: null,
  department: null,
  status: null,
  person: null,
  keyword: null,
  fromDate: null,
  toDate: null,
  dateField: null,
  listAll: false,
  relatedDocuments: [],
  relatedDocPatterns: [],
  ccnStatusIn: [],
  ccnStatusNotIn: [],
});

const PLANNER_PROMPT = `Bạn phân tích câu hỏi cho trợ lý nội bộ của công ty dược. Có 2 nguồn trả lời:
- "sop": TÀI LIỆU quy trình (SOP, biểu mẫu, hướng dẫn). Dùng khi hỏi CÁCH LÀM, quy định, định nghĩa, nội dung tài liệu. Ví dụ: "quy trình change control gồm mấy bước", "khi nào phải mở CAPA", "biểu mẫu CAPA là gì".
- "qualzen": HỒ SƠ thực tế trong hệ thống QualZen (kể cả câu hỏi "CCN / action item nào liên quan tới, đề xuất sửa SOP X" - đó là tìm phiếu, không phải hỏi nội dung SOP). Dùng khi hỏi về phiếu cụ thể hoặc danh sách / số lượng / trạng thái / ai đang giữ / ngày tạo / hạn của Action Item, CCN (Change Control, mã PCC/...), CAPA. Ví dụ: "IT còn bao nhiêu action item quá hạn", "AI 1139 đang chờ ai duyệt", "PCC IT 009 có những action item nào".
Nếu không chắc → "sop".

Trả về DUY NHẤT một JSON, không giải thích:
{"source":"qualzen|sop","module":"action_item|ccn|capa","number":null,"source_number":null,"source_type":null,"department":null,"status":null,"person":null,"keyword":null,"from_date":null,"to_date":null,"date_field":null,"list_all":false,"ccn_status":[],"ccn_status_exclude":[]}

Ý nghĩa các trường (để null nếu câu hỏi không nhắc tới):
- module: loại phiếu người dùng muốn XEM. "action item của CCN 009" → action_item; "CCN 009 đang ở bước nào" → ccn.
- number: mã của chính loại phiếu trong module, chép đúng như người dùng viết (vd "AI 1139", "PCC IT 009", "CAPA/FRM/QC/2026/136").
- source_number + source_type: chỉ dùng khi module = action_item và người dùng muốn action item THUỘC một CCN/CAPA. source_type là "CCN" hoặc "CAPA".
- department: MÃ phòng ban: QA (Quality Assurance), QC (Quality Control), PD (Production/sản xuất), WH (Warehouse/kho), ME (Mechanical and Electrical/cơ điện), IT, HR (nhân sự hành chính), RA (Regulatory Affairs/đăng ký), FD (Formulation Development), AD (Analytical Development), DS (Design), PU (Plan - Supply chain/kế hoạch cung ứng), TS (Technical Service).
- status (chỉ cho action_item): open (chưa đóng), closed (đã đóng), overdue (quá hạn), pending_responsible (chờ người phụ trách thực hiện), pending_hod (chờ trưởng bộ phận review), pending_qa (chờ QA duyệt), draft (nháp).
- person: tên người phụ trách (action item) hoặc người khởi tạo (CCN).
- keyword: CHỈ khi người dùng muốn tìm theo nội dung; 1-3 từ lấy nguyên từ câu hỏi. Không đưa các từ chung như "action item", "CCN", "phiếu".
- from_date, to_date: khoảng ngày, định dạng YYYY-MM-DD, tính từ ngày hôm nay được cho bên dưới. Một ngày cụ thể → from_date = to_date. "tháng 9" → từ ngày 01 đến ngày cuối tháng 9 của năm nay.
- date_field: khoảng ngày trên áp vào ngày nào: "created" (ngày tạo - mặc định), "target" (hạn hoàn thành, vd "đến hạn trong tuần này", "hạn trước 20/10"), "closed" (ngày đóng, vd "đã đóng trong tháng 9"). target/closed chỉ dùng cho action_item.
- list_all: true khi người dùng muốn xem HẾT danh sách ("liệt kê hết", "tất cả", "toàn bộ", "đầy đủ", "xem tiếp phần còn lại"). Mặc định false.
- ccn_status, ccn_status_exclude (chỉ cho ccn): lọc theo trạng thái CCN. ccn_status = CHỈ lấy các trạng thái này; ccn_status_exclude = lấy tất cả TRỪ các trạng thái này ("trừ", "bỏ", "không tính", "ngoại trừ"). Chép ĐÚNG tên trong danh sách "Trạng thái CCN có trong hệ thống" được cho bên dưới; một ý của người dùng có thể ứng với nhiều trạng thái (vd "đã đóng" → các trạng thái Closed; "nháp" → các trạng thái Draft). Không nhắc tới trạng thái → để [].`;

/** Giữ các tên trạng thái LLM chọn có thật trong hệ thống (không phân biệt hoa thường, khoảng trắng). */
function pickStatuses(value: unknown, known: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map(known.map((name) => [name.toLowerCase().replace(/\s+/g, " ").trim(), name]));
  const picked = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => byKey.get(v.toLowerCase().replace(/\s+/g, " ").trim()))
    .filter((v): v is string => !!v);
  return Array.from(new Set(picked));
}

// Danh sách trạng thái CCN ít khi đổi: đọc một lần mỗi 30 phút
const STATUS_CACHE_MS = 30 * 60 * 1000;
let ccnStatusCache: { names: string[]; at: number } | null = null;

async function getCcnStatuses(): Promise<string[]> {
  if (ccnStatusCache && Date.now() - ccnStatusCache.at < STATUS_CACHE_MS) return ccnStatusCache.names;
  try {
    ccnStatusCache = { names: await listCcnStatuses(await getQualzenPool()), at: Date.now() };
    return ccnStatusCache.names;
  } catch (err) {
    console.warn("Không đọc được danh sách trạng thái CCN:", (err as Error).message);
    return ccnStatusCache?.names ?? [];
  }
}

function parsePlan(raw: string, ccnStatuses: string[]): QualzenPlan | "sop" | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let json: any;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (json.source !== "qualzen") return "sop";
  if (!["action_item", "ccn", "capa"].includes(json.module)) return null;

  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null);
  const date = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const department = text(json.department)?.toUpperCase() ?? null;
  const dateField = ["created", "target", "closed"].includes(json.date_field) ? (json.date_field as DateField) : null;
  const sourceType = text(json.source_type)?.toUpperCase() ?? null;

  return {
    module: json.module,
    number: text(json.number),
    sourceNumber: text(json.source_number),
    sourceType: sourceType === "CCN" || sourceType === "CAPA" ? sourceType : null,
    department: department && DEPT_CODES.includes(department) ? department : null,
    status: STATUSES.includes(json.status) ? json.status : null,
    person: text(json.person),
    keyword: text(json.keyword),
    fromDate: date(json.from_date),
    toDate: date(json.to_date),
    dateField,
    listAll: json.list_all === true,
    relatedDocuments: [],
    relatedDocPatterns: [],
    ccnStatusIn: pickStatuses(json.ccn_status, ccnStatuses),
    ccnStatusNotIn: pickStatuses(json.ccn_status_exclude, ccnStatuses),
  };
}

async function planQuery(query: string, history: ChatMessage[], routed = false): Promise<QualzenPlan | null> {
  // Có mã đầy đủ thì không cần LLM: tra thẳng phiếu đó
  const normalized = cleanCodeText(query);
  const codes = FULL_CODE.map(([module, re]) => ({ module, match: normalized.match(re) })).filter((c) => c.match);
  if (codes.length === 1) {
    return { ...emptyPlan(codes[0].module), number: codes[0].match![0] };
  }

  // "CCN / action item nào liên quan tới SOP X": đủ rõ để tra thẳng, không phụ thuộc LLM
  const docRefs = await extractDocumentRefs(normalized);
  const mentioned = moduleMentioned(normalized);
  if (
    codes.length === 0 &&
    mentioned &&
    docRefs.length > 0 &&
    RELATED_WORDS.test(normalized) &&
    !PROCEDURE_QUESTION_WORDS.test(normalized)
  ) {
    return {
      ...emptyPlan(mentioned),
      relatedDocuments: docRefs.map((r) => r.label),
      relatedDocPatterns: docRefs.flatMap((r) => r.patterns),
    };
  }

  const historyText = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 300)}`)
    .join("\n");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

  const ccnStatuses = await getCcnStatuses();
  const statusHint = ccnStatuses.length > 0 ? `\n\nTrạng thái CCN có trong hệ thống: ${ccnStatuses.join(" | ")}` : "";

  // Bước hiểu câu hỏi đã xác định là hỏi hồ sơ: nói rõ để bước lập kế hoạch không chọn lại "sop"
  const routedHint = routed ? `\n\nGhi chú: câu hỏi này đã được xác định là hỏi về HỒ SƠ trong QualZen → "source" là "qualzen".` : "";
  const raw = await callRouter(
    PLANNER_PROMPT,
    `Hôm nay: ${today}${statusHint}${routedHint}\n\nLịch sử hội thoại:\n${historyText || "(chưa có)"}\n\nCâu hỏi mới: "${query}"\n\nJSON:`
  );
  const plan = parsePlan(raw, ccnStatuses);
  if (plan === "sop" || plan === null) return null;
  // LLM chọn QualZen và câu hỏi có nhắc mã tài liệu (không phải mã của chính phiếu) → lọc theo tài liệu đó
  if (docRefs.length > 0) {
    // LLM hay chép mã tài liệu vào number / keyword; để nguyên thì thành tìm lỏng theo "0039"
    // và ra cả phiếu của SOP phòng khác có cùng số
    const docCodes = docRefs.map((r) => squashCode(r.label));
    const isDocCode = (value: string | null) => {
      const squashed = value ? squashCode(value) : "";
      return squashed.length >= 3 && docCodes.some((code) => code.includes(squashed) || squashed.includes(code));
    };
    if (isDocCode(plan.number)) plan.number = null;
    if (isDocCode(plan.keyword)) plan.keyword = null;
    if (!plan.number) {
      plan.relatedDocuments = docRefs.map((r) => r.label);
      plan.relatedDocPatterns = docRefs.flatMap((r) => r.patterns);
    }
  }
  return plan;
}

// Bộ lọc đã áp dụng, để LLM nhắc lại khi không tìm thấy gì
function describeFilters(plan: QualzenPlan): Record<string, string> {
  const filters: Record<string, string> = {};
  if (plan.number) filters.maPhieu = plan.number;
  if (plan.sourceNumber) filters.thuocSuKien = `${plan.sourceType ?? "CCN/CAPA"} ${plan.sourceNumber}`;
  else if (plan.sourceType) filters.loaiSuKienGoc = plan.sourceType;
  if (plan.department) filters.phongBan = plan.department;
  if (plan.status) filters.trangThai = plan.status;
  if (plan.person) filters.nguoi = plan.person;
  if (plan.keyword) filters.tuKhoa = plan.keyword;
  if (plan.relatedDocuments.length > 0) {
    filters.noiDungCoNhacToiTaiLieu = plan.relatedDocuments.join(" hoặc ");
  }
  const dateLabel = { created: "ngày tạo", target: "hạn hoàn thành", closed: "ngày đóng" }[plan.dateField ?? "created"];
  if (plan.fromDate || plan.toDate) {
    filters.khoangNgay = `${dateLabel} từ ${plan.fromDate ?? "…"} đến ${plan.toDate ?? "…"}`;
  }
  if (plan.ccnStatusIn.length > 0) filters.chiLayTrangThai = plan.ccnStatusIn.join(", ");
  if (plan.ccnStatusNotIn.length > 0) filters.boQuaTrangThai = plan.ccnStatusNotIn.join(", ");
  if (plan.listAll) filters.lietKeHet = `có (tối đa ${FULL_LIST_LIMIT} phiếu)`;
  return filters;
}

async function runPlan(plan: QualzenPlan): Promise<Record<string, unknown>> {
  const pool = await getQualzenPool();
  const dates = { createdFrom: plan.fromDate, createdTo: plan.toDate };
  // "Liệt kê hết": lấy nhiều phiếu hơn nhưng mỗi phiếu gọn lại
  const limit = plan.listAll ? FULL_LIST_LIMIT : DEFAULT_LIST_LIMIT;
  const textChars = plan.listAll ? COMPACT_TEXT_CHARS : undefined;

  if (plan.module === "action_item") {
    const result = await searchActionItems(pool, {
      number: plan.number,
      sourceType: plan.sourceType,
      sourceNumber: plan.sourceNumber,
      department: plan.department,
      status: plan.status,
      person: plan.person,
      keyword: plan.keyword,
      relatedDocPatterns: plan.relatedDocPatterns,
      ...dates,
      dateField: plan.dateField,
    }, limit, textChars);
    const { _rows, ...listing } = result;
    if (_rows.length === 1) {
      return { loaiPhieu: "Action Item", tongSo: 1, chiTiet: await getActionItemDetail(pool, _rows[0]) };
    }
    return { loaiPhieu: "Action Item", ...listing };
  }

  if (plan.module === "ccn") {
    const result = await searchCcns(pool, {
      number: plan.number,
      department: plan.department,
      person: plan.person,
      keyword: plan.keyword,
      relatedDocPatterns: plan.relatedDocPatterns,
      statusIn: plan.ccnStatusIn,
      statusNotIn: plan.ccnStatusNotIn,
      ...dates,
    }, limit, textChars);
    const { _rows, ...listing } = result;
    if (_rows.length === 1) {
      return { loaiPhieu: "CCN (Change Control)", tongSo: 1, chiTiet: await getCcnDetail(pool, _rows[0]) };
    }
    return { loaiPhieu: "CCN (Change Control)", ...listing };
  }

  const result = await searchCapas(
    pool,
    { number: plan.number, keyword: plan.keyword, relatedDocPatterns: plan.relatedDocPatterns, ...dates },
    limit,
    textChars
  );
  const { _rows, ...listing } = result;
  if (_rows.length === 1) {
    return { loaiPhieu: "CAPA", tongSo: 1, chiTiet: await getCapaDetail(pool, _rows[0]) };
  }
  return { loaiPhieu: "CAPA", ...listing };
}

export interface QualzenAnswerData {
  dataJson: string;
  queriedAt: string;
  plan: QualzenPlan;
  // Danh sách quá dài để đưa qua LLM: server tự in phần này ngay sau đoạn tóm tắt của LLM
  list: { markdown: string; fallbackIntro: string } | null;
}

// Mở đầu phần danh sách do server in. Server cũng dựa vào dòng này để lược danh sách khỏi lịch sử hội thoại.
export const QUALZEN_LIST_HEADING = "**Danh sách chi tiết";
const LIST_LINE_TEXT_CHARS = 140;
// Khi phải thu gọn: nội dung từng phiếu trong danh sách / các ô nội dung khác
const COMPACT_OTHER_TEXT_CHARS = 600;

const oneLine = (value: unknown, maxChars: number) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
};
const datePart = (value: unknown) => (typeof value === "string" ? value.split(" ")[0] : null);

/** Thu gọn dữ liệu: bỏ ô trống, cắt ngắn chữ (phiếu trong danh sách cắt ngắn hơn). */
function compactData(value: unknown, inList = false): unknown {
  if (Array.isArray(value)) return value.map((v) => compactData(v, true));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === "") continue;
      out[key] = compactData(v, inList);
    }
    return out;
  }
  if (typeof value === "string") return oneLine(value, inList ? COMPACT_TEXT_CHARS : COMPACT_OTHER_TEXT_CHARS);
  return value;
}

/** Một dòng cho mỗi phiếu: mã in đậm, các thông tin chính, rồi nội dung rút gọn. */
function listLine(module: Module, item: any): string {
  const parts: string[] = [`**${item.maActionItem ?? item.maCCN ?? item.maCAPA}**`];
  if (module === "action_item") {
    if (item.quaHan) parts.push("**QUÁ HẠN**");
    parts.push(item.trangThai);
    if (item.hanHoanThanh) parts.push(`hạn ${datePart(item.hanHoanThanh)}`);
    if (item.nguoiPhuTrach) parts.push(item.nguoiPhuTrach);
  } else if (module === "ccn") {
    parts.push(item.trangThai);
    if (item.ngayTao) parts.push(`tạo ${datePart(item.ngayTao)}`);
  } else {
    if (item.suKienGoc) parts.push(`sự kiện ${item.suKienGoc}`);
    if (item.ngayTao) parts.push(`tạo ${datePart(item.ngayTao)}`);
    if (item.hanHoanThanh) parts.push(`hạn ${datePart(item.hanHoanThanh)}`);
  }
  const text = item.thayDoiDeXuat ?? item.hienTrang ?? item.noiDung ?? item.moTaSuKien;
  return `- ${parts.filter(Boolean).join(" · ")}${text ? ` — ${oneLine(text, LIST_LINE_TEXT_CHARS)}` : ""}`;
}

/** In danh sách phiếu bằng markdown; nhóm theo phòng ban khi câu hỏi không lọc theo phòng ban. */
function renderList(module: Module, data: Record<string, any>, groupByDepartment: boolean): string {
  const items: any[] = data.danhSach;
  const lines = [`${QUALZEN_LIST_HEADING} (${items.length}/${data.tongSo} phiếu)**`];

  const groups = new Map<string, any[]>();
  for (const item of items) {
    const key = groupByDepartment ? (item.phongBan ?? item.phongBanThucHien ?? "Chưa rõ phòng ban") : "";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const [department, groupItems] of groups) {
    if (groupByDepartment) {
      const departmentTotal: number | undefined = data.thongKe?.theoPhongBan?.[department];
      const count =
        departmentTotal && departmentTotal > groupItems.length ? `${groupItems.length}/${departmentTotal}` : groupItems.length;
      lines.push("", `**${department}** (${count})`);
    }
    lines.push("", ...groupItems.map((item) => listLine(module, item)));
  }
  if (data.tongSo > items.length) {
    lines.push(
      "",
      `_Mới hiển thị ${items.length}/${data.tongSo} phiếu. Thu hẹp theo phòng ban, trạng thái hoặc thời gian để xem phần còn lại._`
    );
  }
  return `\n\n${lines.join("\n")}`;
}

/**
 * Trả về dữ liệu để trả lời, hoặc null nếu câu hỏi không phải về hồ sơ QualZen
 * (khi đó server trả lời bằng tài liệu SOP như bình thường).
 */
export async function answerDataForQualzen(
  query: string,
  history: ChatMessage[],
  routed = false // bước hiểu câu hỏi đã xác định là hỏi hồ sơ QualZen
): Promise<QualzenAnswerData | null> {
  const plan = await planQuery(query, history, routed);
  if (!plan) return null;

  const queriedAt = formatDate(new Date()) ?? "";
  let data: Record<string, any>;
  try {
    data = { dieuKienLoc: describeFilters(plan), ...(await runPlan(plan)) };
  } catch (err) {
    console.error("QualZen query failed:", (err as Error).message);
    data = { loi: "Không truy vấn được hệ thống QualZen lúc này." };
  }

  // Vừa giới hạn token → giữ nguyên như cũ: LLM đọc toàn bộ dữ liệu và tự trình bày
  const budget = config.qualzenPromptBudgetChars;
  const full = JSON.stringify(data, null, 1);
  if (full.length <= budget) return { dataJson: full, queriedAt, plan, list: null };

  // Quá dài: thử thu gọn (bỏ ô trống, cắt ngắn chữ) trước
  const compact = JSON.stringify(compactData(data));
  if (compact.length <= budget || !Array.isArray(data.danhSach)) {
    return { dataJson: compact, queriedAt, plan, list: null };
  }

  // Vẫn quá dài: server tự in danh sách, LLM chỉ nhận số liệu tổng hợp để viết phần tóm tắt
  const { danhSach, ...summary } = data;
  return {
    dataJson: JSON.stringify(compactData(summary), null, 1),
    queriedAt,
    plan,
    list: {
      markdown: renderList(plan.module, data, !plan.department),
      fallbackIntro: `Tìm thấy **${data.tongSo}** phiếu ${data.loaiPhieu} khớp điều kiện.`,
    },
  };
}

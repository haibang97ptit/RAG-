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
});

const PLANNER_PROMPT = `Bạn phân tích câu hỏi cho trợ lý nội bộ của công ty dược. Có 2 nguồn trả lời:
- "sop": TÀI LIỆU quy trình (SOP, biểu mẫu, hướng dẫn). Dùng khi hỏi CÁCH LÀM, quy định, định nghĩa, nội dung tài liệu. Ví dụ: "quy trình change control gồm mấy bước", "khi nào phải mở CAPA", "biểu mẫu CAPA là gì".
- "qualzen": HỒ SƠ thực tế trong hệ thống QualZen. Dùng khi hỏi về phiếu cụ thể hoặc danh sách / số lượng / trạng thái / ai đang giữ / ngày tạo / hạn của Action Item, CCN (Change Control, mã PCC/...), CAPA. Ví dụ: "IT còn bao nhiêu action item quá hạn", "AI 1139 đang chờ ai duyệt", "PCC IT 009 có những action item nào".
Nếu không chắc → "sop".

Trả về DUY NHẤT một JSON, không giải thích:
{"source":"qualzen|sop","module":"action_item|ccn|capa","number":null,"source_number":null,"source_type":null,"department":null,"status":null,"person":null,"keyword":null,"from_date":null,"to_date":null,"date_field":null,"list_all":false}

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
- list_all: true khi người dùng muốn xem HẾT danh sách ("liệt kê hết", "tất cả", "toàn bộ", "đầy đủ", "xem tiếp phần còn lại"). Mặc định false.`;

function parsePlan(raw: string): QualzenPlan | "sop" | null {
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
  };
}

async function planQuery(query: string, history: ChatMessage[]): Promise<QualzenPlan | null> {
  // Có mã đầy đủ thì không cần LLM: tra thẳng phiếu đó
  const normalized = query.normalize("NFC");
  const codes = FULL_CODE.map(([module, re]) => ({ module, match: normalized.match(re) })).filter((c) => c.match);
  if (codes.length === 1) {
    return { ...emptyPlan(codes[0].module), number: codes[0].match![0] };
  }

  const historyText = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 300)}`)
    .join("\n");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

  const raw = await callRouter(
    PLANNER_PROMPT,
    `Hôm nay: ${today}\n\nLịch sử hội thoại:\n${historyText || "(chưa có)"}\n\nCâu hỏi mới: "${query}"\n\nJSON:`
  );
  const plan = parsePlan(raw);
  return plan === "sop" ? null : plan;
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
  const dateLabel = { created: "ngày tạo", target: "hạn hoàn thành", closed: "ngày đóng" }[plan.dateField ?? "created"];
  if (plan.fromDate || plan.toDate) {
    filters.khoangNgay = `${dateLabel} từ ${plan.fromDate ?? "…"} đến ${plan.toDate ?? "…"}`;
  }
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
      ...dates,
    }, limit, textChars);
    const { _rows, ...listing } = result;
    if (_rows.length === 1) {
      return { loaiPhieu: "CCN (Change Control)", tongSo: 1, chiTiet: await getCcnDetail(pool, _rows[0]) };
    }
    return { loaiPhieu: "CCN (Change Control)", ...listing };
  }

  const result = await searchCapas(pool, { number: plan.number, keyword: plan.keyword, ...dates }, limit, textChars);
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
}

/**
 * Trả về dữ liệu để trả lời, hoặc null nếu câu hỏi không phải về hồ sơ QualZen
 * (khi đó server trả lời bằng tài liệu SOP như bình thường).
 */
export async function answerDataForQualzen(
  query: string,
  history: ChatMessage[]
): Promise<QualzenAnswerData | null> {
  const plan = await planQuery(query, history);
  if (!plan) return null;

  const queriedAt = formatDate(new Date()) ?? "";
  let data: Record<string, unknown>;
  try {
    data = { dieuKienLoc: describeFilters(plan), ...(await runPlan(plan)) };
  } catch (err) {
    console.error("QualZen query failed:", (err as Error).message);
    data = { loi: "Không truy vấn được hệ thống QualZen lúc này." };
  }

  return { dataJson: JSON.stringify(data, null, 1), queriedAt, plan };
}

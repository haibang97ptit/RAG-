import { getIndexedFiles } from "./fileCatalog.js";
import { glossaryHint, glossaryMatches } from "./glossary.js";
import { formatExamples, similarExamples } from "./routerExamples.js";
import { looksLikeQualzenQuestion } from "./qualzenAssistant.js";
import { isInventoryQuestion, type DocType } from "./docInventory.js";
import {
  callRouterStrict,
  classifyIntent,
  isCompareQuestion,
  isOverlapQuestion,
  isOverviewQuestion,
  rewriteFollowUpQuery,
  type ChatMessage,
} from "./llmService.js";

/**
 * Hiểu câu hỏi: MỘT lần gọi model router cho ra loại câu hỏi + các thông tin cần để trả lời.
 *
 * Trước đây mỗi loại câu hỏi được nhận diện bằng một bộ từ khóa riêng, nên đổi cách diễn đạt
 * một chút ("QA đang có mấy quy trình" thay cho "số lượng SOP của QA") là đi nhầm nhánh.
 * Model hiểu được cách nói khác nhau; phần thực thi phía sau (đếm, tra QualZen, tìm kiếm) vẫn
 * là code cố định. Model lỗi / hết hạn mức → quay về nhận diện bằng từ khóa như cũ.
 */

export type Task =
  | "chitchat" // chào hỏi, cảm ơn, hỏi về trợ lý
  | "sop_question" // hỏi nội dung / quy định trong tài liệu
  | "doc_overview" // tổng quan một tài liệu được nêu mã
  | "doc_inventory" // đếm / liệt kê tài liệu trong kho
  | "doc_compare" // so sánh 2+ tài liệu được nêu mã
  | "overlap_check" // rà quy định trùng lặp / chồng chéo
  | "qualzen"; // hồ sơ trong QualZen: action item, CCN, CAPA


export interface RoutedQuery {
  task: Task;
  followUp: boolean;
  standaloneQuery: string; // câu hỏi viết lại đủ ý, không phụ thuộc lịch sử
  docCodes: string[]; // mã tài liệu được nhắc (như người dùng viết)
  departments: string[]; // tên thư mục phòng ban có trong kho
  docTypes: DocType[]; // loại tài liệu cần đếm / liệt kê
  wantsList: boolean; // muốn xem danh sách (không chỉ con số)
  topic: string | null; // chủ đề quy định (rà trùng lặp theo chủ đề)
  source: "llm" | "heuristic";
}

const TASKS: Task[] = ["chitchat", "sop_question", "doc_overview", "doc_inventory", "doc_compare", "overlap_check", "qualzen"];
const DOC_TYPES: DocType[] = ["sop", "form", "appendix"];

const ROUTER_PROMPT = `Bạn phân tích câu hỏi gửi tới trợ lý nội bộ của một công ty dược. Trợ lý tra cứu kho tài liệu SOP (SOP chính, biểu mẫu F.., phụ lục A..) và hệ thống QualZen (Action Item, CCN/Change Control, CAPA).

Chọn ĐÚNG MỘT "task" theo Ý NGHĨA câu hỏi (người dùng diễn đạt rất khác nhau, đừng bám từ khóa):
- chitchat: chào hỏi, cảm ơn, khen chê, hỏi trợ lý là ai / làm được gì, nói chuyện ngoài lề.
- sop_question: hỏi NỘI DUNG / quy định / cách làm / định nghĩa / trách nhiệm trong tài liệu; tìm tài liệu nói về một chủ đề; hỏi biểu mẫu / phụ lục CỦA MỘT SOP cụ thể.
- doc_overview: muốn biết tổng quan một tài liệu được nêu mã: nội dung, tóm tắt, nói về gì, mục đích, phạm vi.
- doc_inventory: đếm hoặc liệt kê tài liệu trong kho theo phòng ban / loại tài liệu, KHÔNG gắn với chủ đề nội dung nào ("QA có bao nhiêu SOP", "kho có những biểu mẫu gì").
- doc_compare: so sánh, đối chiếu 2 tài liệu trở lên được nêu mã.
- overlap_check: rà quy định trùng lặp / chồng chéo / mâu thuẫn giữa các tài liệu; hoặc một quy định nằm rải rác ở những tài liệu nào để gom lại.
- qualzen: hỏi về HỒ SƠ / phiếu thực tế: action item, CCN, change control, PCC, CAPA (mã phiếu, danh sách, số lượng, trạng thái, ai đang giữ, hạn, phiếu liên quan tới SOP nào). Hỏi QUY TRÌNH change control / CAPA (cách làm, mấy bước, khi nào phải mở) là sop_question.

Các trường khác:
- follow_up: true nếu câu hỏi phụ thuộc lịch sử (đại từ "nó / cái đó / SOP này", "còn ... thì sao", "ngắn gọn hơn", "liệt kê tiếp").
- standalone_query: viết lại câu hỏi thành câu ĐỘC LẬP, đủ ý (thay đại từ bằng đối tượng cụ thể trong lịch sử, giữ nguyên mã). Câu chỉ đòi đổi cách trình bày → nêu lại chủ đề đang nói. Câu đã rõ → chép nguyên.
- doc_codes: các mã tài liệu được nhắc, chép như người dùng viết ("sop qa 0005", "FRM/QA/SOP-GEN/0039", "P.IT.1016"); kể cả mã nằm trong lịch sử mà câu hỏi đang nói tới. Không có → [].
- departments: phòng ban được nhắc, chỉ dùng tên trong danh sách PHÒNG BAN TRONG KHO bên dưới. Không nhắc → [].
- doc_types (cho doc_inventory): "sop" (SOP, quy trình), "form" (biểu mẫu, form, format), "appendix" (phụ lục). "tài liệu / văn bản / file" chung chung → cả ba. Không nói rõ → ["sop"].
- list: true nếu muốn xem danh sách / tên các tài liệu, false nếu chỉ hỏi số lượng.
- topic: chủ đề quy định khi task là overlap_check và người dùng nêu chủ đề (vd "đào tạo nhân viên mới"); rà chung chung → null.

Ví dụ (rút gọn):
"số lượng SOP của QA" / "QA đang có mấy quy trình" / "đếm giúp sop phòng đảm bảo chất lượng" → doc_inventory, departments ["QA"], doc_types ["sop"], list false
"phòng IT có những tài liệu gì" → doc_inventory, ["IT"], ["sop","form","appendix"], list true
"kho có bao nhiêu biểu mẫu" → doc_inventory, [], ["form"], list false
"SOP nào quy định về vệ sinh phòng sạch" / "liệt kê các sop nói về đào tạo" → sop_question
"sop qa 0005 có bao nhiêu biểu mẫu" / "biểu mẫu F07 của SOP 0005 dùng làm gì" → sop_question, doc_codes ["sop qa 0005"]
"nội dung sop it 1012" / "SOP 1012 IT nói về cái gì" / "tóm tắt giúp quy trình QA 0005" → doc_overview
"so sánh sop qa 0005 với sop qa 0017" / "0005 và 0017 khác nhau chỗ nào" → doc_compare
"sop 0005 có trùng nội dung với sop nào không" / "các sop của QA có chồng chéo nhau không" → overlap_check, topic null
"quy định đào tạo nhân viên mới đang nằm ở những sop nào" → overlap_check, topic "đào tạo nhân viên mới"
"AI 1139 đang chờ ai duyệt" / "QC còn bao nhiêu action item quá hạn" / "ccn nào sửa sop FRM/QA/SOP-GEN/0039" / "liệt kê change control năm 2026" → qualzen
"quy trình change control gồm mấy bước" / "khi nào phải mở CAPA" → sop_question
Lịch sử đang nói về số SOP của QA, hỏi "còn phòng QC thì sao" → doc_inventory, ["QC"], follow_up true
Lịch sử đang nói về SOP QA 0005, hỏi "ngắn gọn hơn" → sop_question, follow_up true, standalone_query "nội dung SOP QA 0005", doc_codes ["SOP QA 0005"]

Trả về DUY NHẤT một JSON, không giải thích:
{"task":"...","follow_up":false,"standalone_query":"...","doc_codes":[],"departments":[],"doc_types":["sop"],"list":false,"topic":null}`;

// Gồm cả phần suy luận của model (gpt-oss), không chỉ JSON trả về
const ROUTER_MAX_TOKENS = 1200;

// Lời chào / cảm ơn ngắn: khỏi gọi model
const OBVIOUS_CHITCHAT =
  /^(?:xin chào|chào|cảm ơn|cám ơn|thanks|thank you|hello|hi|bye|tạm biệt|ok|oke|okey|dạ|vâng|ừ)(?:\s+(?:bạn|anh|chị|em|ad|bot|ạ|nhé|nha|nhiều))*[\s.!,]*$/iu;

// Cùng câu hỏi (cùng ngữ cảnh) → cùng cách hiểu, kể cả khi model trả lời hơi khác giữa các lần gọi
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { route: RoutedQuery; at: number }>();

function cacheKey(query: string, history: ChatMessage[]): string {
  const context = history
    .slice(-2)
    .map((m) => `${m.role}:${m.content.slice(0, 300)}`)
    .join("|");
  return `${query.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()}||${context}`;
}

const strings = (value: unknown, max = 5): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim().slice(0, 100)).slice(0, max)
    : [];

function matchDepartments(values: string[], categories: string[]): string[] {
  const byKey = new Map(categories.map((c) => [c.toLowerCase(), c]));
  return Array.from(new Set(values.map((v) => byKey.get(v.toLowerCase())).filter((v): v is string => !!v)));
}

function parseRoute(raw: string, query: string, categories: string[]): RoutedQuery | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let json: any;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!TASKS.includes(json.task)) return null;

  const standalone = typeof json.standalone_query === "string" ? json.standalone_query.trim().slice(0, 500) : "";
  const docTypes = strings(json.doc_types).filter((t): t is DocType => DOC_TYPES.includes(t as DocType));
  return {
    task: json.task,
    followUp: json.follow_up === true,
    standaloneQuery: standalone || query,
    docCodes: strings(json.doc_codes),
    departments: matchDepartments(strings(json.departments, 13), categories),
    docTypes: docTypes.length > 0 ? docTypes : ["sop"],
    wantsList: json.list === true,
    topic: typeof json.topic === "string" && json.topic.trim() ? json.topic.trim().slice(0, 200) : null,
    source: "llm",
  };
}

/** Như trước khi có bước hiểu câu hỏi: nhận diện bằng từ khóa. Dùng khi model lỗi. */
async function heuristicRoute(query: string, history: ChatMessage[]): Promise<RoutedQuery> {
  const intent = await classifyIntent(query, history);
  const followUp = intent === "FOLLOW_UP";
  const standaloneQuery = followUp ? await rewriteFollowUpQuery(query, history) : query;
  const recentContext = history.slice(-2).map((m) => m.content.slice(0, 500)).join("\n");

  let task: Task = "sop_question";
  if (intent === "CHITCHAT") task = "chitchat";
  else if (looksLikeQualzenQuestion(`${query}\n${recentContext}`)) task = "qualzen";
  else if (isInventoryQuestion(standaloneQuery)) task = "doc_inventory";
  else if (isOverlapQuestion(standaloneQuery)) task = "overlap_check";
  else if (isCompareQuestion(standaloneQuery)) task = "doc_compare";
  else if (isOverviewQuestion(standaloneQuery)) task = "doc_overview";

  // Các bước sau tự nhận diện phòng ban / loại tài liệu / mã từ câu hỏi như trước
  return {
    task,
    followUp,
    standaloneQuery,
    docCodes: [],
    departments: [],
    docTypes: [],
    wantsList: false,
    topic: null,
    source: "heuristic",
  };
}

export interface RouteOptions {
  categories?: string[]; // để thử nghiệm; mặc định lấy từ kho
  noFallback?: boolean; // để thử nghiệm: model lỗi thì throw thay vì quay về từ khóa
  holdOutExamples?: boolean; // để thử nghiệm: không dùng ví dụ trùng nguyên văn câu đang đo
}

export async function routeQuery(
  query: string,
  history: ChatMessage[],
  options: RouteOptions = {}
): Promise<RoutedQuery> {
  if (OBVIOUS_CHITCHAT.test(query.normalize("NFC").trim())) {
    return { task: "chitchat", followUp: false, standaloneQuery: query, docCodes: [], departments: [], docTypes: [], wantsList: false, topic: null, source: "heuristic" };
  }

  const key = cacheKey(query, history);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.route;

  let categories = options.categories;
  if (!categories) {
    try {
      categories = Array.from(new Set((await getIndexedFiles()).map((f) => f.category))).sort();
    } catch {
      categories = [];
    }
  }

  const historyText = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 300)}`)
    .join("\n");
  // Thuật ngữ nội bộ có trong câu hỏi + ví dụ đã kiểm chứng giống câu hỏi nhất
  const [terms, examples] = await Promise.all([
    glossaryMatches(`${query}\n${history.slice(-1).map((m) => m.content.slice(0, 300)).join("")}`),
    similarExamples(query, undefined, options.holdOutExamples),
  ]);
  const user = [
    `PHÒNG BAN TRONG KHO: ${categories.join(", ") || "(không rõ)"}`,
    glossaryHint(terms),
    formatExamples(examples),
    `Lịch sử hội thoại:\n${historyText || "(chưa có)"}`,
    `Câu hỏi mới: "${query}"\n\nJSON:`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let route: RoutedQuery | null = null;
  let raw = "";
  try {
    raw = await callRouterStrict(ROUTER_PROMPT, user, ROUTER_MAX_TOKENS, "low");
    route = parseRoute(raw, query, categories);
  } catch (err) {
    if (options.noFallback) throw err;
    console.warn("Query router failed:", (err as Error).message);
  }
  if (!route) {
    if (options.noFallback) throw new Error(`Không đọc được JSON từ model: ${raw.slice(0, 200)}`);
    return heuristicRoute(query, history);
  }

  // Không có lịch sử thì không thể là câu tiếp nối
  if (history.length === 0) route.followUp = false;

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { route, at: Date.now() });
  return route;
}

import { getCatalogFiles } from "./fileCatalog.js";
import { glossaryHint, glossaryMatches } from "./glossary.js";
import { formatExamples, similarExamples } from "./routerExamples.js";
import { looksLikeQualzenQuestion } from "./qualzenAssistant.js";
import {
  isBareTypeQuestion,
  isDocInfoQuestion,
  isInventoryQuestion,
  isParentLookupQuestion,
  isSopContentQuestion,
  isSopScopeInventoryQuestion,
  isTypeAndDepartmentOnly,
  type DocType,
} from "./docInventory.js";
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
  | "doc_inventory" // đếm / liệt kê tài liệu trong kho (theo phòng ban, hoặc biểu mẫu / phụ lục của một SOP)
  | "doc_lookup" // tra một tài liệu theo mã: biểu mẫu thuộc SOP nào, tên, phiên bản
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

const TASKS: Task[] = ["chitchat", "sop_question", "doc_overview", "doc_inventory", "doc_lookup", "doc_compare", "overlap_check", "qualzen"];
const DOC_TYPES: DocType[] = ["sop", "form", "appendix", "list"];

const ROUTER_PROMPT = `Bạn phân tích câu hỏi gửi tới trợ lý nội bộ của một công ty dược. Trợ lý tra cứu kho tài liệu SOP (SOP chính, biểu mẫu F.., phụ lục A..) và hệ thống QualZen (Action Item, CCN/Change Control, CAPA).

Chọn ĐÚNG MỘT "task" theo Ý NGHĨA câu hỏi (người dùng diễn đạt rất khác nhau, gõ sai chính tả, không dấu, viết tắt; đừng bám từ khóa):
- chitchat: chào hỏi, cảm ơn, khen chê, hỏi trợ lý là ai / làm được gì, nói chuyện ngoài lề.
- sop_question: hỏi NỘI DUNG / quy định / cách làm / các bước / định nghĩa / trách nhiệm trong tài liệu; tìm tài liệu theo CHỦ ĐỀ ("có sop nào về hiệu chuẩn", "quy trình khiếu nại là sop số mấy").
- doc_overview: muốn biết tổng quan một tài liệu được nêu mã: nội dung, tóm tắt, nói về gì, mục đích, phạm vi.
- doc_inventory: ĐẾM hoặc LIỆT KÊ tài liệu trong kho: theo phòng ban / loại tài liệu ("QA có bao nhiêu SOP", "các sop của qa", "sop qa"), hoặc biểu mẫu / phụ lục CỦA MỘT SOP được nêu mã ("có mấy f sop qa 13", "sopqa13 có form nào", "sop qa 13 gồm những gì").
- doc_lookup: tra MỘT tài liệu theo mã: biểu mẫu / phụ lục này THUỘC SOP nào ("FRM/QA/SOP-GEN/0013-F02 thuộc sop nào"); tên, phiên bản, ngày ban hành, hiệu lực của SOP ("sop qa 13 tên là gì", "SOP IT 13 đang ở phiên bản mấy").
- doc_compare: so sánh, đối chiếu 2 tài liệu trở lên được nêu mã.
- overlap_check: rà quy định trùng lặp / chồng chéo / mâu thuẫn giữa các tài liệu; hoặc một quy định nằm rải rác ở những tài liệu nào để gom lại.
- qualzen: hỏi về HỒ SƠ / phiếu thực tế: action item, CCN, change control, PCC, CAPA (mã phiếu, danh sách, số lượng, trạng thái, ai đang giữ, hạn, phiếu liên quan tới SOP nào). Hỏi QUY TRÌNH change control / CAPA (cách làm, mấy bước, khi nào phải mở) là sop_question.

Thứ tự ưu tiên khi phân vân (dừng ở luật đầu tiên đúng):
1. Hỏi nội dung bên trong tài liệu → sop_question / doc_overview, kể cả có chữ "liệt kê" ("liệt kê các bước của sop qa 13").
2. Mã biểu mẫu / phụ lục + "thuộc / nằm trong sop nào" → doc_lookup.
3. Hỏi tên / phiên bản / ngày ban hành → doc_lookup ("phiên bản mấy" không phải đếm).
4. Chủ đề không kèm mã → sop_question ("là sop số mấy" không phải đếm).
5. Có từ đếm (bao nhiêu, mấy, số lượng, tổng số, sl, how many) hoặc đòi danh sách (liệt kê, danh sách, ds, kể tên, có những ... nào) về tài liệu → doc_inventory.
6. Chỉ nêu loại tài liệu + phòng ban hoặc mã ("sop qa", "các f sop qa 13") → doc_inventory, list true. Một chữ "sop" trơn → doc_inventory, departments [].

Từ điển:
- Phòng ban: QA = đảm bảo chất lượng, phòng chất lượng; QC = kiểm nghiệm, kiểm soát / kiểm tra chất lượng; IT = CNTT, công nghệ thông tin, phòng máy tính; HR = nhân sự, hành chính nhân sự, HCNS; ME = cơ điện; FD = phát triển công thức; PD = sản xuất, xưởng; RA = đăng ký thuốc; WH = kho (phòng kho; "kho tài liệu" là cả kho, không phải WH).
- Loại: SOP = quy trình, QT; biểu mẫu = form, format, BM, mẫu, "f" đứng riêng cạnh sop / mã; phụ lục = PL, appendix, annex; list = List (vd List thiết bị, mã FRM/PD/L/0001). Kho còn các loại khác gọi theo mã loại: SPE (đặc tính kỹ thuật), STP (phương pháp kiểm nghiệm), AR (phiếu phân tích), BMR / BPR (hồ sơ lô), BOM, MFR, các hồ sơ thẩm định (PVP, IQP, OQP, PQP...): đếm / liệt kê các loại này cũng là doc_inventory.
- Mã: "FRM/IT/SOP-GEN/0013" (tên file viết FRM-IT-SOP-GEN-0013) = SOP 0013 của IT; thêm "-F02" là biểu mẫu, "-A01" là phụ lục. "sop qa 13" = "sopqa13" = "SOP QA 0013". Phòng ban lấy theo mã.
- Viết tắt: ds = danh sách, sl = số lượng.

Các trường khác:
- follow_up: true nếu câu hỏi phụ thuộc lịch sử (đại từ "nó / cái đó / SOP này", "còn ... thì sao", "ngắn gọn hơn", "liệt kê tiếp", trả lời "có / ok" khi trợ lý vừa hỏi "có muốn xem danh sách không").
- standalone_query: viết lại câu hỏi thành câu ĐỘC LẬP, đủ ý, tiếng Việt có dấu (thay đại từ bằng đối tượng cụ thể trong lịch sử, giữ nguyên mã, sửa lỗi chính tả). Câu chỉ đòi đổi cách trình bày → nêu lại chủ đề đang nói. Câu đã rõ → chép nguyên.
- doc_codes: các mã tài liệu được nhắc, chép như người dùng viết ("sop qa 13", "FRM/QA/SOP-GEN/0039", "P.IT.1016"); kể cả mã nằm trong lịch sử mà câu hỏi đang nói tới. Không có → [].
- departments: phòng ban được nhắc, chỉ dùng tên trong danh sách PHÒNG BAN TRONG KHO bên dưới. Không nhắc → [].
- doc_types (cho doc_inventory): "sop", "form" (biểu mẫu), "appendix" (phụ lục), "list". "tài liệu / văn bản / file" chung chung → ["sop","form","appendix","list"]. Loại khác (SPE, BMR...) → để code tự nhận từ câu hỏi, doc_types []. Nêu mã SOP mà không nói loại → ["form","appendix"]. Không nói rõ → ["sop"].
- list: true nếu muốn xem danh sách / tên các tài liệu (kể cả câu không có từ đếm như "các sop của qa", "sop qa"); false nếu chỉ hỏi số lượng.
- topic: chủ đề quy định khi task là overlap_check và người dùng nêu chủ đề (vd "đào tạo nhân viên mới"); rà chung chung → null.

Ví dụ (rút gọn):
"số lượng SOP của QA" / "co bao nhieu sop qa" / "sl sop hr" → doc_inventory, departments ["QA"] (["HR"]), doc_types ["sop"], list false
"các sop của qa" / "sop qa" / "cho xin ds sop phòng chất lượng" → doc_inventory, ["QA"], ["sop"], list true
"QA có bao nhiêu SOP, gồm những cái nào" → doc_inventory, ["QA"], ["sop"], list true
"phòng IT có những tài liệu gì" → doc_inventory, ["IT"], ["sop","form","appendix"], list true
"có mấy f sop qa 13" → doc_inventory, doc_codes ["sop qa 13"], ["form"], list false
"phụ lục của sop qa 5" / "sop qa 13 gồm những gì" → doc_inventory, doc_codes, ["appendix"] / ["form","appendix"], list true
"biểu mẫu FRM/QA/SOP-GEN/0013-F02 thuộc sop nào" / "sop qa 0013 tên là gì" → doc_lookup, doc_codes
"liệt kê các bước của sop qa 13" / "biểu mẫu F07 của SOP 0005 dùng làm gì" → sop_question, doc_codes
"SOP nào quy định về vệ sinh phòng sạch" / "liệt kê các sop nói về đào tạo" → sop_question
"nội dung sop it 1012" / "tóm tắt sop qa 1" → doc_overview
"so sánh sop qa 0005 với sop qa 0017" / "0005 và 0017 khác nhau chỗ nào" → doc_compare
"sop 0005 có trùng nội dung với sop nào không" / "các sop của QA có chồng chéo nhau không" → overlap_check, topic null
"quy định đào tạo nhân viên mới đang nằm ở những sop nào" → overlap_check, topic "đào tạo nhân viên mới"
"AI 1139 đang chờ ai duyệt" / "QC còn bao nhiêu action item quá hạn" / "ccn nào sửa sop FRM/QA/SOP-GEN/0039" → qualzen
"quy trình change control gồm mấy bước" / "khi nào phải mở CAPA" → sop_question
Lịch sử đang nói về số SOP của QA, hỏi "còn phòng QC thì sao" → doc_inventory, ["QC"], follow_up true
Trợ lý vừa hỏi "có muốn xem danh sách không" về SOP của QA, trả lời "có" → doc_inventory, ["QA"], ["sop"], list true, follow_up true
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

// Các task có thể bị đổi bởi quy tắc cố định bên dưới (QualZen, so sánh, rà trùng lặp giữ nguyên)
const DOC_TASKS: Task[] = ["chitchat", "sop_question", "doc_overview", "doc_inventory", "doc_lookup"];

/**
 * Quy tắc cố định cho câu hỏi có mã SOP (thứ tự ưu tiên ở mục 4.1 docs/training-ver2.docx), áp sau
 * model: các câu này nhận diện chắc chắn được bằng mẫu, không để model đổi kết quả giữa các lần hỏi.
 */
function applyDocRules(route: RoutedQuery, query: string): RoutedQuery {
  if (!DOC_TASKS.includes(route.task)) return route;
  // Xét trên câu GỐC: model có thể viết lại làm đổi nghĩa ("sop qa 13 gồm những gì" → "nội dung SOP QA 0013 gồm
  // những gì"). Câu nối tiếp ("còn IT thì sao") thì câu gốc thiếu ý, phải dùng câu đã viết lại.
  const q = route.followUp ? route.standaloneQuery : query;
  let task = route.task;
  if (isBareTypeQuestion(query)) task = "doc_inventory"; // "sop" trơn → hỏi lại phòng nào
  else if (task === "chitchat") return route;
  else if (isSopContentQuestion(q)) task = task === "doc_overview" ? task : "sop_question";
  else if (isParentLookupQuestion(q) || isDocInfoQuestion(q)) task = "doc_lookup";
  else if (isSopScopeInventoryQuestion(q) || isTypeAndDepartmentOnly(q)) task = "doc_inventory";
  if (task === route.task) return route;
  // Đã đổi nhánh theo câu gốc → bước sau cũng đọc câu gốc, không đọc câu model viết lại
  return { ...route, task, standaloneQuery: route.followUp ? route.standaloneQuery : query };
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
  heuristicOnly?: boolean; // để thử nghiệm không cần Groq: chỉ nhận diện bằng từ khóa + quy tắc cố định
}

export async function routeQuery(
  query: string,
  history: ChatMessage[],
  options: RouteOptions = {}
): Promise<RoutedQuery> {
  // "ok", "dạ" ngay sau câu trợ lý hỏi "có muốn xem danh sách không" là đồng ý xem danh sách, không phải chào hỏi
  const answersOffer = /muốn xem danh sách không\?\s*$/.test(history.at(-1)?.content.trim() ?? "");
  if (!answersOffer && OBVIOUS_CHITCHAT.test(query.normalize("NFC").trim())) {
    return { task: "chitchat", followUp: false, standaloneQuery: query, docCodes: [], departments: [], docTypes: [], wantsList: false, topic: null, source: "heuristic" };
  }

  if (options.heuristicOnly) return applyDocRules(await heuristicRoute(query, history), query);

  const key = cacheKey(query, history);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.route;

  let categories = options.categories;
  if (!categories) {
    try {
      categories = Array.from(new Set((await getCatalogFiles()).map((f) => f.category))).sort();
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
    return applyDocRules(await heuristicRoute(query, history), query);
  }

  // Không có lịch sử thì không thể là câu tiếp nối
  if (history.length === 0) route.followUp = false;
  route = applyDocRules(route, query);

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { route, at: Date.now() });
  return route;
}

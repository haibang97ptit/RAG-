import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { routeQuery, type RoutedQuery, type Task } from "./queryRouter.js";
import { docLookupReplyFor, inventoryReplyFor, type DocType, type InventoryReply } from "./docInventory.js";
import type { ChatMessage } from "./llmService.js";
import type { IndexedFile } from "./qdrantService.js";

/**
 * Bộ câu hỏi kiểm thử ở mục 8 docs/training-ver2.docx: mỗi câu kiểm
 *   (1) phân loại đúng: intent, loại tài liệu, phòng ban, mã SOP;
 *   (2) danh sách / con số bot trả về khớp với kho: ghi rõ thiếu file nào, thừa file nào.
 * Con số và danh sách đúng KHÔNG ghi sẵn mà tính lại từ kho mỗi lần chạy (cách tính riêng, độc lập với code của bot).
 * Mã / phòng ví dụ mà kho không có (vd SOP QA 0013) → đáp án đúng là "không tìm thấy" / "không có phòng này".
 *
 *   npm run eval:training                  model router thật (Groq) + kho mẫu bên dưới
 *   npm run eval:training -- --offline     không gọi Groq: chỉ nhận diện bằng từ khóa + quy tắc cố định
 *   npm run eval:training -- --live        dùng kho thật đang index trong Qdrant thay cho kho mẫu
 *   npm run eval:training -- --docuzen     dùng danh mục chính thức của Docuzen (bản đang hiệu lực) thay cho kho mẫu
 *   npm run eval:training -- --all-sops    câu sinh tự động cho MỌI SOP trong kho (thêm --live để chạy trên kho thật)
 *   npm run eval:training -- 9 10 28       chỉ chạy các câu số 9, 10, 28
 * Kết quả đầy đủ: .cache/training-eval.json
 *
 * Gợi ý (theo tài liệu training): mỗi khi bot trả lời sai một câu thật của người dùng, thêm câu đó vào CASES.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "../.cache/training-eval.json");

type Intent =
  | "DEM"
  | "LIET_KE"
  | "DEM_VA_LIET_KE"
  | "TRA_NGUOC"
  | "TIM_THEO_CHU_DE"
  | "THONG_TIN_TAI_LIEU"
  | "HOI_NOI_DUNG"
  | "KHAC";

interface Case {
  id: number;
  q: string;
  intent: Intent;
  types?: DocType[]; // loại tài liệu cần đếm / liệt kê
  departments?: string[]; // [] = tất cả phòng ban
  code?: string; // "QA 0013" (phòng + số SOP), "QA 0013 F02" khi tra ngược
  outcome?: "hoi_lai" | "khong_co_phong" | "khong_tim_thay";
  history?: ChatMessage[];
  needsModel?: boolean; // từ khóa không đủ (sai chính tả, câu nối tiếp): bỏ qua khi --offline
  skip?: string;
  missingDepartments?: string[]; // phòng được hỏi nhưng kho không có: bot phải báo riêng
  note?: string; // vì sao đáp án được điều chỉnh theo kho đang đo
}

const QA_COUNT_HISTORY: ChatMessage[] = [
  { role: "user", content: "QA có bao nhiêu SOP" },
  { role: "assistant", content: "Theo danh mục tài liệu trợ lý đang có, phòng QA có **6** SOP chính. Bạn có muốn xem danh sách không?" },
];

const S: DocType[] = ["sop"];
const F: DocType[] = ["form"];
const A: DocType[] = ["appendix"];
const ALL: DocType[] = ["sop", "form", "appendix"];

const CASES: Case[] = [
  { id: 1, q: "có bao nhiêu sop qa", intent: "DEM", types: S, departments: ["QA"] },
  { id: 2, q: "QA có bao nhiêu SOP", intent: "DEM", types: S, departments: ["QA"] },
  { id: 3, q: "số lượng sop QC", intent: "DEM", types: S, departments: ["QC"] },
  { id: 4, q: "số phượng sop QC", intent: "DEM", types: S, departments: ["QC"], needsModel: true },
  { id: 5, q: "phòng IT có mấy quy trình", intent: "DEM", types: S, departments: ["IT"] },
  { id: 6, q: "co bao nhieu sop qa", intent: "DEM", types: S, departments: ["QA"] },
  { id: 7, q: "tổng số sop phòng đảm bảo chất lượng", intent: "DEM", types: S, departments: ["QA"] },
  { id: 8, q: "sl sop hr", intent: "DEM", types: S, departments: ["HR"] },
  { id: 9, q: "sop qa 0001 có bao nhiêu biểu mẫu", intent: "DEM", types: F, code: "QA 0001" },
  { id: 10, q: "có mấy f sop qa 13", intent: "DEM", types: F, code: "QA 0013" },
  { id: 11, q: "số biểu mẫu của FRM/IT/SOP-GEN/0013", intent: "DEM", types: F, code: "IT 0013" },
  { id: 12, q: "sop qa 1 có mấy form", intent: "DEM", types: F, code: "QA 0001" },
  { id: 13, q: "SOP IT 13 có bao nhiêu phụ lục", intent: "DEM", types: A, code: "IT 0013" },
  { id: 14, q: "có bao nhiêu sop", intent: "DEM", types: S, departments: [] },
  { id: 15, q: "QA có bao nhiêu tài liệu", intent: "DEM", types: ALL, departments: ["QA"] },
  { id: 16, q: "how many SOPs does QA have", intent: "DEM", types: S, departments: ["QA"] },
  { id: 17, q: "hãy liệt kê các sop của qa", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 18, q: "các sop của qa", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 19, q: "các SOP hiện tại của QA", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 20, q: "sop qa", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 21, q: "kể tên sop phòng qa", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 22, q: "QA có những quy trình nào", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 23, q: "cho xin ds sop phòng chất lượng", intent: "LIET_KE", types: S, departments: ["QA"] },
  { id: 24, q: "danh sách quy trình của nhân sự", intent: "LIET_KE", types: S, departments: ["HR"] },
  { id: 25, q: "các biểu mẫu của sop IT 0013", intent: "LIET_KE", types: F, code: "IT 0013" },
  { id: 26, q: "biểu mẫu của FRM/IT/SOP-GEN/0013", intent: "LIET_KE", types: F, code: "IT 0013" },
  { id: 27, q: "SOP IT 13 có biểu mẫu gì", intent: "LIET_KE", types: F, code: "IT 0013" },
  { id: 28, q: "các f sop qa 13", intent: "LIET_KE", types: F, code: "QA 0013" },
  { id: 29, q: "sopqa13 có form nào", intent: "LIET_KE", types: F, code: "QA 0013" },
  { id: 30, q: "phụ lục của sop qa 5", intent: "LIET_KE", types: A, code: "QA 0005" },
  { id: 31, q: "sop qa 13 gồm những gì", intent: "LIET_KE", types: ["form", "appendix"], code: "QA 0013" },
  { id: 32, q: "sop của QA và QC", intent: "LIET_KE", types: S, departments: ["QA", "QC"] },
  { id: 33, q: "QA có bao nhiêu SOP, gồm những cái nào", intent: "DEM_VA_LIET_KE", types: S, departments: ["QA"] },
  { id: 34, q: "có mấy biểu mẫu sop it 13, liệt kê ra", intent: "DEM_VA_LIET_KE", types: F, code: "IT 0013" },
  { id: 35, q: "số lượng và danh sách sop QC", intent: "DEM_VA_LIET_KE", types: S, departments: ["QC"] },
  { id: 36, q: "biểu mẫu FRM/QA/SOP-GEN/0013-F02 thuộc sop nào", intent: "TRA_NGUOC", code: "QA 0013 F02" },
  { id: 37, q: "phụ lục FRM/QA/SOP-GEN/0013-A01 nằm trong SOP nào", intent: "TRA_NGUOC", code: "QA 0013 A01" },
  { id: 38, q: "có sop nào về hiệu chuẩn không", intent: "TIM_THEO_CHU_DE" },
  { id: 39, q: "SOP quản lý mật khẩu là sop nào", intent: "TIM_THEO_CHU_DE" },
  { id: 40, q: "quy trình xử lý khiếu nại của QA là sop số mấy", intent: "TIM_THEO_CHU_DE" },
  { id: 41, q: "sop qa 0013 tên là gì", intent: "THONG_TIN_TAI_LIEU", code: "QA 0013" },
  { id: 42, q: "SOP IT 13 đang ở phiên bản mấy", intent: "THONG_TIN_TAI_LIEU", code: "IT 0013" },
  { id: 43, q: "sop qa 0013 quy định gì về lưu hồ sơ", intent: "HOI_NOI_DUNG" },
  { id: 44, q: "mật khẩu phải đổi bao lâu một lần", intent: "HOI_NOI_DUNG" },
  { id: 45, q: "liệt kê các bước của sop qa 13", intent: "HOI_NOI_DUNG" },
  { id: 46, q: "tóm tắt sop qa 1", intent: "HOI_NOI_DUNG" },
  { id: 47, q: "sop phòng ABC", intent: "LIET_KE", types: S, outcome: "khong_co_phong" },
  { id: 48, q: "các biểu mẫu sop qa 0999", intent: "LIET_KE", types: F, code: "QA 0999", outcome: "khong_tim_thay" },
  { id: 49, q: "biểu mẫu sop IT 13 của phòng QA", intent: "LIET_KE", types: F, outcome: "hoi_lai" },
  { id: 50, q: "còn IT thì sao?", intent: "DEM", types: S, departments: ["IT"], history: QA_COUNT_HISTORY, needsModel: true },
  { id: 51, q: "QA có mấy sop, sop qa 13 có mấy biểu mẫu", intent: "DEM", skip: "câu hỏi kép: chưa hỗ trợ (làm sau)" },
  { id: 52, q: "sop", intent: "KHAC", outcome: "hoi_lai" },
  { id: 53, q: "xin chào", intent: "KHAC" },
];

// ---------- Kho mẫu: đủ các trường hợp trong bộ câu hỏi ----------

const fixture = (category: string, names: string[]): IndexedFile[] =>
  names.map((fileName) => ({ fileName, category, filePath: `/data/${category}/${fileName}` }));

const FIXTURE_FILES: IndexedFile[] = [
  ...fixture("QA", [
    "FRM-QA-SOP-GEN-0001-03 DOCUMENT CONTROL.docx",
    "FRM-QA-SOP-GEN-0001-03 DOCUMENT CONTROL.pdf",
    "FRM.QA.SOP-GEN.0001-F01-02 DOCUMENT REQUEST FORM.docx",
    "FRM.QA.SOP-GEN.0001-F02-01 DOCUMENT DISTRIBUTION LIST.docx",
    "FRM.QA.SOP-GEN.0001-A01-01 DOCUMENT CODING RULES.docx",
    "FRM-QA-SOP-GEN-0005-10 SELF INSPECTION.docx",
    "FRM-QA-SOP-GEN-0005-10 SELF INSPECTION translation.docx",
    "FRM.QA.SOP-GEN.0005-F01-03 MASTER PLAN.docx",
    "FRM.QA.SOP-GEN.0005-F05-02 SELF INSPECTION PLAN.docx",
    "FRM.QA.SOP-GEN.0005-F07-02 SELF INSPECTION REPORT.docx",
    "FRM.QA.SOP-GEN.0005-A01-01 CHECKLIST GUIDE.docx",
    "FRM.QA.SOP-GEN.0005-A03-01 RISK RANKING.pdf",
    "FRM-QA-SOP-GEN-0013-02 RECORD MANAGEMENT.docx",
    "FRM-QA-SOP-GEN-0013-F01-01 RECORD LIST.docx",
    "FRM-QA-SOP-GEN-0013-F02-01 RECORD DESTRUCTION FORM.docx",
    "FRM.QA_SOP-GEN.0013-F03.01 ARCHIVE LOG.docx",
    "FRM-QA-SOP-GEN-0013-A01-01 RETENTION PERIOD TABLE.docx",
    "FRM-QA-SOP-GEN-0017-04 QUALITY RISK MANAGEMENT.docx",
    "FRM-QA-SOP-GEN-0020-01 COMPLAINT HANDLING.docx",
    "FRM_QA_SOP-GEN_0039_02 CHANGE CONTROL.docx",
  ]),
  ...fixture("QC", [
    "FRM-QC-SOP-CAL-0003-02 CALIBRATION OF BALANCES.docx",
    "FRM-QC-SOP-CAL-0003-F01-01 CALIBRATION RECORD.docx",
    "FRM-QC-SOP-GEN-0020-01 SAMPLING.docx",
    "FRM-QC-SOP-GEN-0021-01 OOS INVESTIGATION.docx",
  ]),
  ...fixture("IT", [
    "FRM-IT-SOP-GEN-0001-02 USER ACCOUNT MANAGEMENT.docx",
    "FRM-IT-SOP-GEN-0002-01 BACKUP AND RESTORE.docx",
    "FRM-IT-SOP-GEN-0013-01 PASSWORD MANAGEMENT.docx",
    "FRM-IT-SOP-GEN-0013-F01-01 ACCOUNT REQUEST FORM.docx",
    "FRM-IT-SOP-GEN-0013-F02-01 PASSWORD RESET LOG.docx",
    "FRM-IT-SOP-GEN-0016-01 COMPUTER SYSTEM VALIDATION.docx",
    "FRM_IT_SOP_GEN_0016_A01_01 VALIDATION TEMPLATE.docx",
  ]),
  ...fixture("HR", [
    "FRM-HR-SOP-GEN-0040-01 RECRUITMENT.docx",
    "FRM-HR-SOP-GEN-0041-01 TRAINING.docx",
    "FRM-HR-SOP-GEN-0041-F01-01 TRAINING RECORD.docx",
  ]),
  ...fixture("PD", ["FRM.PRD.SOP-MFG.0005-01 GRANULATION.docx", "FRM.PRD.SOP-MFG.0005-F01-01 BATCH RECORD.docx"]),
  // File test, tên không theo chuẩn: bộ test bỏ qua
  ...fixture("RA", ["Test upload.docx", "ban thu nghiem.pdf"]),
];

// ---------- Đáp án tính từ kho (cách tính riêng, không dùng code của bot) ----------

interface RefDoc {
  key: string; // "QA|GEN|0013|F02"
  department: string; // theo mã (PRD → PD); không có mã thì theo thư mục
  category: string;
  number: string;
  type: DocType;
  sub: string; // "F02", "A01", "" (SOP chính)
  series: string; // "GEN"
  rawDepartment: string; // như viết trong tên file ("PRD")
}

// Tên file đúng chuẩn: FRM + phòng ban + SOP + nhóm + mã, ngăn cách bằng "-", "_", "." (tên file) hoặc "/" (số Docuzen)
// ("FRM-QA-SOP-GEN-0016", "FRM_QA_SOP-GEN_0016", "FRM.QA.SOP-GEN.0005-F11-03")
const CODE_RE = /^FRM[-_./]([A-Z]+)[-_./]SOP[-_./]([A-Z]+)[-_./](\d{4})(?:[-_./]([FA])(\d{1,3}))?(?![A-Z0-9])/i;

function refDoc(file: IndexedFile): RefDoc | null {
  const m = file.fileName.match(CODE_RE);
  if (!m) return null;
  const department = m[1].toUpperCase() === "PRD" ? "PD" : m[1].toUpperCase();
  const [, , series, number, mark, subNumber] = m;
  const sub = mark ? `${mark.toUpperCase()}${subNumber.padStart(2, "0")}` : "";
  const type: DocType = !mark ? "sop" : mark.toUpperCase() === "F" ? "form" : "appendix";
  return {
    key: `${department}|${series.toUpperCase()}|${number}|${sub}`,
    department,
    category: file.category,
    number,
    type,
    sub,
    series: series.toUpperCase(),
    rawDepartment: m[1].toUpperCase(),
  };
}

function refDocs(files: IndexedFile[]): RefDoc[] {
  const byKey = new Map<string, RefDoc>();
  for (const f of files) {
    const d = refDoc(f);
    if (d && !byKey.has(d.key)) byKey.set(d.key, d);
  }
  return [...byKey.values()];
}

/** Đáp án của một câu: các tài liệu đúng (khóa) theo phạm vi và loại. */
function expectedKeys(c: Case, docs: RefDoc[]): string[] {
  const types = c.types ?? [];
  if (c.code) {
    const [department, number] = c.code.split(" ");
    return docs.filter((d) => d.department === department && d.number === number && types.includes(d.type)).map((d) => d.key);
  }
  const departments = c.departments ?? [];
  return docs
    .filter((d) => (departments.length === 0 || departments.includes(d.category)) && types.includes(d.type))
    .map((d) => d.key);
}

/**
 * Các tài liệu bot liệt kê: dòng "1. FRM-QA-SOP-GEN-0013-F01-01 – RECORD LIST" → khóa.
 * Dòng không đọc được mã vẫn giữ lại (dạng "?<tên>") để bị tính là thừa, không bị bỏ qua.
 */
function listedKeys(output: string): string[] {
  const keys: string[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^\d+\.\s+(\S+)/);
    if (!m) continue;
    keys.push(refDoc({ fileName: m[1], category: "", filePath: "" })?.key ?? `?${m[1]}`);
  }
  return keys;
}

/**
 * Câu hỏi trong tài liệu training dùng mã / phòng ví dụ (SOP QA 0013, phòng HR...). Kho đang đo không có
 * thì câu trả lời đúng là "không tìm thấy" / "không có phòng này", không phải danh sách của mã đó.
 */
function adaptToCatalog(c: Case, docs: RefDoc[], categories: string[]): Case {
  if (c.outcome) return c;
  if (c.code) {
    const [department, number] = c.code.split(" ");
    if (!docs.some((d) => d.department === department && d.number === number)) {
      return { ...c, outcome: "khong_tim_thay", note: `kho không có SOP ${department} ${number}: phải báo không tìm thấy` };
    }
    return c;
  }
  const missing = (c.departments ?? []).filter((d) => !categories.includes(d));
  if (missing.length === 0) return c;
  if (missing.length === c.departments!.length) {
    return { ...c, outcome: "khong_co_phong", note: `kho không có phòng ${missing.join(", ")}: phải báo không có` };
  }
  return {
    ...c,
    departments: c.departments!.filter((d) => !missing.includes(d)),
    missingDepartments: missing,
    note: `kho không có phòng ${missing.join(", ")}: phải báo riêng`,
  };
}

/**
 * --all-sops: sinh câu hỏi cho MỌI SOP có trong kho (không chỉ mã ví dụ trong tài liệu training):
 * nhiều cách viết mã × đếm / liệt kê biểu mẫu, phụ lục, tên; tra ngược từng biểu mẫu, phụ lục; đếm / liệt kê theo phòng.
 */
function allSopCases(docs: RefDoc[], categories: string[]): Case[] {
  const cases: Case[] = [];
  const add = (c: Omit<Case, "id">) => cases.push({ id: 1001 + cases.length, ...c });
  for (const sop of docs.filter((d) => d.type === "sop")) {
    const { department: D, number, series, rawDepartment } = sop;
    const dl = D.toLowerCase();
    const n = String(Number(number));
    const code = `${D} ${number}`;
    const styles = [`sop ${dl} ${n}`, `sop${dl}${n}`, `${D} sop ${number}`, `sop ${n} của ${dl}`, `FRM/${rawDepartment}/SOP-${series}/${number}`];
    for (const s of styles) {
      add({ q: `${s} có bao nhiêu biểu mẫu`, intent: "DEM", types: F, code });
      add({ q: `có mấy f ${s}`, intent: "DEM", types: F, code });
      add({ q: `các biểu mẫu của ${s}`, intent: "LIET_KE", types: F, code });
      add({ q: `phụ lục của ${s}`, intent: "LIET_KE", types: A, code });
      add({ q: `${s} gồm những gì`, intent: "LIET_KE", types: ["form", "appendix"], code });
      add({ q: `${s} tên là gì`, intent: "THONG_TIN_TAI_LIEU", code });
    }
    for (const child of docs.filter((d) => d.department === D && d.number === number && d.type !== "sop")) {
      const noun = child.type === "form" ? "biểu mẫu" : "phụ lục";
      add({ q: `${noun} FRM/${rawDepartment}/SOP-${series}/${number}-${child.sub} thuộc sop nào`, intent: "TRA_NGUOC", code: `${code} ${child.sub}` });
    }
  }
  for (const D of categories.filter((c) => /^[A-Z]{2,3}$/.test(c))) {
    const dl = D.toLowerCase();
    add({ q: `${D} có bao nhiêu SOP`, intent: "DEM", types: S, departments: [D] });
    add({ q: `sl sop ${dl}`, intent: "DEM", types: S, departments: [D] });
    add({ q: `${D} có bao nhiêu biểu mẫu`, intent: "DEM", types: F, departments: [D] });
    add({ q: `các sop của ${dl}`, intent: "LIET_KE", types: S, departments: [D] });
    add({ q: `liệt kê phụ lục phòng ${D}`, intent: "LIET_KE", types: A, departments: [D] });
  }
  return cases;
}

// ---------- Chạy một câu như server ----------

const TASKS_OF: Record<Intent, Task[]> = {
  DEM: ["doc_inventory"],
  LIET_KE: ["doc_inventory"],
  DEM_VA_LIET_KE: ["doc_inventory"],
  TRA_NGUOC: ["doc_lookup"],
  THONG_TIN_TAI_LIEU: ["doc_lookup"],
  TIM_THEO_CHU_DE: ["sop_question", "doc_overview"],
  HOI_NOI_DUNG: ["sop_question", "doc_overview"],
  KHAC: ["chitchat"],
};

/** Như inventoryReplyForRoute / docLookupReplyForRoute trong server.ts, nhưng trên kho đang đo. */
async function replyFor(route: RoutedQuery, files: IndexedFile[]): Promise<InventoryReply | null> {
  const fromModel = route.source === "llm";
  if (route.task === "doc_lookup") return docLookupReplyFor(route.standaloneQuery, { docCodes: route.docCodes, files });
  if (route.task !== "doc_inventory") return null;
  return inventoryReplyFor(route.standaloneQuery, {
    routed: fromModel,
    departments: fromModel ? route.departments : undefined,
    docTypes: fromModel ? route.docTypes : undefined,
    wantsList: route.wantsList,
    docCodes: route.docCodes,
    files,
  });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const TYPE_LABELS: Record<DocType, string> = { sop: "SOP chính", form: "Biểu mẫu", appendix: "Phụ lục", list: "List", other: "Tài liệu khác" };

function check(c: Case, route: RoutedQuery, reply: InventoryReply | null, docs: RefDoc[]): string[] {
  const problems: string[] = [];
  const allowed = c.outcome === "hoi_lai" && c.intent === "KHAC" ? ["doc_inventory"] : TASKS_OF[c.intent];
  if (!allowed.includes(route.task)) problems.push(`task ${route.task} (cần ${allowed.join(" / ")})`);
  if (!["doc_inventory", "doc_lookup"].includes(route.task) || problems.length > 0) return problems;
  if (!reply) return [...problems, "không có câu trả lời từ danh mục"];

  const output = reply.kind === "text" ? reply.text : `${reply.list.fallbackIntro}${reply.list.markdown}`;
  const summary: Record<string, any> = reply.kind === "text" ? reply.summary : JSON.parse(reply.summaryJson);

  if (c.outcome === "hoi_lai") {
    if (!summary.hoiLai) problems.push(`cần hỏi lại người dùng, bot trả lời: ${output.slice(0, 120)}`);
    return problems;
  }
  if (c.outcome === "khong_co_phong") {
    if (!summary.phongBanKhongCoTrongKho?.length) problems.push(`cần báo không có phòng ban này (phạm vi: ${summary.phamVi})`);
    return problems;
  }
  if (c.outcome === "khong_tim_thay") {
    if (!summary.khongTimThay) problems.push(`cần báo không tìm thấy mã, bot trả lời: ${output.slice(0, 120)}`);
    return problems;
  }

  const expected = expectedKeys(c, docs);
  const wantsCount = c.intent === "DEM" || c.intent === "DEM_VA_LIET_KE";
  const wantsList = c.intent === "LIET_KE" || c.intent === "DEM_VA_LIET_KE";

  if (c.intent === "TRA_NGUOC" || c.intent === "THONG_TIN_TAI_LIEU") {
    const [department, number] = c.code!.split(" ");
    // Cùng phòng, cùng số có thể có nhiều SOP khác nhóm (SOP-CAL 0003 và SOP-GEN 0003): nêu đúng một trong số đó là đạt
    const parents = docs.filter((d) => d.department === department && d.number === number && d.type === "sop");
    const mentioned = listedOrMentioned(output);
    const mentionsParent = parents.some((p) => mentioned.includes(p.key));
    if (!mentionsParent) problems.push(`không nêu SOP ${department} ${number}: ${output.slice(0, 150)}`);
    return problems;
  }

  // Phân loại: loại tài liệu, phòng ban
  if (reply.kind === "list") {
    const labels = String(summary.loaiTaiLieu).split(", ");
    if (c.types && !sameSet(labels, c.types.map((t) => TYPE_LABELS[t]))) problems.push(`loại ${labels} (cần ${c.types.map((t) => TYPE_LABELS[t])})`);
    const scope = String(summary.phamVi);
    if (c.departments?.length === 0 && scope !== "tất cả phòng ban") problems.push(`phạm vi "${scope}" (cần tất cả phòng ban)`);
    for (const d of c.departments ?? []) if (!scope.includes(d)) problems.push(`phạm vi "${scope}" (cần phòng ${d})`);
    if (c.departments?.length === 0 && !summary.theoPhongBan) problems.push("thiếu số liệu theo từng phòng ban");
    if ((c.types?.length ?? 0) > 1 && !summary.theoLoai) problems.push("thiếu số liệu theo từng loại");
    if (c.code) problems.push(`trả lời theo phòng ban, cần theo mã SOP ${c.code}`);
    const reported: string[] = summary.phongBanKhongCoTrongKho ?? [];
    for (const d of c.missingDepartments ?? []) if (!reported.includes(d)) problems.push(`không báo kho thiếu phòng ${d}`);
  } else {
    if (!c.code) problems.push(`trả lời theo mã SOP, cần theo phòng ban: ${output.slice(0, 100)}`);
    else {
      const [department, number] = c.code.split(" ");
      const labels: string[] = summary.ma ?? [];
      if (!labels.some((m) => m.split(" ").includes(department) && m.endsWith(number))) problems.push(`mã ${labels} (cần ${c.code})`);
    }
    if (c.types && !sameSet(summary.loaiTaiLieu ?? [], c.types.map((t) => TYPE_LABELS[t]))) problems.push(`loại ${summary.loaiTaiLieu} (cần ${c.types.map((t) => TYPE_LABELS[t])})`);
  }

  // Con số
  if (wantsCount) {
    const count =
      reply.kind === "list"
        ? summary.tongSo
        : Object.values(summary.theoSop ?? {}).reduce(
            (sum: number, s: any) => sum + (c.types!.includes("form") ? s.bieuMau : 0) + (c.types!.includes("appendix") ? s.phuLuc : 0),
            0
          );
    if (count !== expected.length) problems.push(`đếm được ${count}, kho có ${expected.length}`);
  }

  // Danh sách: có / không, thiếu / thừa
  const listed = listedKeys(output);
  const printedList = reply.kind === "list" ? summary.danhSachBenDuoi : summary.danhSach;
  if (wantsList && !printedList) problems.push("cần in danh sách nhưng không in");
  if (!wantsList && printedList) problems.push("câu chỉ hỏi số lượng nhưng bot in cả danh sách");
  if (wantsList && printedList) {
    const missing = expected.filter((k) => !listed.includes(k));
    const extra = listed.filter((k) => !expected.includes(k));
    if (missing.length) problems.push(`thiếu: ${missing.join(", ")}`);
    if (extra.length) problems.push(`thừa: ${extra.join(", ")}`);
  }
  return problems;
}

/** Khóa các mã có trong câu trả lời (kể cả nằm giữa câu, không chỉ dòng danh sách). */
function listedOrMentioned(output: string): string[] {
  return (output.match(/FRM[-_./][A-Z]+[-_./]SOP[-_./][A-Z]+[-_./]\d{4}(?:[-_./][FA]\d{1,3})?/gi) ?? [])
    .map((code) => refDoc({ fileName: code, category: "", filePath: "" })?.key)
    .filter((k): k is string => !!k);
}

/** Số đếm lệch: lấy danh sách bot đếm (hỏi lại kèm danh sách) để chỉ ra file nào thừa, file nào thiếu. */
async function countDiff(c: Case, route: RoutedQuery, files: IndexedFile[], docs: RefDoc[]): Promise<string | null> {
  const reply = await replyFor({ ...route, wantsList: true }, files);
  if (!reply) return null;
  const listed = listedKeys(reply.kind === "text" ? reply.text : reply.list.markdown);
  const expected = expectedKeys(c, docs);
  const missing = expected.filter((k) => !listed.includes(k));
  const extra = listed.filter((k) => !expected.includes(k));
  return [extra.length ? `bot đếm thừa: ${extra.join(", ")}` : "", missing.length ? `bot đếm thiếu: ${missing.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ") || null;
}

// ---------- Main ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function routeWithRetry(c: Case, categories: string[], offline: boolean): Promise<RoutedQuery> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await routeQuery(c.q, c.history ?? [], { categories, noFallback: !offline, heuristicOnly: offline, holdOutExamples: true });
    } catch (err) {
      const message = (err as Error).message || "";
      if (/tokens per day|TPD|requests per day|RPD/i.test(message)) throw new Error(`Hết hạn mức trong ngày của model router: ${message.slice(0, 200)}`);
      if (!/rate limit|429/i.test(message) || attempt >= 6) throw err;
      const seconds = Number(message.match(/try again in ([\d.]+)s/i)?.[1] ?? 20);
      process.stdout.write(`   (chờ ${Math.ceil(seconds + 1)}s vì giới hạn token/phút)\n`);
      await sleep((seconds + 1) * 1000);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const live = args.includes("--live");
  const docuzen = args.includes("--docuzen");
  const allSops = args.includes("--all-sops");
  const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

  let files = FIXTURE_FILES;
  if (docuzen) {
    const { getDocuzenFiles } = await import("./docuzenCatalog.js");
    files = await getDocuzenFiles();
  } else if (live) {
    const { getIndexedFiles } = await import("./fileCatalog.js");
    files = await getIndexedFiles();
  }
  if (!offline && !allSops) {
    const { initEmbedder } = await import("./embedding.js");
    await initEmbedder(); // chọn ví dụ gần giống câu hỏi như trên server
  } else {
    console.warn = () => {}; // không có model embedding / Groq: bỏ cảnh báo lặp lại
  }

  // Chỉ đo trên file đặt tên đúng chuẩn; file khác (file test, tên chưa đổi) liệt kê ra để biết mà sửa tên
  const ignored = files.filter((f) => !refDoc(f));
  files = files.filter((f) => refDoc(f));
  if (ignored.length > 0 && docuzen) {
    // Docuzen có hàng nghìn tài liệu loại khác SOP (SPE, BMR, thẩm định...): bộ câu hỏi này chỉ đo SOP
    console.log(`Bỏ qua ${ignored.length} tài liệu không thuộc nhóm SOP (loại khác, hoặc biểu mẫu / phụ lục của loại khác)
`);
  } else if (ignored.length > 0) {
    const MAX_SHOWN = 30;
    console.log(`Bỏ qua ${ignored.length} file tên không đúng chuẩn FRM-<phòng>-SOP-<nhóm>-<mã>:`);
    for (const f of ignored.slice(0, MAX_SHOWN)) console.log(`   ${f.category}/${f.fileName}`);
    if (ignored.length > MAX_SHOWN) console.log(`   ... và ${ignored.length - MAX_SHOWN} file khác`);
    console.log();
  }

  const categories = Array.from(new Set(files.map((f) => f.category))).sort();
  const docs = refDocs(files);
  // --all-sops: câu sinh tự động cho mọi SOP, nhận diện bằng từ khóa + quy tắc (không gọi model, không tốn hạn mức Groq)
  const source = allSops ? allSopCases(docs, categories) : CASES;
  const cases = (ids.length > 0 ? source.filter((c) => ids.includes(c.id)) : source).map((c) => adaptToCatalog(c, docs, categories));
  const heuristic = offline || allSops;
  console.log(
    `Chạy ${cases.length} câu${allSops ? " sinh cho mọi SOP trong kho" : ""} (${heuristic ? "không gọi model, chỉ từ khóa + quy tắc" : "model router thật"}, ${docuzen ? "danh mục Docuzen" : live ? "kho thật" : "kho mẫu"} ${files.length} file)...\n`
  );

  const results: any[] = [];
  let stopReason: string | null = null;
  for (const c of cases) {
    const skip = c.skip ?? (heuristic && c.needsModel ? "cần model (chạy không --offline)" : null);
    if (skip) {
      results.push({ id: c.id, q: c.q, skipped: skip });
      console.log(`- #${c.id} ${c.q}  → bỏ qua: ${skip}`);
      continue;
    }
    try {
      const route = await routeWithRetry(c, categories, heuristic);
      const reply = await replyFor(route, files);
      const problems = check(c, route, reply, docs);
      if (problems.some((p) => p.startsWith("đếm được"))) {
        const diff = await countDiff(c, route, files, docs);
        if (diff) problems.push(diff);
      }
      const output = reply ? (reply.kind === "text" ? reply.text : `${reply.list.fallbackIntro}${reply.list.markdown}`) : null;
      results.push({ id: c.id, q: c.q, ok: problems.length === 0, problems, note: c.note, route, output });
      // --all-sops có rất nhiều câu: chỉ in câu sai
      if (!allSops || problems.length > 0) {
        const note = c.note ? `  (${c.note})` : "";
        console.log(`${problems.length === 0 ? "✓" : "✗"} #${c.id} ${c.q}${note}${problems.length ? `  → ${problems.join("; ")}` : ""}`);
      }
    } catch (err) {
      stopReason = (err as Error).message;
      results.push({ id: c.id, q: c.q, ok: false, problems: [`lỗi: ${stopReason}`] });
      console.log(`! #${c.id} ${c.q}  → ${stopReason}`);
      if (/hạn mức trong ngày/.test(stopReason)) break;
      stopReason = null;
    }
  }

  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.ok).length;
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify({ passed, total: ran.length, offline, live, allSops, ignored, stopReason, results }, null, 2), "utf-8");

  console.log(`\nĐúng ${passed}/${ran.length} câu${results.length > ran.length ? ` (bỏ qua ${results.length - ran.length})` : ""}.`);
  if (stopReason) console.log(`Dừng sớm: ${stopReason}`);
  console.log(`Kết quả đầy đủ: ${OUTPUT_PATH}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", (err as Error).message || err);
  process.exit(1);
});

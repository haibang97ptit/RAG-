import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { routeQuery, type RoutedQuery, type Task } from "./queryRouter.js";
import type { ChatMessage } from "./llmService.js";
import { initEmbedder } from "./embedding.js";

/**
 * Đo bước hiểu câu hỏi trên model thật: nhiều cách hỏi khác nhau của cùng một ý phải ra cùng một kết quả.
 *   npm run eval:router              (toàn bộ, ~60 câu, mất khoảng 10-20 phút vì giới hạn token/phút của Groq)
 *   npm run eval:router -- inventory (chỉ chạy các nhóm có tên chứa "inventory")
 * Chỉ gọi model router (không cần Qdrant, QualZen). Kết quả đầy đủ: .cache/router-eval.json
 * Bộ câu ở đây cố ý KHÁC các ví dụ trong src/knowledge/router-examples.json, để đo khả năng hiểu
 * cách hỏi mới chứ không phải nhớ ví dụ.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "../.cache/router-eval.json");

// Phòng ban giả định có trong kho (tên thư mục cấp 1)
const CATEGORIES = ["AD", "DS", "FD", "HR", "IT", "ME", "PD", "PU", "QA", "QC", "RA", "TS", "WH"];

interface Expect {
  task: Task;
  departments?: string[];
  docTypes?: string[];
  followUp?: boolean;
  hasDocCodes?: boolean;
  wantsList?: boolean;
  hasTopic?: boolean;
}

interface Case {
  group: string;
  q: string;
  history?: ChatMessage[];
  expect: Expect;
}

const QA_INVENTORY_HISTORY: ChatMessage[] = [
  { role: "user", content: "số lượng SOP của QA" },
  { role: "assistant", content: "Theo danh mục tài liệu trợ lý đang có, phòng QA có **85** SOP chính." },
];
const SOP_0005_HISTORY: ChatMessage[] = [
  { role: "user", content: "nội dung sop qa 0005" },
  { role: "assistant", content: "SOP FRM.QA.SOP-GEN.0005 quy định việc tự thanh tra (self inspection): lập kế hoạch hằng năm, thành lập đoàn thanh tra, dùng các checklist F10-F17..." },
];
const CCN_LIST_HISTORY: ChatMessage[] = [
  { role: "user", content: "liệt kê ccn của phòng IT năm 2026" },
  { role: "assistant", content: "Phòng IT có **11** CCN tạo trong năm 2026: 5 đã đóng, 4 Approved by Head QA, 2 nháp." },
];

const inv = (departments: string[], docTypes: string[], wantsList?: boolean): Expect => ({
  task: "doc_inventory",
  departments,
  docTypes,
  ...(wantsList === undefined ? {} : { wantsList }),
});

const CASES: Case[] = [
  // ---- Đếm / liệt kê kho tài liệu: cùng một ý, nhiều cách hỏi ----
  ...[
    "số lượng SOP của QA",
    "QA có bao nhiêu SOP",
    "phòng QA đang có mấy quy trình",
    "đếm giúp anh số sop bên đảm bảo chất lượng",
    "cho hỏi tổng số SOP phòng QA hiện có",
    "QA hiện có tất cả bao nhiêu sop vậy",
    "Số SOP QA?",
    "sop của qa có bao nhiêu cái",
  ].map((q) => ({ group: "inventory-dem-sop-QA", q, expect: inv(["QA"], ["sop"]) })),
  ...[
    "liệt kê các SOP của QA",
    "QA có những SOP nào",
    "cho anh xin danh sách sop phòng QA",
    "kể tên các quy trình của phòng QA",
  ].map((q) => ({ group: "inventory-liet-ke-sop-QA", q, expect: inv(["QA"], ["sop"], true) })),
  { group: "inventory-bieu-mau", q: "QA có bao nhiêu biểu mẫu", expect: inv(["QA"], ["form"]) },
  { group: "inventory-bieu-mau", q: "số lượng form của phòng QC", expect: inv(["QC"], ["form"]) },
  { group: "inventory-phu-luc", q: "phòng IT có mấy phụ lục", expect: inv(["IT"], ["appendix"]) },
  { group: "inventory-tat-ca", q: "phòng IT có những tài liệu gì", expect: inv(["IT"], ["sop", "form", "appendix"], true) },
  { group: "inventory-tat-ca", q: "kho có tổng cộng bao nhiêu SOP", expect: inv([], ["sop"]) },
  { group: "inventory-tat-ca", q: "mỗi phòng có bao nhiêu SOP", expect: inv([], ["sop"]) },
  { group: "inventory-tiep-noi", q: "còn QC thì sao", history: QA_INVENTORY_HISTORY, expect: { ...inv(["QC"], ["sop"]), followUp: true } },
  { group: "inventory-tiep-noi", q: "thế còn biểu mẫu?", history: QA_INVENTORY_HISTORY, expect: { ...inv(["QA"], ["form"]), followUp: true } },

  // ---- Hỏi nội dung tài liệu (KHÔNG phải đếm kho) ----
  ...[
    "SOP nào quy định về vệ sinh phòng sạch",
    "liệt kê các sop nói về đào tạo",
    "quy trình change control gồm mấy bước",
    "khi nào phải mở CAPA",
    "thời gian lưu hồ sơ lô là bao lâu",
    "ai chịu trách nhiệm phê duyệt deviation",
  ].map((q) => ({ group: "noi-dung", q, expect: { task: "sop_question" as Task } })),
  ...[
    "sop qa 0005 có bao nhiêu biểu mẫu",
    "biểu mẫu F07 của SOP 0005 dùng để làm gì",
  ].map((q) => ({ group: "noi-dung-theo-ma", q, expect: { task: "sop_question" as Task, hasDocCodes: true } })),

  // ---- Tổng quan một tài liệu ----
  ...[
    "nội dung sop it 1012",
    "SOP IT 1012 nói về cái gì",
    "tóm tắt giúp quy trình QA 0005",
    "sop 0005 qa dùng để làm gì",
    "giới thiệu sơ qua về FRM/QA/SOP-GEN/0039",
  ].map((q) => ({ group: "tong-quan", q, expect: { task: "doc_overview" as Task, hasDocCodes: true } })),

  // ---- So sánh / trùng lặp ----
  ...[
    "so sánh sop qa 0005 và sop qa 0017",
    "0005 với 0017 của QA khác nhau thế nào",
    "điểm giống nhau giữa SOP QA 0010 và SOP QC 0003",
  ].map((q) => ({ group: "so-sanh", q, expect: { task: "doc_compare" as Task, hasDocCodes: true } })),
  { group: "trung-lap-1-sop", q: "sop 0005 có trùng nội dung với sop nào không", expect: { task: "overlap_check", hasDocCodes: true } },
  ...[
    "các sop của QA có chồng chéo nhau không",
    "trong các sop của qa, có sop nào trùng lặp nội dung với các sop khác không",
    "rà giúp anh xem SOP phòng QA có chỗ nào bị lặp lại không",
  ].map((q) => ({ group: "trung-lap-QA", q, expect: { task: "overlap_check" as Task, departments: ["QA"], hasTopic: false } })),
  ...[
    "quy định đào tạo nhân viên mới đang nằm ở những sop nào",
    "có sop nào mâu thuẫn nhau về thời gian lưu hồ sơ không",
  ].map((q) => ({ group: "trung-lap-chu-de", q, expect: { task: "overlap_check" as Task, hasTopic: true } })),

  // ---- QualZen ----
  ...[
    "AI 1139 đang chờ ai duyệt",
    "QC còn bao nhiêu action item quá hạn",
    "PCC IT 009 đang ở bước nào",
    "CAPA 136 có mấy action item",
    "các change control đang mở của phòng IT",
    "liệt kê change control năm 2026",
    "Liệt kê ccn của các phòng ban trong năm 2026",
  ].map((q) => ({ group: "qualzen", q, expect: { task: "qualzen" as Task } })),
  ...[
    "ccn nào sửa sop FRM/QA/SOP-GEN/0039",
    "change liên quan đến SOP FRM/QA/SOP-GEN/0039",
    "Xin thông tin ccn liên quan đến SOP FRM/QA/SOP-GEN/0039",
    "có phiếu thay đổi nào đề xuất sửa sop qa 0039 không",
  ].map((q) => ({ group: "qualzen-theo-sop", q, expect: { task: "qualzen" as Task, hasDocCodes: true } })),
  { group: "qualzen-tiep-noi", q: "cái nào còn đang mở", history: CCN_LIST_HISTORY, expect: { task: "qualzen", followUp: true } },

  // ---- Câu tiếp nối về một SOP ----
  { group: "tiep-noi-sop", q: "ngắn gọn hơn", history: SOP_0005_HISTORY, expect: { task: "sop_question", followUp: true, hasDocCodes: true } },
  { group: "tiep-noi-sop", q: "nó áp dụng cho bộ phận nào", history: SOP_0005_HISTORY, expect: { task: "sop_question", followUp: true, hasDocCodes: true } },

  // ---- Trò chuyện ----
  ...["chào em", "bạn làm được những gì", "cảm ơn nhiều nha", "hôm nay trời đẹp nhỉ"].map((q) => ({
    group: "tro-chuyen",
    q,
    expect: { task: "chitchat" as Task },
  })),
];

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function check(route: RoutedQuery, expect: Expect): string[] {
  const problems: string[] = [];
  if (route.task !== expect.task) problems.push(`task ${route.task} (cần ${expect.task})`);
  if (expect.departments && !sameSet(route.departments, expect.departments)) {
    problems.push(`phòng ban [${route.departments}] (cần [${expect.departments}])`);
  }
  if (expect.docTypes && !sameSet(route.docTypes, expect.docTypes)) {
    problems.push(`loại tài liệu [${route.docTypes}] (cần [${expect.docTypes}])`);
  }
  if (expect.followUp !== undefined && route.followUp !== expect.followUp) problems.push(`follow_up ${route.followUp}`);
  if (expect.hasDocCodes !== undefined && route.docCodes.length > 0 !== expect.hasDocCodes) {
    problems.push(`mã tài liệu [${route.docCodes}]`);
  }
  if (expect.wantsList !== undefined && route.wantsList !== expect.wantsList) problems.push(`list ${route.wantsList}`);
  if (expect.hasTopic !== undefined && !!route.topic !== expect.hasTopic) problems.push(`topic ${JSON.stringify(route.topic)}`);
  return problems;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Groq báo vượt giới hạn token/phút kèm thời gian chờ ("try again in 7.5s"); hết hạn mức ngày thì dừng. */
async function routeWithRetry(c: Case): Promise<RoutedQuery> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await routeQuery(c.q, c.history ?? [], { categories: CATEGORIES, noFallback: true, holdOutExamples: true });
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
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.group.includes(filter)) : CASES;
  // Model embedding dùng để chọn ví dụ gần giống câu hỏi (như trên server)
  await initEmbedder();
  console.log(`Chạy ${cases.length} câu hỏi${filter ? ` (nhóm có "${filter}")` : ""}...\n`);

  const results: any[] = [];
  let stopReason: string | null = null;
  for (const c of cases) {
    try {
      const route = await routeWithRetry(c);
      const problems = check(route, c.expect);
      results.push({ group: c.group, q: c.q, ok: problems.length === 0, problems, route });
      console.log(`${problems.length === 0 ? "✓" : "✗"} [${c.group}] ${c.q}${problems.length ? `  → ${problems.join("; ")}` : ""}`);
    } catch (err) {
      stopReason = (err as Error).message;
      results.push({ group: c.group, q: c.q, ok: false, problems: [`lỗi: ${stopReason}`] });
      console.log(`! [${c.group}] ${c.q}  → ${stopReason}`);
      if (/hạn mức trong ngày/.test(stopReason)) break;
      stopReason = null;
    }
  }

  const passed = results.filter((r) => r.ok).length;
  // Nhóm câu cùng ý: mọi câu trong nhóm phải ra cùng task
  const groups = new Map<string, Set<string>>();
  for (const r of results) {
    if (!r.route) continue;
    groups.set(r.group, (groups.get(r.group) ?? new Set()).add(r.route.task));
  }
  const inconsistent = [...groups.entries()].filter(([, tasks]) => tasks.size > 1).map(([g, t]) => `${g}: ${[...t].join(" / ")}`);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify({ passed, total: results.length, inconsistent, stopReason, results }, null, 2), "utf-8");

  console.log(`\nĐúng ${passed}/${results.length} câu.`);
  if (inconsistent.length) console.log(`Nhóm cùng ý nhưng hiểu khác nhau: ${inconsistent.join(" | ")}`);
  if (stopReason) console.log(`Dừng sớm: ${stopReason}`);
  console.log(`Kết quả đầy đủ: ${OUTPUT_PATH}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", (err as Error).message || err);
  process.exit(1);
});

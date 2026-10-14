import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";
import { readLog, LOG_DIR, type FeedbackRecord, type InteractionRecord } from "./interactionLog.js";

/**
 * Báo cáo phản hồi của người dùng: câu nào bị 👎, bot đã hiểu câu đó thế nào, trả lời gì.
 *   npm run feedback:report          (30 ngày gần nhất)
 *   npm run feedback:report -- 7     (7 ngày)
 * Trên server: docker compose ... exec backend npm run feedback:report
 * Ghi ra <STATE_DIR>/feedback-report.md. Cuối báo cáo có sẵn mẫu để thêm các câu bị hiểu sai vào
 * src/knowledge/router-examples.json (sửa "route" cho đúng trước khi thêm).
 */

const OUTPUT_PATH = path.join(config.stateDir, "feedback-report.md");
const ANSWER_EXCERPT_CHARS = 400;

const oneLine = (text: string, max: number) => {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

async function main() {
  const days = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 30;
  const [interactions, feedback] = await Promise.all([
    readLog<InteractionRecord>("interactions", days),
    readLog<FeedbackRecord>("feedback", days),
  ]);

  // Một câu trả lời có thể được bấm nhiều lần: lấy lần cuối
  const ratingById = new Map<string, FeedbackRecord>();
  for (const f of feedback) ratingById.set(f.id, f);
  const byId = new Map(interactions.map((i) => [i.id, i]));

  const taskOf = (i?: InteractionRecord) => ((i?.route as any)?.task as string) ?? "(không rõ)";
  const stats = new Map<string, { total: number; up: number; down: number }>();
  for (const i of interactions) {
    const s = stats.get(taskOf(i)) ?? { total: 0, up: 0, down: 0 };
    s.total++;
    const r = ratingById.get(i.id)?.rating;
    if (r === "up") s.up++;
    if (r === "down") s.down++;
    stats.set(taskOf(i), s);
  }

  const fallbackCount = interactions.filter((i) => (i.route as any)?.source === "heuristic").length;
  const errors = interactions.filter((i) => i.error);
  const downs = [...ratingById.values()]
    .filter((f) => f.rating === "down")
    .sort((a, b) => b.at.localeCompare(a.at));

  const lines: string[] = [];
  lines.push(`# Báo cáo phản hồi (${days} ngày gần nhất)`, "");
  lines.push(`- Câu hỏi: ${interactions.length}`);
  lines.push(`- 👍 ${[...ratingById.values()].filter((f) => f.rating === "up").length} · 👎 ${downs.length}`);
  lines.push(`- Bước hiểu câu hỏi lỗi, phải dùng từ khóa dự phòng: ${fallbackCount}`);
  lines.push(`- Câu trả lời bị lỗi: ${errors.length}`, "");

  lines.push("## Theo loại câu hỏi", "", "| Loại | Số câu | 👍 | 👎 |", "|---|---|---|---|");
  for (const [task, s] of [...stats.entries()].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${task} | ${s.total} | ${s.up} | ${s.down} |`);
  }
  lines.push("");

  lines.push(`## Câu bị 👎 (${downs.length})`, "");
  for (const f of downs) {
    const i = byId.get(f.id);
    lines.push(`### ${i ? oneLine(i.query, 150) : `(không tìm thấy câu hỏi ${f.id})`}`);
    lines.push(`- Lúc: ${f.at.slice(0, 16).replace("T", " ")} (UTC)`);
    if (f.comment) lines.push(`- Người dùng ghi: ${oneLine(f.comment, 300)}`);
    if (i) {
      const route = i.route as any;
      lines.push(`- Bot hiểu là: \`${route?.task ?? "?"}\`${route?.source === "heuristic" ? " (dự phòng từ khóa)" : ""}, câu tìm kiếm: "${oneLine(route?.standaloneQuery ?? "", 150)}"`);
      if (route?.departments?.length) lines.push(`- Phòng ban: ${route.departments.join(", ")}`);
      if (route?.docCodes?.length) lines.push(`- Mã tài liệu: ${route.docCodes.join(", ")}`);
      if (i.sources.length) lines.push(`- Nguồn: ${i.sources.join("; ")}`);
      lines.push(`- Trả lời: ${oneLine(i.answer, ANSWER_EXCERPT_CHARS)}`);
    }
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push(`## Câu trả lời bị lỗi (${errors.length})`, "");
    for (const i of errors.slice(-20).reverse()) lines.push(`- ${oneLine(i.query, 120)} → ${oneLine(i.error ?? "", 200)}`);
    lines.push("");
  }

  // Mẫu để thêm vào bộ ví dụ: route là cách bot ĐÃ hiểu (đang sai) → sửa lại cho đúng rồi mới thêm
  const templates = downs
    .map((f) => byId.get(f.id))
    .filter((i): i is InteractionRecord => !!i && i.historyTurns === 0)
    .map((i) => {
      const r = i.route as any;
      const route = Object.fromEntries(
        Object.entries({
          task: r?.task,
          departments: r?.departments?.length ? r.departments : undefined,
          doc_codes: r?.docCodes?.length ? r.docCodes : undefined,
          doc_types: r?.task === "doc_inventory" ? r?.docTypes : undefined,
          list: r?.task === "doc_inventory" ? r?.wantsList : undefined,
          topic: r?.task === "overlap_check" ? r?.topic : undefined,
        }).filter(([, v]) => v !== undefined)
      );
      return `  ${JSON.stringify({ q: i.query, route })},`;
    });
  if (templates.length > 0) {
    lines.push(
      "## Mẫu thêm vào src/knowledge/router-examples.json",
      "",
      "\"route\" dưới đây là cách bot đã hiểu (có thể đang sai): sửa cho đúng rồi mới thêm, sau đó chạy `npm run eval:router`.",
      "",
      "```json",
      ...templates,
      "```",
      ""
    );
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, lines.join("\n"), "utf-8");

  console.log(lines.slice(0, 6).join("\n"));
  console.log(`\nĐọc nhật ký từ: ${LOG_DIR}`);
  console.log(`Báo cáo đầy đủ: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("❌", (err as Error).message || err);
  process.exit(1);
});

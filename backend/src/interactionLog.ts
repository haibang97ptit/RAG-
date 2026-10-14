import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";

/**
 * Nhật ký câu hỏi và phản hồi 👍/👎, mỗi dòng một bản ghi JSON, tách file theo tháng:
 *   <STATE_DIR>/logs/interactions-2026-10.jsonl, feedback-2026-10.jsonl
 * Dùng để tìm câu bot trả lời sai (npm run feedback:report) và bổ sung vào bộ ví dụ / bộ câu đo.
 * Lỗi ghi nhật ký không được làm hỏng câu trả lời → chỉ cảnh báo.
 */

export const LOG_DIR = path.join(config.stateDir, "logs");
const ANSWER_LOG_CHARS = 3000;

export interface InteractionRecord {
  id: string;
  at: string;
  query: string;
  historyTurns: number;
  intent: string;
  route: unknown;
  answer: string;
  sources: string[];
  ms: number;
  error?: string;
}

export interface FeedbackRecord {
  id: string;
  at: string;
  rating: "up" | "down";
  comment?: string;
}

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

async function append(kind: "interactions" | "feedback", record: object): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(path.join(LOG_DIR, `${kind}-${monthOf(new Date())}.jsonl`), JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    console.warn(`Không ghi được nhật ký ${kind}:`, (err as Error).message);
  }
}

export function logInteraction(record: Omit<InteractionRecord, "at">): Promise<void> {
  return append("interactions", {
    ...record,
    at: new Date().toISOString(),
    answer: record.answer.slice(0, ANSWER_LOG_CHARS),
  });
}

export function logFeedback(record: Omit<FeedbackRecord, "at">): Promise<void> {
  return append("feedback", { ...record, at: new Date().toISOString() });
}

/** Đọc mọi bản ghi của một loại trong N ngày gần đây. */
export async function readLog<T extends { at: string }>(kind: "interactions" | "feedback", days: number): Promise<T[]> {
  const since = Date.now() - days * 86400000;
  let files: string[] = [];
  try {
    files = (await fs.readdir(LOG_DIR)).filter((f) => f.startsWith(`${kind}-`) && f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(LOG_DIR, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as T;
        if (Date.parse(record.at) >= since) records.push(record);
      } catch {
        // dòng hỏng (vd ghi dở khi server tắt) → bỏ qua
      }
    }
  }
  return records;
}

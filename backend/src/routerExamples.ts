import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { embedQuery } from "./embedding.js";

/**
 * Ví dụ đã kiểm chứng cho bước hiểu câu hỏi: với mỗi câu hỏi, chọn vài ví dụ GIỐNG NHẤT đưa vào prompt.
 * Model học theo ví dụ sát tình huống tốt hơn nhiều so với đọc quy tắc chung.
 *
 * Bổ sung ví dụ: thêm vào src/knowledge/router-examples.json (lấy từ các câu bot hiểu sai trong
 * báo cáo phản hồi - npm run feedback:report), rồi chạy npm run eval:router để chắc không làm sai câu khác.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_PATH = path.join(__dirname, "knowledge", "router-examples.json");
const DEFAULT_COUNT = 6;

export interface RouterExample {
  q: string;
  context?: string; // tóm tắt lịch sử nếu ví dụ là câu tiếp nối
  route: Record<string, unknown>;
}

let loaded: Promise<{ examples: RouterExample[]; vectors: number[][] }> | null = null;

async function load() {
  const examples = JSON.parse(await fs.readFile(EXAMPLES_PATH, "utf-8")) as RouterExample[];
  const vectors: number[][] = [];
  for (const e of examples) vectors.push(await embedQuery(e.q));
  return { examples, vectors };
}

const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const normalizeQuestion = (q: string) => q.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Các ví dụ giống câu hỏi nhất. Lỗi (chưa nạp model embedding, file hỏng) → [] để bước hiểu câu hỏi
 * vẫn chạy với các ví dụ chung trong prompt.
 * @param holdOut bỏ ví dụ trùng nguyên văn câu hỏi (dùng khi đo, để không "chép đáp án")
 */
export async function similarExamples(query: string, count = DEFAULT_COUNT, holdOut = false): Promise<RouterExample[]> {
  try {
    loaded ??= load();
    const { examples, vectors } = await loaded;
    const queryVector = await embedQuery(query);
    const normalized = normalizeQuestion(query);
    return examples
      .map((example, i) => ({ example, score: dot(queryVector, vectors[i]) }))
      .filter(({ example }) => !holdOut || normalizeQuestion(example.q) !== normalized)
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(({ example }) => example);
  } catch (err) {
    loaded = null; // thử lại ở lần sau (vd model embedding chưa nạp xong)
    console.warn("Không chọn được ví dụ cho bước hiểu câu hỏi:", (err as Error).message);
    return [];
  }
}

export function formatExamples(examples: RouterExample[]): string {
  if (examples.length === 0) return "";
  return `VÍ DỤ ĐÃ KIỂM CHỨNG GẦN GIỐNG CÂU HỎI NÀY (các trường không ghi là giá trị mặc định):\n${examples
    .map((e) => `${e.context ? `[Lịch sử: ${e.context}] ` : ""}"${e.q}" → ${JSON.stringify(e.route)}`)
    .join("\n")}`;
}

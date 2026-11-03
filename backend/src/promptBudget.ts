import type { ChatMessage } from "./llmService.js";

/**
 * Giữ mỗi lần gọi LLM trả lời trong giới hạn token của Groq (gói miễn phí: 8.000 token/phút cho MỘT yêu cầu,
 * tính cả chỗ dành cho câu trả lời). Vượt giới hạn thì Groq từ chối hẳn (lỗi 413) nên phải cắt TRƯỚC khi gửi.
 *
 * Thứ tự cắt theo độ gần (câu hỏi nối tiếp hầu như chỉ hỏi về lượt ngay trước; đoạn tài liệu quyết định câu trả lời
 * đúng hay sai nên chỉ bớt khi thật cần):
 *   1. bỏ tin nhắn cũ, giữ lượt hỏi đáp gần nhất
 *   2. rút gọn câu trả lời gần nhất nếu quá dài (giữ HISTORY_ANSWER_CHARS ký tự đầu)
 *   3. bớt đoạn tài liệu ít liên quan nhất (đoạn cuối danh sách), còn tối thiểu MIN_CHUNKS
 *   4. giảm chỗ dành cho câu trả lời
 *   5. vẫn vượt: bỏ nốt lượt gần nhất, rồi bớt đoạn tài liệu tới LAST_RESORT_CHUNKS
 * Câu hỏi hiện tại (tin nhắn cuối) không bao giờ bị cắt.
 */

// Ước lượng thô: tiếng Việt / tiếng Anh lẫn bảng ~3 ký tự một token. Ước lượng sai thì Groq vẫn từ chối và báo
// đúng số token đã gửi → lần gửi lại thu nhỏ theo đúng tỉ lệ đó (xem tooLargeRetryScale).
const CHARS_PER_TOKEN = 3;
const SAFETY = 0.95; // chừa lề cho phần Groq tự thêm (định dạng tin nhắn...)
const MESSAGE_OVERHEAD_TOKENS = 4;
const KEEP_RECENT_MESSAGES = 2; // lượt hỏi đáp gần nhất (câu hỏi + câu trả lời)
const HISTORY_ANSWER_CHARS = 3000; // câu trả lời gần nhất quá dài thì giữ phần đầu
const MIN_CHUNKS = 5;
const LAST_RESORT_CHUNKS = 3;
const MIN_ANSWER_TOKENS = 1024;

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface BudgetInput {
  prompt: string;
  messages: ChatMessage[]; // lịch sử + câu hỏi hiện tại (tin nhắn cuối)
  maxTokens: number;
  // Dựng lại prompt chỉ với `keep` đoạn tài liệu đầu tiên (đoạn xếp theo mức liên quan giảm dần)
  shrinkPrompt?: (keep: number) => string;
  chunkCount?: number;
}

export interface BudgetResult {
  prompt: string;
  messages: ChatMessage[];
  maxTokens: number;
  trimmed: string[]; // đã cắt những gì (ghi log)
}

/**
 * @param limitTokens giới hạn token của một yêu cầu (LLM_TOKEN_LIMIT)
 * @param scale < 1 khi gửi lại sau lỗi 413: thu nhỏ ngân sách theo tỉ lệ vượt mà Groq báo
 */
export function fitToTokenLimit(input: BudgetInput, limitTokens: number, scale = 1): BudgetResult {
  const budget = Math.floor(limitTokens * SAFETY * scale);
  let prompt = input.prompt;
  let maxTokens = input.maxTokens;
  const current = input.messages[input.messages.length - 1];
  let history = input.messages.slice(0, -1);
  const trimmed: string[] = [];

  const need = () =>
    estimateTokens(prompt) +
    [...history, current].filter(Boolean).reduce((sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS, 0) +
    maxTokens;

  // 1. Bỏ tin nhắn cũ, giữ lượt hỏi đáp gần nhất
  const dropOldest = (keepLast: number) => {
    let dropped = 0;
    while (need() > budget && history.length > keepLast) {
      history.shift();
      dropped++;
    }
    return dropped;
  };
  const droppedOld = dropOldest(KEEP_RECENT_MESSAGES);
  if (droppedOld > 0) trimmed.push(`bỏ ${droppedOld} tin nhắn cũ`);

  // 2. Rút gọn câu trả lời gần nhất nếu quá dài
  if (need() > budget) {
    let shortened = 0;
    history = history.map((m) => {
      if (m.role !== "assistant" || m.content.length <= HISTORY_ANSWER_CHARS) return m;
      shortened++;
      return { ...m, content: `${m.content.slice(0, HISTORY_ANSWER_CHARS)}… (đã rút gọn)` };
    });
    if (shortened > 0) trimmed.push("rút gọn câu trả lời gần nhất");
  }

  // 3. Bớt đoạn tài liệu ít liên quan nhất (prompt xếp đoạn theo mức liên quan giảm dần)
  let keep = input.chunkCount ?? 0;
  const shrinkChunks = (min: number) => {
    if (!input.shrinkPrompt) return;
    while (need() > budget && keep > min) {
      keep--;
      prompt = input.shrinkPrompt(keep);
    }
  };
  shrinkChunks(MIN_CHUNKS);

  // 4. Giảm chỗ dành cho câu trả lời
  if (need() > budget && maxTokens > MIN_ANSWER_TOKENS) {
    const before = maxTokens;
    maxTokens = Math.max(MIN_ANSWER_TOKENS, maxTokens - (need() - budget));
    trimmed.push(`giảm chỗ trả lời ${before} → ${maxTokens} token`);
  }

  // 5. Vẫn vượt: bỏ nốt lượt gần nhất, rồi bớt đoạn tài liệu tới mức tối thiểu
  const droppedRecent = dropOldest(0);
  if (droppedRecent > 0) trimmed.push("bỏ cả lượt hỏi đáp gần nhất");
  shrinkChunks(LAST_RESORT_CHUNKS);
  if (input.chunkCount && keep < input.chunkCount) trimmed.push(`còn ${keep}/${input.chunkCount} đoạn tài liệu`);

  return { prompt, messages: [...history, current].filter(Boolean), maxTokens, trimmed };
}

/**
 * Groq từ chối vì yêu cầu quá lớn (413 "Request too large ... Limit 8000, Requested 9358") → tỉ lệ thu nhỏ cho
 * lần gửi lại; không phải lỗi này → null. Không đọc được con số thì thu nhỏ còn 60%.
 */
export function tooLargeRetryScale(err: unknown): number | null {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? "";
  if (status !== 413 && !/request too large|reduce your message size/i.test(message)) return null;
  const m = message.match(/Limit (\d+), Requested (\d+)/i);
  if (!m) return 0.6;
  const [limit, requested] = [Number(m[1]), Number(m[2])];
  return Math.min(0.9, (limit / Math.max(requested, 1)) * 0.9);
}

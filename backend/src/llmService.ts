import Groq from "groq-sdk";
import { config } from "./config.js";
import type { SearchResult } from "./qdrantService.js";

let groqClient: Groq | null = null;

function getGroq(): Groq {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: config.groqApiKey });
  }
  return groqClient;
}

export type Intent = "NEW_QUESTION" | "FOLLOW_UP" | "CHITCHAT";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Phân loại intent của câu hỏi dựa vào history
 * Dùng model nhẹ (gpt-oss-20b) cho tiết kiệm token
 */
export async function classifyIntent(
  userMessage: string,
  history: ChatMessage[]
): Promise<Intent> {
  // Nếu không có history → chắc chắn là NEW_QUESTION
  if (history.length === 0) return "NEW_QUESTION";

  const recentHistory = history.slice(-4);
  const historyText = recentHistory
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const systemPrompt = `Bạn là bộ phân loại intent cho hệ thống RAG tiếng Việt.
Phân loại tin nhắn user vào 1 trong 3 loại:

1. NEW_QUESTION: Câu hỏi MỚI về nội dung tài liệu SOP (quy trình, hướng dẫn, policy...)
   Ví dụ: "Quy trình xin nghỉ phép?", "Thiết bị nào cần đồng bộ thời gian?"

2. FOLLOW_UP: Câu hỏi tiếp nối chủ đề cuộc trò chuyện trước đó
   Ví dụ: "Chi tiết hơn", "Còn gì nữa không?", "Liệt kê danh sách", "Giải thích thêm", "Tại sao?"

3. CHITCHAT: Chào hỏi, cảm ơn, tán gẫu, câu hỏi không liên quan tài liệu
   Ví dụ: "Xin chào", "Cảm ơn", "Bạn tên gì?", "Hôm nay thế nào?"

CHỈ trả lời DUY NHẤT 1 từ: NEW_QUESTION hoặc FOLLOW_UP hoặc CHITCHAT.
Không giải thích, không thêm text khác.`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Lịch sử gần đây:\n${historyText}\n\nTin nhắn mới: "${userMessage}"\n\nPhân loại:`,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const result = response.choices[0]?.message?.content?.trim().toUpperCase() || "";
    if (result.includes("FOLLOW_UP") || result.includes("FOLLOWUP")) return "FOLLOW_UP";
    if (result.includes("CHITCHAT") || result.includes("CHIT_CHAT")) return "CHITCHAT";
    return "NEW_QUESTION";
  } catch (err) {
    console.warn("Intent classification failed, defaulting to NEW_QUESTION:", err);
    return "NEW_QUESTION";
  }
}

/**
 * LLM-based reranker: đánh giá độ liên quan của từng chunk với query
 * Trả về top K chunks có điểm cao nhất
 */
export async function rerankChunks(
  query: string,
  chunks: SearchResult[],
  topK: number
): Promise<SearchResult[]> {
  if (chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks;

  // Tạo list đánh số cho LLM đọc
  const chunksText = chunks
    .map((c, i) => {
      const preview = c.text.slice(0, 500).replace(/\n+/g, " ");
      return `[${i}] File: ${c.fileName}\n${preview}...`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = `Bạn là bộ đánh giá độ liên quan (relevance scorer) cho hệ thống RAG tiếng Việt.
Nhiệm vụ: Cho câu hỏi và danh sách các đoạn văn bản, chọn ra TOP ${topK} đoạn LIÊN QUAN NHẤT với câu hỏi.

QUY TẮC:
- Đọc kỹ câu hỏi để hiểu ý định
- Đánh giá độ liên quan dựa trên NỘI DUNG, không chỉ keyword
- Ưu tiên chunks có thông tin TRỰC TIẾP trả lời câu hỏi
- Nếu nhiều chunks cùng file có thông tin bổ sung, chọn chunks khác file để đa dạng
- Trả về CHÍNH XÁC JSON array các chỉ số [0-${chunks.length - 1}], KHÔNG kèm text/markdown khác

Ví dụ output: [3, 7, 1, 12, 5]`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Câu hỏi: "${query}"\n\nCác đoạn văn bản:\n\n${chunksText}\n\nTrả về JSON array top ${topK} chỉ số liên quan nhất:`,
        },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    const match = content.match(/\[[\d,\s]+\]/);
    if (!match) {
      console.warn("Reranker không trả về JSON hợp lệ, fallback top K đầu");
      return chunks.slice(0, topK);
    }

    const indices = JSON.parse(match[0]) as number[];
    const selected: SearchResult[] = [];
    const seen = new Set<number>();
    for (const idx of indices) {
      if (idx >= 0 && idx < chunks.length && !seen.has(idx)) {
        selected.push(chunks[idx]);
        seen.add(idx);
        if (selected.length >= topK) break;
      }
    }

    // Nếu reranker trả ít hơn topK, bổ sung từ top đầu
    if (selected.length < topK) {
      for (let i = 0; i < chunks.length && selected.length < topK; i++) {
        if (!seen.has(i)) {
          selected.push(chunks[i]);
          seen.add(i);
        }
      }
    }

    return selected;
  } catch (err) {
    console.warn("Rerank failed, fallback to top K vector results:", err);
    return chunks.slice(0, topK);
  }
}

/**
 * Prompt cho câu hỏi NEW_QUESTION - RAG với context từ docs
 * STRICT RULES: không mix dữ liệu giữa file, phải trích nguồn
 */
export function buildSOPSystemPrompt(contextChunks: SearchResult[]): string {
  const contextBlocks = contextChunks
    .map((c, i) => {
      const sheetInfo = c.sheetName ? ` | Sheet: ${c.sheetName}` : "";
      return `[Nguồn ${i + 1}] File: ${c.fileName} | Phòng ban: ${c.category}${sheetInfo}\n${c.text}`;
    })
    .join("\n\n═══════════════════════════════\n\n");

  return `Bạn là trợ lý AI nội bộ, trả lời câu hỏi về tài liệu SOP (Standard Operating Procedure) và dữ liệu business của công ty.

QUY TẮC NGHIÊM NGẶT:
1. CHỈ trả lời dựa trên TÀI LIỆU THAM KHẢO phía dưới - KHÔNG tự bịa thông tin
2. Nếu tài liệu KHÔNG CÓ thông tin, trả lời thẳng: "Tôi không tìm thấy thông tin về [chủ đề] trong tài liệu được cung cấp."
3. KHÔNG BAO GIỜ gộp/mix dữ liệu từ các file khác nhau. Mỗi thông tin phải trích đúng file gốc.
4. Khi trích thông tin, PHẢI ghi rõ nguồn: ví dụ "Theo file [TIME_SYNC.docx], ..." hoặc "(Nguồn: P.IT.1013-F02)"
5. Nếu 2 file có thông tin KHÁC NHAU về cùng chủ đề, trình bày RIÊNG từng file - KHÔNG tổng hợp sai
6. Trả lời bằng tiếng Việt, ngắn gọn, có cấu trúc (dùng gạch đầu dòng/bảng khi cần)
7. KHÔNG dùng emoji, KHÔNG kết câu bằng "Hy vọng giúp được bạn", "Chúc bạn thành công", v.v.
8. Khi liệt kê danh sách (thiết bị, bước, nhân sự...), trình bày đầy đủ, không bỏ sót
9. Giữ nguyên các mã số, tên viết tắt, tên thiết bị như trong tài liệu

TÀI LIỆU THAM KHẢO:
═══════════════════════════════

${contextBlocks}

═══════════════════════════════

Dựa HOÀN TOÀN vào tài liệu trên để trả lời câu hỏi của user. Luôn trích nguồn file khi đưa ra thông tin.`;
}

/**
 * Prompt cho câu hỏi FOLLOW_UP - dựa vào history + có thể dùng context mới
 */
export function buildFollowUpSystemPrompt(contextChunks: SearchResult[]): string {
  const hasContext = contextChunks.length > 0;

  const contextSection = hasContext
    ? `\n\nTÀI LIỆU BỔ SUNG (nếu cần):\n═══════════════════════════════\n\n${contextChunks
        .map(
          (c, i) =>
            `[Nguồn ${i + 1}] File: ${c.fileName}${c.sheetName ? ` | Sheet: ${c.sheetName}` : ""}\n${c.text}`
        )
        .join("\n\n═══════════════════════════════\n\n")}\n\n═══════════════════════════════`
    : "";

  return `Bạn là trợ lý AI nội bộ về tài liệu SOP công ty.

Đây là câu hỏi TIẾP NỐI từ cuộc trò chuyện trước đó. Hãy:
1. Dựa vào ngữ cảnh/câu trả lời trước để hiểu user đang hỏi gì
2. Trả lời sâu hơn/chi tiết hơn/làm rõ hơn chủ đề đang nói
3. Nếu cần dữ liệu mới, dùng TÀI LIỆU BỔ SUNG bên dưới
4. VẪN tuân thủ nguyên tắc: trích nguồn file, không bịa, không mix dữ liệu giữa file
5. Trả lời bằng tiếng Việt, ngắn gọn
6. KHÔNG dùng emoji, KHÔNG kết câu bằng "Hy vọng giúp được bạn", v.v.${contextSection}`;
}

/**
 * Prompt cho CHITCHAT - chào hỏi, tán gẫu
 */
export function buildChitChatSystemPrompt(): string {
  return `Bạn là trợ lý AI nội bộ của công ty, giúp nhân viên tra cứu tài liệu SOP.

Người dùng đang chào hỏi hoặc nói chuyện ngoài lề. Hãy:
1. Trả lời LỊCH SỰ, NGẮN GỌN (1-2 câu)
2. Nếu phù hợp, gợi ý: "Bạn có thể hỏi tôi về các quy trình, chính sách, SOP của công ty."
3. KHÔNG dùng emoji
4. Trả lời bằng tiếng Việt tự nhiên`;
}

/**
 * Stream chat completion từ Groq
 * Trả về async iterator các delta text
 */
export async function* streamChatCompletion(
  systemPrompt: string,
  messages: ChatMessage[]
): AsyncGenerator<string, void, unknown> {
  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const stream = await getGroq().chat.completions.create({
    model: config.llmModel,
    messages: chatMessages as any,
    temperature: 0.3,
    max_tokens: 2048,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

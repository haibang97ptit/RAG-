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
export type Complexity = "simple" | "complex";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// ============== INTENT CLASSIFIER (với heuristic bypass) ==============

export async function classifyIntent(
  userMessage: string,
  history: ChatMessage[]
): Promise<Intent> {
  if (history.length === 0) return "NEW_QUESTION";

  const msg = userMessage.toLowerCase().trim();
  const wordCount = msg.split(/\s+/).filter(Boolean).length;

  const metaKeywords = /\b(ngắn gọn|ngắn thôi|ngắn hơn|chi tiết hơn|chi tiết|giải thích thêm|giải thích|tóm tắt|tóm lại|cụ thể hơn|cụ thể|rõ hơn|rõ ràng hơn|ví dụ|liệt kê|dạng bảng|bảng biểu|tiếng anh|english|nguồn|file nào|mục nào|phần nào|trích dẫn|tại sao|vì sao|còn gì|còn nữa|thêm nữa|tiếp đi|tiếp theo|nói kỹ hơn|làm rõ|mở rộng|tổng hợp)\b/i;

  if (wordCount <= 12 && metaKeywords.test(msg)) {
    return "FOLLOW_UP";
  }

  const chitchatKeywords = /^(xin chào|chào|cảm ơn|thank|hello|hi|bye|tạm biệt|ok|oke|okey|yes|no|dạ|vâng|ừ)\b[\s\.\!]*$/i;
  if (chitchatKeywords.test(msg)) {
    return "CHITCHAT";
  }

  const pronounRefs = /\b(nó|cái đó|cái này|cái ấy|file đó|file này|tài liệu đó|tài liệu này|SOP đó|SOP này|đây|đó|ở trên|phía trên|vừa rồi)\b/i;
  if (wordCount <= 15 && pronounRefs.test(msg)) {
    return "FOLLOW_UP";
  }

  const recentHistory = history.slice(-4);
  const historyText = recentHistory
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const systemPrompt = `Bạn là bộ phân loại intent cho hệ thống RAG tiếng Việt.
Phân loại tin nhắn user vào 1 trong 3 loại:

1. NEW_QUESTION: Câu hỏi MỚI về nội dung SOP (quy trình, chính sách...)
2. FOLLOW_UP: Tiếp nối chủ đề trước (chi tiết hơn, đổi format, hỏi về nguồn...)
3. CHITCHAT: Chào hỏi, cảm ơn

CHỈ trả lời DUY NHẤT 1 từ: NEW_QUESTION / FOLLOW_UP / CHITCHAT.`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Lịch sử:\n${historyText}\n\nTin nhắn mới: "${userMessage}"\n\nPhân loại:`,
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
    console.warn("Intent classification failed:", err);
    return "NEW_QUESTION";
  }
}

// ============== COMPLEXITY CLASSIFIER (pure heuristic) ==============

export function classifyComplexity(query: string): Complexity {
  const msg = query.toLowerCase();
  const complexKeywords = /\b(so sánh|so với|khác nhau|khác biệt|liệt kê|list|tổng hợp|đánh giá|phân tích|chi tiết|bao gồm|gồm những|tất cả|toàn bộ|có mấy|có bao nhiêu|compare|all|both|nhiều|sao để|làm sao|cách nào|như thế nào)\b/i;
  const wordCount = query.split(/\s+/).filter(Boolean).length;

  if (complexKeywords.test(msg) || wordCount > 15) {
    return "complex";
  }
  return "simple";
}

// ============== QUERY EXPANSION ==============

export async function expandQuery(query: string): Promise<string[]> {
  const systemPrompt = `Bạn là bộ mở rộng truy vấn cho hệ thống RAG tiếng Việt về SOP công ty dược phẩm.
Cho câu hỏi của user, tạo 3 câu truy vấn BIẾN THỂ giúp tìm kiếm tốt hơn.
Các biến thể nên:
- Dùng từ đồng nghĩa / cách diễn đạt khác
- Viết đầy đủ hơn (nếu user viết tắt) hoặc ngắn gọn hơn
- Thêm context ngành (GMP, QA, QC, dược phẩm) nếu phù hợp
- Có 1 biến thể dịch sang tiếng Anh (vì tài liệu đa phần tiếng Anh)

Trả về CHÍNH XÁC JSON array 3 strings, KHÔNG giải thích, KHÔNG markdown.
Ví dụ: ["biến thể 1", "biến thể 2", "biến thể 3"]`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Câu hỏi: "${query}"\n\nTrả về JSON:` },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match) return [];

    const variants = JSON.parse(match[0]) as string[];
    return Array.isArray(variants) ? variants.filter((s) => typeof s === "string").slice(0, 3) : [];
  } catch (err) {
    console.warn("Query expansion failed:", (err as Error).message);
    return [];
  }
}

// ============== HyDE - Hypothetical Document Embeddings ==============

export async function generateHypotheticalAnswer(query: string): Promise<string> {
  const systemPrompt = `Bạn là chuyên gia tài liệu SOP công ty dược phẩm.
Cho câu hỏi, viết 1 đoạn ngắn (3-5 câu) GIẢ ĐỊNH câu trả lời theo PHONG CÁCH VĂN BẢN SOP CHÍNH THỨC.
KHÔNG dùng "có thể", "có lẽ". Viết như đang trích tài liệu thật.
Dùng tiếng Việt chuyên nghiệp + có thể lẫn 1 số thuật ngữ tiếng Anh phổ biến trong ngành.
KHÔNG thêm giải thích, chỉ viết đoạn văn.`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
      temperature: 0.1,
      max_tokens: 300,
    });
    return response.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.warn("HyDE generation failed:", (err as Error).message);
    return "";
  }
}

// ============== LLM-based RERANKER ==============

export async function rerankChunks(
  query: string,
  chunks: SearchResult[],
  topK: number
): Promise<SearchResult[]> {
  if (chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks;

  const chunksText = chunks
    .map((c, i) => {
      const preview = c.text.slice(0, 500).replace(/\n+/g, " ");
      return `[${i}] File: ${c.fileName}\n${preview}...`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = `Bạn là bộ đánh giá độ liên quan cho hệ thống RAG tiếng Việt.
Nhiệm vụ: Chọn TOP ${topK} đoạn LIÊN QUAN NHẤT với câu hỏi.

QUY TẮC:
- Đánh giá dựa trên NỘI DUNG, không chỉ keyword
- Ưu tiên chunks có thông tin TRỰC TIẾP trả lời
- Đa dạng file nếu nhiều file có thông tin bổ sung
- Trả về CHÍNH XÁC JSON array các chỉ số [0-${chunks.length - 1}], KHÔNG kèm text khác

Ví dụ output: [3, 7, 1, 12, 5]`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Câu hỏi: "${query}"\n\nCác đoạn:\n\n${chunksText}\n\nJSON top ${topK}:`,
        },
      ],
      temperature: 0,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    const match = content.match(/\[[\d,\s]+\]/);
    if (!match) return chunks.slice(0, topK);

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
    console.warn("Rerank failed:", (err as Error).message);
    return chunks.slice(0, topK);
  }
}

// ============== PROMPT BUILDERS ==============

export function buildSOPSystemPrompt(contextChunks: SearchResult[], useCoT: boolean = false): string {
  const contextBlocks = contextChunks
    .map((c, i) => {
      const sheetInfo = c.sheetName ? ` | Sheet: ${c.sheetName}` : "";
      return `[Nguồn ${i + 1}] File: ${c.fileName} | Phòng ban: ${c.category}${sheetInfo}\n${c.text}`;
    })
    .join("\n\n═══════════════════════════════\n\n");

  const cotSection = useCoT
    ? `
TRƯỚC KHI TRẢ LỜI - hãy SUY NGHĨ TỪNG BƯỚC (không in ra, chỉ nghĩ):
1. User hỏi về CHỦ ĐỀ gì? Có bao nhiêu khía cạnh cần cover?
2. Trong các NGUỒN, nguồn nào liên quan trực tiếp? Nguồn nào bổ sung?
3. Thông tin nào cần TỔNG HỢP từ nhiều file? Có xung đột không?
4. Format câu trả lời tốt nhất là gì (bullet/table/paragraph)?

Sau đó viết câu trả lời ĐẦY ĐỦ, có CẤU TRÚC, trích nguồn RÕ RÀNG.
`
    : "";

  return `Bạn là trợ lý AI nội bộ, trả lời về tài liệu SOP (Standard Operating Procedure) công ty dược phẩm.

QUY TẮC NGHIÊM NGẶT:
1. CHỈ trả lời dựa trên TÀI LIỆU THAM KHẢO phía dưới - KHÔNG tự bịa thông tin
2. Nếu tài liệu KHÔNG CÓ thông tin, trả lời thẳng: "Tôi không tìm thấy thông tin về [chủ đề] trong tài liệu được cung cấp."
3. KHÔNG BAO GIỜ gộp/mix dữ liệu từ các file khác nhau. Mỗi thông tin phải trích đúng file gốc.
4. Khi trích thông tin, PHẢI ghi rõ nguồn: "Theo file [TÊN], ..." hoặc "(Nguồn: [MÃ])"
5. Nếu 2 file có thông tin KHÁC NHAU về cùng chủ đề, trình bày RIÊNG từng file - KHÔNG tổng hợp sai
6. Trả lời bằng tiếng Việt, có cấu trúc (gạch đầu dòng/bảng khi cần)
7. KHÔNG dùng emoji, KHÔNG kết câu bằng "Hy vọng giúp được bạn", v.v.
8. Khi liệt kê (thiết bị, bước, nhân sự...), trình bày đầy đủ không bỏ sót
9. Giữ nguyên mã số, tên viết tắt, tên thiết bị như trong tài liệu
${cotSection}
TÀI LIỆU THAM KHẢO:
═══════════════════════════════

${contextBlocks}

═══════════════════════════════

Dựa HOÀN TOÀN vào tài liệu trên để trả lời. Luôn trích nguồn file khi đưa ra thông tin.`;
}

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

Đây là câu hỏi/yêu cầu TIẾP NỐI cuộc trò chuyện trước. Có 3 loại follow-up:

LOẠI 1 - LÀM RÕ / MỞ RỘNG: User muốn chi tiết hơn chủ đề đã nói.
   → Mở rộng câu trả lời trước + tài liệu bổ sung.

LOẠI 2 - ĐỔI FORMAT: User muốn trả lời lại ngắn gọn/dạng bảng/tiếng Anh.
   → GIỮ NGUYÊN NỘI DUNG CHÍNH câu trước, chỉ đổi format. KHÔNG chuyển chủ đề.

LOẠI 3 - HỎI VỀ CHI TIẾT CÂU TRƯỚC: "nguồn ở đâu", "file nào", "mục mấy".
   → Trích dẫn chính xác từ câu trả lời trước.

QUY TẮC:
1. ĐỌC KỸ câu trả lời TRƯỚC của AI để hiểu chủ đề đang nói
2. KHÔNG tự ý chuyển chủ đề nếu user chỉ yêu cầu format
3. KHÔNG trả lời "không tìm thấy" nếu chủ đề đã có trong câu trước
4. Trích nguồn file, không bịa, không mix data giữa file
5. Trả lời bằng tiếng Việt
6. KHÔNG dùng emoji, KHÔNG kết câu bằng "Hy vọng giúp được bạn", v.v.${contextSection}`;
}

export function buildChitChatSystemPrompt(): string {
  return `Bạn là trợ lý AI nội bộ của công ty, giúp nhân viên tra cứu tài liệu SOP.

Người dùng đang chào hỏi hoặc nói chuyện ngoài lề. Hãy:
1. Trả lời LỊCH SỰ, NGẮN GỌN (1-2 câu)
2. Nếu phù hợp, gợi ý: "Bạn có thể hỏi tôi về các quy trình, chính sách, SOP của công ty."
3. KHÔNG dùng emoji
4. Trả lời bằng tiếng Việt tự nhiên`;
}

// ============== STREAM CHAT ==============

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
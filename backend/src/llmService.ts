import Groq from "groq-sdk";
import { config } from "./config.js";
import type { SearchResult } from "./qdrantService.js";
import type { CatalogMatch } from "./fileCatalog.js";

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

// ============== KEYWORD MATCHING (tiếng Việt) ==============

// `\b` của JS chỉ hiểu ký tự ASCII nên sai với từ có dấu ("ví dụ" không khớp, "nói" khớp nhầm "nó").
// Dùng ranh giới từ theo Unicode: trước/sau keyword không được là chữ cái hoặc chữ số.
const WORD_START = "(?<![\\p{L}\\p{N}])";
const WORD_END = "(?![\\p{L}\\p{N}])";

function keywordRegex(alternation: string): RegExp {
  return new RegExp(`${WORD_START}(?:${alternation})${WORD_END}`, "iu");
}

// NFC để chữ có dấu gõ dạng tổ hợp (NFD) vẫn khớp keyword
function normalizeText(text: string): string {
  return text.normalize("NFC").toLowerCase().trim();
}

const META_KEYWORDS = keywordRegex(
  "ngắn gọn|ngắn thôi|ngắn hơn|chi tiết hơn|chi tiết|giải thích thêm|giải thích|tóm tắt|tóm lại|cụ thể hơn|cụ thể|rõ hơn|rõ ràng hơn|ví dụ|liệt kê|dạng bảng|bảng biểu|tiếng anh|english|nguồn|file nào|mục nào|phần nào|trích dẫn|tại sao|vì sao|còn gì|còn nữa|thêm nữa|tiếp đi|tiếp theo|nói kỹ hơn|làm rõ|mở rộng|tổng hợp"
);

// Cả tin nhắn chỉ là lời chào/cảm ơn (có thể kèm từ xưng hô: "chào bạn", "cảm ơn nhiều nhé")
const CHITCHAT_KEYWORDS = new RegExp(
  "^(?:xin chào|chào|cảm ơn|cám ơn|thanks|thank you|thank|hello|hi|bye|tạm biệt|ok|oke|okey|yes|no|dạ|vâng|ừ)" +
    "(?:\\s+(?:bạn|anh|chị|em|ad|bot|ạ|nhé|nha|nhiều|mọi người))*" +
    "[\\s.!,]*$",
  "iu"
);

// Hỏi về chính trợ lý ("bạn là ai", "bạn làm được gì") - cũng không cần chạy RAG
const ABOUT_ASSISTANT = new RegExp(
  "^(?:(?:bạn|em|mày|bot|ai|chatbot|trợ lý)\\s+)?(?:này\\s+)?" +
    "(?:là ai|là gì|tên gì|tên là gì|làm được gì|làm được những gì|có thể làm gì|giúp được gì|giúp gì được|biết làm gì|khỏe không|khoẻ không)" +
    "(?:\\s+(?:vậy|thế|nhỉ|ạ|đấy|nào))*[\\s.!?,]*$",
  "iu"
);

const PRONOUN_REFS = keywordRegex(
  "nó|cái đó|cái này|cái ấy|file đó|file này|tài liệu đó|tài liệu này|SOP đó|SOP này|đây|đó|ở trên|phía trên|vừa rồi"
);

const COMPLEX_KEYWORDS = keywordRegex(
  "so sánh|so với|khác nhau|khác biệt|liệt kê|list|tổng hợp|đánh giá|phân tích|chi tiết|bao gồm|gồm những|tất cả|toàn bộ|có mấy|có bao nhiêu|compare|all|both|nhiều|sao để|làm sao|cách nào|như thế nào"
);

// ============== INTENT CLASSIFIER (với heuristic bypass) ==============

export async function classifyIntent(
  userMessage: string,
  history: ChatMessage[]
): Promise<Intent> {
  const msg = normalizeText(userMessage);

  // Check trước cả khi history rỗng: lời chào đầu tiên không cần chạy RAG
  if (CHITCHAT_KEYWORDS.test(msg) || ABOUT_ASSISTANT.test(msg)) {
    return "CHITCHAT";
  }

  if (history.length === 0) return "NEW_QUESTION";

  const wordCount = msg.split(/\s+/).filter(Boolean).length;

  if (wordCount <= 12 && META_KEYWORDS.test(msg)) {
    return "FOLLOW_UP";
  }

  if (wordCount <= 15 && PRONOUN_REFS.test(msg)) {
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
  const msg = normalizeText(query);
  const wordCount = msg.split(/\s+/).filter(Boolean).length;

  if (COMPLEX_KEYWORDS.test(msg) || wordCount > 15) {
    return "complex";
  }
  return "simple";
}

// ============== OVERVIEW QUESTION (pure heuristic) ==============

const OVERVIEW_KEYWORDS = keywordRegex(
  "nội dung|tóm tắt|tóm lược|tổng quan|khái quát|giới thiệu|nói về gì|nói về cái gì|là gì|mục đích|phạm vi|overview|summary|summarize"
);

/** Câu hỏi về tổng thể một tài liệu ("nội dung SOP IT 1012", "SOP 0005 nói về gì"). */
export function isOverviewQuestion(query: string): boolean {
  return OVERVIEW_KEYWORDS.test(normalizeText(query));
}

// ============== FOLLOW-UP QUERY REWRITE ==============

/**
 * Câu follow-up ("ngắn gọn hơn", "nó áp dụng cho ai?") không tự mang chủ đề,
 * embed nguyên văn sẽ tìm ra chunk không liên quan. Viết lại thành truy vấn độc lập
 * dựa trên lịch sử để retrieval bám đúng chủ đề đang nói.
 * Lỗi / output bất thường → trả về câu gốc.
 */
export async function rewriteFollowUpQuery(
  userMessage: string,
  history: ChatMessage[]
): Promise<string> {
  if (history.length === 0) return userMessage;

  const historyText = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content.slice(0, 600)}`)
    .join("\n");

  const systemPrompt = `Bạn viết lại câu hỏi cho hệ thống tìm kiếm tài liệu SOP tiếng Việt.
Dựa vào lịch sử hội thoại, viết lại tin nhắn mới nhất của user thành MỘT câu truy vấn ĐỘC LẬP, nêu đủ chủ đề, dùng để tìm tài liệu.

QUY TẮC:
- Thay đại từ (nó, cái đó, file đó, ở trên...) bằng đối tượng cụ thể trong lịch sử
- Nếu user chỉ yêu cầu đổi cách trình bày (ngắn gọn, chi tiết hơn, dạng bảng, tiếng Anh, cho ví dụ...) thì truy vấn là CHỦ ĐỀ đang được nói tới, BỎ phần yêu cầu trình bày
- Nếu tin nhắn mới đã đủ rõ, không phụ thuộc lịch sử thì giữ nguyên
- Giữ nguyên mã số, tên viết tắt, tên thiết bị
- KHÔNG trả lời câu hỏi. CHỈ trả về câu truy vấn trên 1 dòng, không giải thích, không ngoặc kép.`;

  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Lịch sử:\n${historyText}\n\nTin nhắn mới: "${userMessage}"\n\nTruy vấn độc lập:`,
        },
      ],
      temperature: 0,
      max_tokens: 400,
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    const rewritten = content.split("\n")[0].replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!rewritten || rewritten.length > 500) return userMessage;
    return rewritten;
  } catch (err) {
    console.warn("Follow-up rewrite failed:", (err as Error).message);
    return userMessage;
  }
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
- Nếu câu hỏi nhắc mã tài liệu (kể cả gọi tắt như "SOP 0005", "SOP QA 0005"), ưu tiên đoạn thuộc file có mã đó trong tên
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

// Câu trả lời hiển thị trong cửa sổ chat hẹp (~400px), render markdown.
const FORMAT_RULES = `CÁCH TRÌNH BÀY (câu trả lời hiển thị trong cửa sổ chat HẸP):
- Mở đầu bằng 1-2 câu trả lời thẳng vào câu hỏi, rồi mới tới chi tiết
- Ưu tiên tiêu đề ngắn + gạch đầu dòng; các bước tuần tự dùng danh sách đánh số (1. 2. 3.)
- CHỈ dùng bảng khi dữ liệu thật sự dạng bảng, tối đa 3 cột, nội dung mỗi ô ngắn (vài từ). Nội dung dài hoặc nhiều ý trong một ô → dùng gạch đầu dòng thay cho bảng
- KHÔNG dùng thẻ HTML (<br>, <b>...), KHÔNG lồng danh sách trong ô bảng
- Chỉ in đậm thuật ngữ / mã quan trọng, không in đậm cả câu`;

const VOICE_RULES = `GIỌNG VĂN:
- Nói chuyện tự nhiên như một đồng nghiệp am hiểu quy trình đang giải thích cho người hỏi; xưng "tôi", gọi người dùng là "bạn"
- Câu ngắn, rõ, đời thường. Không rập khuôn, không lặp lại câu hỏi, không mở đầu kiểu "Dựa trên tài liệu được cung cấp..." hay "Theo các nguồn tham khảo..."
- Tự nhiên trong cách diễn đạt nhưng CHÍNH XÁC về nội dung: số liệu, mã, tên thiết bị, các bước giữ đúng như tài liệu
- KHÔNG dùng emoji, KHÔNG kết bằng câu xã giao kiểu "Hy vọng giúp được bạn"`;

/**
 * Danh sách tên file có mã khớp với câu hỏi. Đoạn trích chỉ là vài phần giống câu hỏi nhất,
 * nên muốn đếm/liệt kê tài liệu thì LLM phải dựa vào danh sách này.
 */
function buildCatalogSection(catalog: CatalogMatch | null): string {
  if (!catalog) return "";

  const lines = catalog.files.map((f) => `- ${f.fileName} (Phòng ban: ${f.category})`).join("\n");
  const truncated =
    catalog.total > catalog.files.length
      ? `\n(Chỉ hiển thị ${catalog.files.length}/${catalog.total} file - khi trả lời phải nói rõ tổng số là ${catalog.total} và danh sách chưa đầy đủ)`
      : "";

  return `
DANH MỤC FILE có mã khớp với câu hỏi - ${catalog.total} file, lấy từ TÊN FILE trong hệ thống:
${lines}${truncated}

CÁCH DÙNG DANH MỤC FILE:
- User thường GỌI TẮT mã tài liệu: "SOP 0005", "SOP QA 0005", "SOP-GEN 0005 QA" đều chỉ cùng một SOP. Các file trong danh mục chính là tài liệu user đang nhắc tới - hãy hiểu câu hỏi là về (các) tài liệu này và gọi đúng mã đầy đủ khi trả lời. KHÔNG trả lời "không tìm thấy SOP 0005" khi danh mục có file khớp.
- Khi user hỏi NỘI DUNG / TÓM TẮT / "nói về gì" của một SOP trong danh mục: tóm tắt từ các đoạn trích thuộc SOP đó (mục đích, phạm vi, trách nhiệm, các bước chính - có gì nêu nấy) và ghi rõ đây là tóm tắt từ phần đầu tài liệu, chưa phải toàn văn. Chỉ trả lời "không tìm thấy" khi KHÔNG có đoạn trích nào thuộc SOP đó.
- Nếu danh mục chứa nhiều SOP KHÁC NHAU trùng số (khác phòng ban hoặc khác nhóm mã), nói rõ có những SOP nào và trả lời riêng cho từng SOP.
- Khi user hỏi CÓ BAO NHIÊU / LIỆT KÊ tài liệu, biểu mẫu, phụ lục của một SOP: đếm và liệt kê theo DANH MỤC FILE này. KHÔNG đếm theo số đoạn trích bên dưới - đoạn trích chỉ là một phần nhỏ.
- Phân nhóm theo ký hiệu trong tên file: -Fxx (F01, F02...) = biểu mẫu (Format), -Axx (A01, A02...) = phụ lục (Appendix), file không có ký hiệu F/A là SOP chính. Khi đếm biểu mẫu chỉ đếm file -Fxx, khi đếm phụ lục chỉ đếm file -Axx.
- Danh mục chỉ cho biết file nào TỒN TẠI. Nội dung bên trong file vẫn phải lấy từ TÀI LIỆU THAM KHẢO.
`;
}

export function buildSOPSystemPrompt(
  contextChunks: SearchResult[],
  useCoT: boolean = false,
  catalog: CatalogMatch | null = null
): string {
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
2. Nếu tài liệu KHÔNG CÓ thông tin để trả lời, xử lý theo loại câu hỏi:
   a) Câu hỏi về SOP / quy trình / công việc của công ty: nói ngắn gọn, tự nhiên rằng bạn không tìm thấy nội dung này trong các tài liệu SOP hiện có, rồi gợi ý người dùng nêu mã SOP hoặc mô tả cụ thể hơn. KHÔNG bịa, KHÔNG suy đoán.
   b) Câu hỏi KHÔNG liên quan tới SOP hay công việc (trò chuyện, hỏi về bạn, thời tiết, kiến thức chung...): đáp lại ngắn gọn, thân thiện trong 1-3 câu như một trợ lý bình thường, rồi cho biết bạn là trợ lý tra cứu SOP nên chỉ hỗ trợ được các câu hỏi về quy trình, tài liệu của công ty. KHÔNG trích nguồn, KHÔNG nhắc tới "tài liệu được cung cấp".
   Trong mọi trường hợp: thông tin chuyên môn (dược, GMP, kỹ thuật, quy định) CHỈ được lấy từ tài liệu - không trả lời bằng kiến thức riêng, kể cả khi bạn biết.
3. KHÔNG BAO GIỜ gộp/mix dữ liệu từ các file khác nhau. Mỗi thông tin phải trích đúng file gốc.
4. Khi trích thông tin, PHẢI ghi rõ nguồn bằng TÊN FILE hoặc MÃ tài liệu: "Theo file [TÊN], ..." hoặc "(Nguồn: [MÃ])". KHÔNG ghi "Nguồn 1", "Nguồn 5" - user không nhìn thấy số thứ tự nguồn
5. Nếu 2 file có thông tin KHÁC NHAU về cùng chủ đề, trình bày RIÊNG từng file - KHÔNG tổng hợp sai
6. Trả lời bằng tiếng Việt, có cấu trúc
7. Khi liệt kê (thiết bị, bước, nhân sự...), trình bày đầy đủ không bỏ sót
8. Giữ nguyên mã số, tên viết tắt, tên thiết bị như trong tài liệu

${VOICE_RULES}

${FORMAT_RULES}
${cotSection}${buildCatalogSection(catalog)}
TÀI LIỆU THAM KHẢO:
═══════════════════════════════

${contextBlocks}

═══════════════════════════════

Dựa HOÀN TOÀN vào tài liệu trên để trả lời. Luôn trích nguồn file khi đưa ra thông tin.`;
}

export function buildFollowUpSystemPrompt(
  contextChunks: SearchResult[],
  catalog: CatalogMatch | null = null
): string {
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
4. Trích nguồn bằng TÊN FILE hoặc MÃ tài liệu (KHÔNG ghi "Nguồn 1", "Nguồn 5" - user không nhìn thấy số thứ tự nguồn), không bịa, không mix data giữa file
5. Trả lời bằng tiếng Việt

${VOICE_RULES}

${FORMAT_RULES}
${buildCatalogSection(catalog)}${contextSection}`;
}

export function buildChitChatSystemPrompt(): string {
  return `Bạn là trợ lý AI nội bộ của công ty, giúp nhân viên tra cứu tài liệu SOP.

Người dùng đang chào hỏi, cảm ơn, hỏi về bạn hoặc nói chuyện ngoài lề. Hãy:
1. Đáp lại tự nhiên, thân thiện như một đồng nghiệp, NGẮN GỌN (1-2 câu); xưng "tôi", gọi người dùng là "bạn". Đáp đúng vào điều người dùng vừa nói, không dùng một câu mẫu cho mọi trường hợp.
2. Nếu được hỏi bạn là ai / làm được gì: bạn là trợ lý tra cứu SOP nội bộ - tìm và giải thích quy trình, biểu mẫu, phụ lục; người dùng có thể hỏi theo nội dung hoặc theo mã SOP.
3. Chỉ gợi ý hỏi về SOP khi hợp ngữ cảnh (ví dụ lời chào đầu tiên), không lặp lại ở mọi câu.
4. Câu hỏi kiến thức ngoài phạm vi SOP (thời tiết, tin tức, kiến thức chung, chuyên môn dược...): nói nhẹ nhàng rằng bạn chỉ hỗ trợ tra cứu SOP, không tự trả lời bằng kiến thức riêng.
5. KHÔNG dùng emoji. Trả lời bằng tiếng Việt.`;
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
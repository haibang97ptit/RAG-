import Groq from "groq-sdk";
import { config } from "./config.js";
import type { SearchResult } from "./qdrantService.js";
import type { CatalogMatch } from "./fileCatalog.js";
import type { OverlapContext } from "./overlapFinder.js";

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

// ============== OVERLAP / COMPARE QUESTION (pure heuristic) ==============

// Nói rõ về trùng lặp / chồng chéo giữa các tài liệu, hoặc hỏi một việc được quy định ở những tài liệu nào
const OVERLAP_KEYWORDS = keywordRegex(
  "trùng lặp|trùng nhau|trùng với|bị trùng|chồng chéo|mâu thuẫn với|mâu thuẫn nhau|mâu thuẫn giữa|hợp nhất|gom về|gộp chung|những sop nào|các sop nào|những tài liệu nào|các tài liệu nào|những quy trình nào|overlap|overlapping|duplicate|duplicated"
);

// Câu hỏi phải đang nói về tài liệu / quy định, để "mẫu bị trùng lặp thì xử lý thế nào" không bị coi là rà SOP
const DOCUMENT_WORDS = keywordRegex("sop|tài liệu|quy trình|quy định|chính sách|document|procedure|policy");

// Ý so sánh chung chung: chỉ tính khi câu hỏi nêu từ 2 mã tài liệu trở lên
const COMPARE_KEYWORDS = keywordRegex(
  "so sánh|đối chiếu|giống nhau|khác nhau|khác gì|điểm chung|điểm khác|compare|comparison"
);

export function isOverlapQuestion(query: string): boolean {
  const text = normalizeText(query);
  return OVERLAP_KEYWORDS.test(text) && DOCUMENT_WORDS.test(text);
}

export function isCompareQuestion(query: string): boolean {
  return COMPARE_KEYWORDS.test(normalizeText(query));
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

const OVERLAP_COMMON_RULES = `QUY TẮC:
- CHỈ dựa trên các đoạn trích ở trên. KHÔNG bịa nội dung, không suy đoán phần tài liệu bạn không được thấy.
- Giữ nguyên con số, đơn vị, mã tài liệu, tên thiết bị như trong đoạn trích. Khi nêu nội dung của tài liệu nào, ghi rõ TÊN FILE hoặc MÃ của tài liệu đó.
- Hai đoạn được coi là CÙNG QUY ĐỊNH khi chúng điều chỉnh cùng một việc / chính sách, dù tên mục, cách diễn đạt hay ngôn ngữ (Việt - Anh) khác nhau.
- BỎ QUA phần giống nhau chỉ vì cùng khuôn mẫu SOP (mục đích, phạm vi, định nghĩa, trách nhiệm chung, tài liệu tham khảo, lịch sử sửa đổi, bảng ký duyệt, tiêu đề). Không liệt kê những gì bị bỏ qua.
- Phần đề xuất là GỢI Ý của bạn, không phải nội dung có trong SOP: luôn đặt dưới tiêu đề "Đề xuất" và nói rõ cần chủ quy trình / QA xem xét.
- Trả lời bằng tiếng Việt.`;

const OVERLAP_REPORT_FORMAT = `Với MỖI quy định trùng lặp, trình bày đúng các ý sau:
- **Tên quy định** (bạn đặt tên ngắn gọn, vd "Chính sách mật khẩu")
- Từng tài liệu quy định gì (nêu tên mục nếu thấy trong đoạn trích)
- Điểm GIỐNG nhau
- Điểm KHÁC nhau hoặc MÂU THUẪN cụ thể: con số, tần suất, thời hạn, người chịu trách nhiệm. Nếu nội dung như nhau thì nói rõ là không mâu thuẫn, chỉ lặp lại.
- Đề xuất: nên giữ quy định đầy đủ ở tài liệu nào (tài liệu có chủ đề chính gần với quy định đó nhất) và lý do; tài liệu còn lại nên bỏ phần chi tiết, thay bằng một câu tham chiếu. Viết luôn câu tham chiếu gợi ý. Nếu hai bên đang mâu thuẫn, nêu rõ cần thống nhất giá trị nào trước khi gom.`;

/** Prompt rà quy định trùng lặp từ các CẶP ĐOẠN gần nghĩa nhất giữa tài liệu A và B. */
function buildOverlapPairsPrompt(ctx: OverlapContext): string {
  const block = (tag: string, c: OverlapContext["pairs"][number]["a"]) =>
    `[${tag}] File: ${c.fileName} | Phòng ban: ${c.category}\n${c.text}`;

  const pairsText =
    ctx.pairs.length > 0
      ? ctx.pairs
          .map((p, i) => `--- CẶP ${i + 1} ---\n${block("A", p.a)}\n\n${block("B", p.b)}`)
          .join("\n\n")
      : "(Không có cặp đoạn nào đủ gần nhau về nội dung.)";

  return `Bạn là trợ lý rà soát tài liệu SOP của công ty dược. Nhiệm vụ: phát hiện QUY ĐỊNH TRÙNG LẶP giữa các SOP và đề xuất gom về một nơi để mỗi chính sách chỉ được quy định ở MỘT tài liệu.

A = ${ctx.labelA}
B = ${ctx.labelB}

Dưới đây là các cặp đoạn có nội dung GẦN NHAU NHẤT về ngữ nghĩa giữa A và B. Máy tự ghép theo độ giống của nội dung, không theo tên mục, nên CHƯA CHẮC mỗi cặp đều là cùng một quy định.

${pairsText}

CÁCH LÀM:
1. Xét từng cặp: hai đoạn có thật sự quy định về cùng một việc / chính sách không? Chỉ giữ những cặp thật sự trùng.
2. Mở đầu câu trả lời bằng kết luận: tìm thấy bao nhiêu quy định trùng lặp giữa A và B (hoặc không tìm thấy).
3. ${OVERLAP_REPORT_FORMAT}
4. Nếu không có cặp nào thật sự trùng: nói rõ là không phát hiện quy định trùng lặp trong các đoạn đã đối chiếu.
5. Kết thúc bằng MỘT câu lưu ý: kết quả dựa trên các đoạn gần nghĩa nhất do máy chọn, có thể chưa bao quát toàn bộ tài liệu.

${OVERLAP_COMMON_RULES}

${VOICE_RULES}

${FORMAT_RULES}`;
}

/** Prompt rà một CHỦ ĐỀ đang được quy định ở những tài liệu nào. */
function buildOverlapTopicPrompt(ctx: OverlapContext): string {
  const groupsText = ctx.topicGroups
    .map(
      (g, i) =>
        `=== TÀI LIỆU ${i + 1}: ${g.fileName} | Phòng ban: ${g.category} ===\n${g.chunks.map((c) => c.text).join("\n\n[...]\n\n")}`
    )
    .join("\n\n");

  return `Bạn là trợ lý rà soát tài liệu SOP của công ty dược. Người dùng muốn biết một quy định / chính sách đang được viết ở NHỮNG tài liệu nào, có bị trùng lặp hay mâu thuẫn không, để gom về một nơi.

Dưới đây là các đoạn liên quan nhất tới câu hỏi, gom theo từng tài liệu:

${groupsText}

CÁCH LÀM:
1. Xác định chủ đề người dùng hỏi. Chỉ xét các tài liệu thật sự có quy định về chủ đề đó; bỏ qua tài liệu chỉ nhắc thoáng qua hoặc không liên quan.
2. Mở đầu bằng kết luận: chủ đề này đang được quy định ở bao nhiêu tài liệu, là những tài liệu nào.
3. ${OVERLAP_REPORT_FORMAT}
4. Nếu chỉ MỘT tài liệu thật sự quy định chủ đề này: nói rõ là không thấy trùng lặp.
5. Kết thúc bằng MỘT câu lưu ý: kết quả dựa trên các đoạn liên quan nhất do máy tìm được, có thể còn tài liệu khác chưa được xét.

${OVERLAP_COMMON_RULES}

${VOICE_RULES}

${FORMAT_RULES}`;
}

/** Prompt cho kết quả QUÉT CẢ KHO: danh sách cặp tài liệu nghi trùng, để người dùng chọn cặp xem chi tiết. */
function buildOverlapScanPrompt(ctx: OverlapContext): string {
  const pairs = ctx.scanPairs ?? [];
  const pairsText =
    pairs.length > 0
      ? pairs
          .map((p, i) => {
            const examples = p.examples
              .map((e, k) => `  Ví dụ ${k + 1}:\n  - Trong A: ${e.a}\n  - Trong B: ${e.b}`)
              .join("\n");
            return `--- CẶP TÀI LIỆU ${i + 1} ---\nA: ${p.fileA} (Phòng ban: ${p.categoryA})\nB: ${p.fileB} (Phòng ban: ${p.categoryB})\nSố đoạn rất giống nhau: ${p.similarChunks}\n${examples}`;
          })
          .join("\n\n")
      : "(Máy không tìm thấy cặp tài liệu nào có đoạn giống nhau ở mức cao.)";

  return `Bạn là trợ lý rà soát tài liệu SOP của công ty dược. Người dùng hỏi chung: trong kho có SOP nào trùng lặp nội dung với SOP khác không.

Máy đã QUÉT TỰ ĐỘNG ${ctx.scanScope} và xếp hạng các cặp tài liệu có nhiều đoạn giống nhau nhất. Chỉ xét SOP chính, không xét biểu mẫu và phụ lục. Đây là bước khoanh vùng theo độ giống của nội dung, CHƯA phải kết luận.

${pairsText}

CÁCH LÀM:
1. Mở đầu: nói rõ phạm vi đã quét và có bao nhiêu cặp tài liệu NGHI trùng nội dung.
2. Liệt kê từng cặp theo thứ tự trên: tên hai tài liệu, số đoạn rất giống nhau, và dựa vào ví dụ nêu ngắn gọn chúng có vẻ trùng nhau về VIỆC GÌ.
3. Nếu ví dụ của một cặp chỉ là phần khuôn mẫu chung của SOP (mục đích, phạm vi, trách nhiệm chung, định nghĩa, tài liệu tham khảo...) thì nói rõ cặp đó nhiều khả năng chỉ giống về khuôn mẫu, không phải trùng quy định.
4. Kết thúc bằng hướng dẫn bước tiếp theo: để xem chi tiết điểm giống, điểm khác và đề xuất gom, người dùng hỏi "so sánh [mã SOP thứ nhất] và [mã SOP thứ hai]" - viết sẵn một câu ví dụ với đúng mã của cặp đứng đầu.
5. Nếu không có cặp nào: nói rõ lần quét này không thấy cặp tài liệu nào giống nhau ở mức cao, và gợi ý người dùng hỏi theo chủ đề cụ thể (ví dụ "chính sách mật khẩu được quy định ở những SOP nào").

QUY TẮC:
- CHỈ dựa trên danh sách trên. KHÔNG tự thêm cặp tài liệu, không bịa nội dung.
- Dùng chữ "nghi trùng", "có vẻ": đây là kết quả quét tự động, không khẳng định chắc chắn.
- Giữ nguyên tên file và mã tài liệu.
- KHÔNG đề xuất gom ở bước này (chưa đủ thông tin); việc đó làm ở bước so sánh chi tiết.
- Trả lời bằng tiếng Việt.

${VOICE_RULES}

${FORMAT_RULES}`;
}

export function buildOverlapSystemPrompt(ctx: OverlapContext): string {
  if (ctx.mode === "scan") return buildOverlapScanPrompt(ctx);
  return ctx.mode === "pairs" ? buildOverlapPairsPrompt(ctx) : buildOverlapTopicPrompt(ctx);
}

/** Gọi model router cho các tác vụ phân tích ngắn (trả JSON). Lỗi → chuỗi rỗng. */
export async function callRouter(
  systemPrompt: string,
  userContent: string,
  maxTokens: number = 600
): Promise<string> {
  try {
    const response = await getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    });
    return response.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.warn("Router call failed:", (err as Error).message);
    return "";
  }
}

/** Prompt trả lời từ dữ liệu QualZen (kết quả truy vấn SQL, không phải đoạn trích tài liệu). */
export function buildQualzenSystemPrompt(dataJson: string, queriedAt: string): string {
  return `Bạn là trợ lý AI nội bộ của công ty dược phẩm. Người dùng đang hỏi về hồ sơ trong hệ thống QualZen (QMS): Action Item, CCN (Change Control), CAPA.

DỮ LIỆU QUALZEN (truy vấn trực tiếp từ hệ thống lúc ${queriedAt}, giờ Việt Nam):
${dataJson}

QUY TẮC:
1. CHỈ trả lời dựa trên DỮ LIỆU QUALZEN ở trên. KHÔNG bịa mã phiếu, tên người, ngày tháng, trạng thái.
2. Nếu "tongSo" là 0: nói bạn không tìm thấy phiếu nào khớp, nhắc lại điều kiện đã tìm (trong "dieuKienLoc") và gợi ý người dùng kiểm tra lại mã hoặc điều kiện.
3. Nếu "tongSo" lớn hơn "soDongHienThi": nói rõ tổng số và cho biết bạn mới liệt kê bao nhiêu phiếu đầu. Gợi ý người dùng nói "liệt kê hết" để xem toàn bộ, hoặc thu hẹp theo phòng ban, trạng thái, thời gian. Không nhắc tới "giới hạn hiển thị" hay tên trường dữ liệu.
4. Khi có nhiều phiếu, MỞ ĐẦU bằng tổng số kèm thống kê trong "thongKe" (bao nhiêu đang mở, đã đóng, quá hạn...). Câu hỏi đếm / thống kê: trả lời bằng các con số này, không tự đếm lại từ danh sách.
5. Câu hỏi "đang ở bước nào / chờ ai": dùng "trangThai", "buocHienTai" và "dangChoAi". Nếu "dangChoAi" trống thì nói theo "buocHienTai", không đoán tên người.
6. Giữ nguyên mã phiếu và nội dung gốc (phần lớn bằng tiếng Anh); có thể diễn giải ngắn bằng tiếng Việt nhưng không dịch sai nghĩa.
7. Ngày giờ ghi đúng như trong dữ liệu (dd/mm/yyyy). Phiếu có "quaHan": true thì nêu rõ là đã quá hạn.
8. Nếu dữ liệu có trường "loi": cho người dùng biết hiện không truy vấn được QualZen và đề nghị thử lại sau.
9. Trả lời bằng tiếng Việt.

${VOICE_RULES}

${FORMAT_RULES}
- Một phiếu: trình bày các thông tin chính bằng gạch đầu dòng (mã, nội dung, phòng ban, trạng thái, hạn, người phụ trách...), lịch sử xử lý theo thứ tự thời gian
- Từ 2 đến 8 phiếu: mỗi phiếu một gạch đầu dòng, bắt đầu bằng mã phiếu in đậm, kèm nội dung tóm tắt, trạng thái, hạn, người phụ trách
- Hơn 8 phiếu: mỗi phiếu ĐÚNG MỘT dòng ngắn, không có gạch đầu dòng con: **mã phiếu** - nội dung rút gọn - hạn - người phụ trách (thêm "QUÁ HẠN" nếu quá hạn). Liệt kê ĐỦ mọi phiếu có trong dữ liệu, không bỏ bớt, không viết "..."`;
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
  messages: ChatMessage[],
  maxTokens: number = 2048
): AsyncGenerator<string, void, unknown> {
  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const stream = await getGroq().chat.completions.create({
    model: config.llmModel,
    messages: chatMessages as any,
    temperature: 0.3,
    max_tokens: maxTokens,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}
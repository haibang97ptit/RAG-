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
      temperature: 0, // cùng câu hỏi → cùng biến thể → cùng đoạn trích
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
      temperature: 0,
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
      return `[${i}] File: ${c.fileName}${c.section ? ` | Mục: ${c.section}` : ""}\n${preview}...`;
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

// Nhãn cho đoạn trích lấy từ bản scan (chữ nhận dạng tự động, xem pdfReader.ts)
const OCR_SOURCE_NAME = "bản scan - chữ nhận dạng tự động";
const OCR_SOURCE_LABEL = ` | ${OCR_SOURCE_NAME}`;

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
      const sectionInfo = c.section ? ` | Mục: ${c.section}` : "";
      const ocrInfo = c.ocr ? OCR_SOURCE_LABEL : "";
      return `[Nguồn ${i + 1}] File: ${c.fileName} | Phòng ban: ${c.category}${sheetInfo}${sectionInfo}${ocrInfo}\n${c.text}`;
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
9. Nguồn có ghi "${OCR_SOURCE_NAME}": chữ được nhận dạng tự động từ bản scan nên có thể sai chính tả, sai số. Khi câu trả lời dựa vào nguồn này (nhất là con số, mã số), nói ngắn gọn rằng thông tin lấy từ bản scan và nên đối chiếu bản gốc

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
            `[Nguồn ${i + 1}] File: ${c.fileName}${c.sheetName ? ` | Sheet: ${c.sheetName}` : ""}${c.section ? ` | Mục: ${c.section}` : ""}${c.ocr ? OCR_SOURCE_LABEL : ""}\n${c.text}`
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
6. Nguồn có ghi "${OCR_SOURCE_NAME}" có thể sai chính tả, sai số: khi dựa vào nguồn này thì nói rõ thông tin lấy từ bản scan

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
// ---- Giới hạn độ dài nội dung tài liệu trong prompt so sánh / rà trùng lặp ----
// Prompt vượt giới hạn token/phút của Groq thì bị từ chối hẳn (lỗi 413), nên cắt trước khi gửi.
// Ưu tiên: giữ các cặp / đoạn đứng đầu (giống nhau nhất), cắt ngắn từng đoạn trước, chỉ bỏ bớt
// khi từng đoạn đã quá ngắn để còn đọc được.
const MIN_EXCERPT_CHARS = 450;
const MIN_SCAN_EXAMPLE_CHARS = 250;

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/** Số mục giữ lại và độ dài tối đa mỗi đoạn, sao cho count * perItem đoạn vừa ngân sách. */
function fitCount(count: number, excerptsPerItem: number, minChars: number): { keep: number; maxChars: number } {
  const budget = config.overlapPromptBudgetChars;
  let keep = count;
  while (keep > 1 && budget / (keep * excerptsPerItem) < minChars) keep--;
  return { keep, maxChars: Math.max(minChars, Math.floor(budget / Math.max(1, keep * excerptsPerItem))) };
}

function buildOverlapPairsPrompt(ctx: OverlapContext): string {
  const fit = fitCount(ctx.pairs.length, 2, MIN_EXCERPT_CHARS);
  const pairs = ctx.pairs.slice(0, fit.keep);
  const block = (tag: string, c: OverlapContext["pairs"][number]["a"]) =>
    `[${tag}] File: ${c.fileName} | Phòng ban: ${c.category}\n${clipText(c.text, fit.maxChars)}`;

  const pairsText =
    pairs.length > 0
      ? pairs
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
  // Lấy lần lượt đoạn thứ 1 của mọi tài liệu, rồi đoạn thứ 2…, để tài liệu nào cũng còn mặt khi phải bỏ bớt
  const order: { group: number; chunk: number }[] = [];
  const maxChunks = Math.max(0, ...ctx.topicGroups.map((g) => g.chunks.length));
  for (let k = 0; k < maxChunks; k++) {
    ctx.topicGroups.forEach((g, i) => { if (k < g.chunks.length) order.push({ group: i, chunk: k }); });
  }
  const fit = fitCount(order.length, 1, MIN_EXCERPT_CHARS);
  const kept = new Set(order.slice(0, fit.keep).map((o) => `${o.group}:${o.chunk}`));

  const groupsText = ctx.topicGroups
    .map((g, i) => ({ g, i, chunks: g.chunks.filter((_, k) => kept.has(`${i}:${k}`)) }))
    .filter(({ chunks }) => chunks.length > 0)
    .map(
      ({ g, i, chunks }) =>
        `=== TÀI LIỆU ${i + 1}: ${g.fileName} | Phòng ban: ${g.category} ===\n${chunks.map((c) => clipText(c.text, fit.maxChars)).join("\n\n[...]\n\n")}`
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
  // Danh sách cặp tài liệu là phần chính: giữ đủ các cặp, chỉ bớt số ví dụ và độ dài ví dụ
  const allPairs = ctx.scanPairs ?? [];
  const examplesPerPair = Math.max(1, ...allPairs.map((p) => p.examples.length));
  let perPair = examplesPerPair;
  while (perPair > 1 && config.overlapPromptBudgetChars / (allPairs.length * perPair * 2) < MIN_SCAN_EXAMPLE_CHARS) perPair--;
  const fit = fitCount(allPairs.length, perPair * 2, MIN_SCAN_EXAMPLE_CHARS);
  const pairs = allPairs.slice(0, fit.keep);
  const pairsText =
    pairs.length > 0
      ? pairs
          .map((p, i) => {
            const examples = p.examples
              .slice(0, perPair)
              .map((e, k) => `  Ví dụ ${k + 1}:\n  - Trong A: ${clipText(e.a, fit.maxChars)}\n  - Trong B: ${clipText(e.b, fit.maxChars)}`)
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

// Model không nhận tham số reasoning_effort (vd đổi ROUTER_MODEL sang model khác) → thôi gửi
let reasoningEffortSupported = true;

/**
 * Gọi model router cho các tác vụ phân tích ngắn (trả JSON). Lỗi → throw.
 * @param reasoningEffort gpt-oss là model suy luận: "low" để phân loại nhanh, ít token
 */
export async function callRouterStrict(
  systemPrompt: string,
  userContent: string,
  maxTokens: number = 600,
  reasoningEffort?: "low" | "medium"
): Promise<string> {
  const request = (withEffort: boolean) =>
    getGroq().chat.completions.create({
      model: config.routerModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      // groq-sdk 0.9 chưa khai báo kiểu cho tham số này nhưng vẫn gửi đi
      ...(withEffort ? ({ reasoning_effort: reasoningEffort } as any) : {}),
    });

  const useEffort = !!reasoningEffort && reasoningEffortSupported;
  try {
    const response = await request(useEffort);
    return response.choices[0]?.message?.content?.trim() || "";
  } catch (err) {
    if (!useEffort || (err as any)?.status !== 400) throw err;
    reasoningEffortSupported = false;
    console.warn("Model router không nhận reasoning_effort, gọi lại không có tham số này");
    const response = await request(false);
    return response.choices[0]?.message?.content?.trim() || "";
  }
}

/** Như callRouterStrict nhưng lỗi → chuỗi rỗng. */
export async function callRouter(
  systemPrompt: string,
  userContent: string,
  maxTokens: number = 600
): Promise<string> {
  try {
    return await callRouterStrict(systemPrompt, userContent, maxTokens);
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
8. Nếu "dieuKienLoc" có "noiDungCoNhacToiTaiLieu": các phiếu trong danh sách là những phiếu có NỘI DUNG nhắc tới tài liệu đó. Với mỗi phiếu, nêu ngắn gọn phiếu đề xuất thay đổi gì đối với tài liệu ấy (dựa vào "thayDoiDeXuat", "quyTrinhHienTai", "taiLieuThayDoi", "noiDung"). Nếu không có phiếu nào, nói rõ không tìm thấy phiếu nào nhắc tới mã tài liệu đó và đề nghị người dùng kiểm tra lại mã.
9. Nếu dữ liệu có trường "loi": cho người dùng biết hiện không truy vấn được QualZen và đề nghị thử lại sau.
10. Trả lời bằng tiếng Việt.

${VOICE_RULES}

${FORMAT_RULES}
- Một phiếu: trình bày các thông tin chính bằng gạch đầu dòng (mã, nội dung, phòng ban, trạng thái, hạn, người phụ trách...), lịch sử xử lý theo thứ tự thời gian
- Từ 2 đến 8 phiếu: mỗi phiếu một gạch đầu dòng, bắt đầu bằng mã phiếu in đậm, kèm nội dung tóm tắt, trạng thái, hạn, người phụ trách
- Hơn 8 phiếu: mỗi phiếu ĐÚNG MỘT dòng ngắn, không có gạch đầu dòng con: **mã phiếu** - nội dung rút gọn - hạn - người phụ trách (thêm "QUÁ HẠN" nếu quá hạn). Liệt kê ĐỦ mọi phiếu có trong dữ liệu, không bỏ bớt, không viết "..."`;
}

/**
 * Danh sách quá dài để đưa qua LLM: server tự in danh sách phiếu ngay sau câu trả lời,
 * LLM chỉ nhận số liệu tổng hợp và viết phần mở đầu.
 */
export function buildQualzenListIntroPrompt(summaryJson: string, queriedAt: string): string {
  return `Bạn là trợ lý AI nội bộ của công ty dược phẩm. Người dùng hỏi một danh sách phiếu trong hệ thống QualZen (QMS).

SỐ LIỆU TỔNG HỢP (truy vấn trực tiếp từ hệ thống lúc ${queriedAt}, giờ Việt Nam):
${summaryJson}

Danh sách từng phiếu sẽ được hệ thống TỰ ĐỘNG hiển thị ngay bên dưới câu trả lời của bạn. Nhiệm vụ của bạn chỉ là viết PHẦN MỞ ĐẦU:
1. Một câu nêu tổng số phiếu ("tongSo") khớp điều kiện trong "dieuKienLoc", diễn đạt tự nhiên.
2. Tóm tắt số liệu trong "thongKe": theo phòng ban, theo trạng thái, số đang mở / đã đóng / quá hạn nếu có. Từ 3 nhóm trở lên thì dùng gạch đầu dòng, mỗi nhóm một dòng ngắn. Dùng đúng các con số có trong dữ liệu, không tự tính thêm.
3. Nếu "tongSo" lớn hơn "soDongHienThi": nói danh sách bên dưới gồm "soDongHienThi" phiếu.
4. KHÔNG liệt kê từng phiếu, KHÔNG bịa mã phiếu. Không viết câu kiểu "dưới đây là danh sách" ở cuối, hệ thống tự thêm tiêu đề.
5. Ngắn gọn, tối đa khoảng 12 dòng. Trả lời bằng tiếng Việt.

${VOICE_RULES}`;
}

/** Câu hỏi về kho tài liệu (đếm / liệt kê SOP theo phòng ban): LLM chỉ viết phần mở đầu từ số liệu đã đếm sẵn. */
export function buildInventoryIntroPrompt(summaryJson: string): string {
  return `Bạn là trợ lý AI nội bộ của công ty dược phẩm, giúp tra cứu tài liệu SOP. Người dùng hỏi về số lượng / danh sách tài liệu.

SỐ LIỆU ĐÃ ĐẾM TỪ DANH MỤC TÀI LIỆU TRỢ LÝ ĐANG CÓ:
${summaryJson}

Nhiệm vụ: viết PHẦN MỞ ĐẦU ngắn gọn.
1. Nêu rõ con số "tongSo" theo đúng "phamVi" và "loaiTaiLieu". Nếu có "theoPhongBan" hoặc "theoLoai" thì liệt kê các con số đó, mỗi nhóm một dòng ngắn. Dùng đúng các con số trong dữ liệu, không tự tính hay đoán thêm.
2. Một câu ngắn giải thích cách đếm theo "cachDem".
3. Lưu ý ngắn rằng đây là số tài liệu trợ lý đang có trong kho tra cứu, có thể khác danh mục chính thức của phòng ban (ví dụ file scan chưa đọc được hoặc chưa được đưa vào thư mục).
4. Nếu "danhSachBenDuoi" là true: danh sách sẽ được hệ thống TỰ ĐỘNG hiển thị ngay bên dưới, KHÔNG tự liệt kê tên tài liệu và không viết câu "dưới đây là danh sách". Nếu false (người dùng chỉ hỏi số lượng): KHÔNG liệt kê, kết thúc bằng câu hỏi "Bạn có muốn xem danh sách không?".
5. Nếu "tongSo" là 0: nói không tìm thấy tài liệu nào thuộc phạm vi đó, không suy đoán. Nếu có "phongBanKhongCoTrongKho" (kể cả khi các phòng khác vẫn có số liệu) thì nói rõ kho không có tài liệu của các phòng đó, và liệt kê các phòng trong "phongBanCoTrongKho".
6. Tối đa khoảng 10 dòng. Trả lời bằng ngôn ngữ người dùng đang dùng (thường là tiếng Việt; hỏi bằng tiếng Anh thì trả lời tiếng Anh).

${VOICE_RULES}`;
}

/**
 * So sánh hai phiên bản tài liệu: code đã tìm đủ các thay đổi, danh sách chi tiết do server in ngay
 * sau câu trả lời. LLM chỉ viết phần tóm tắt từ số liệu và các thay đổi lớn nhất.
 */
export function buildDiffIntroPrompt(summaryJson: string): string {
  return `Bạn là trợ lý rà soát tài liệu SOP của công ty dược. Người dùng muốn biết hai tài liệu (thường là hai phiên bản của cùng một tài liệu) KHÁC NHAU ở đâu.

Máy đã so sánh TOÀN VĂN hai tài liệu (A = bản thứ nhất, B = bản thứ hai) và tìm ra các thay đổi:

${summaryJson}

Danh sách ĐẦY ĐỦ từng thay đổi sẽ được hệ thống TỰ ĐỘNG hiển thị ngay bên dưới câu trả lời của bạn. Nhiệm vụ của bạn là viết PHẦN TÓM TẮT:
1. Câu đầu: tổng số thay đổi và số thêm / bỏ / sửa / chuyển vị trí (lấy đúng số trong "tongSoThayDoi" và "theoLoai").
2. Nêu ngắn gọn: các mục MỚI chỉ có ở bản B ("mucMoiChiCoOBanB"), các mục BỊ BỎ chỉ có ở bản A ("mucBiBoChiCoOBanA"), và các mục thay đổi nhiều nhất ("mucCoNhieuThayDoiNhat"). Danh sách mục dài thì chỉ nêu vài mục tiêu biểu kèm tổng số.
3. Tóm tắt 3-8 thay đổi QUAN TRỌNG VỀ NỘI DUNG từ "cacThayDoiLonNhat": nói rõ bản B khác bản A thế nào (thêm yêu cầu gì, bỏ điều kiện gì, đổi con số gì), mỗi ý một gạch đầu dòng, ghi mục. Bỏ qua thay đổi chỉ về trình bày, lỗi chính tả, số trang.
4. Nếu "tongSoThayDoi" là 0: nói hai tài liệu có nội dung giống nhau, không tìm thấy khác biệt.
   Nếu "tyLeDoanGiongNhau" dưới 30%: nói rõ ngay câu đầu rằng hai tài liệu khác nhau phần lớn, có thể không phải hai phiên bản của cùng một tài liệu, nên danh sách thay đổi rất dài; vẫn nêu vài khác biệt chính.
5. KHÔNG liệt kê lại toàn bộ danh sách, KHÔNG bịa thay đổi không có trong dữ liệu, không viết câu "dưới đây là danh sách".
6. Dữ liệu lấy từ file PDF có thể có khác biệt giả do cách trình bày (bảng bị tách dòng, chữ đóng dấu chèn trang). Nếu thấy thay đổi chỉ là chữ vô nghĩa thì bỏ qua, không tóm tắt.
7. Trả lời bằng tiếng Việt, tối đa khoảng 20 dòng.

${VOICE_RULES}`;
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
    temperature: 0.2, // thấp để cùng câu hỏi cho câu trả lời nhất quán
    max_tokens: maxTokens,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}
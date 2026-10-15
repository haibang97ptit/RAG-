import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { qualzenSettingsFromEnv } from "./qualzenDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.includes("your_key") || value.includes("your")) {
    throw new Error(
      `❌ Missing or invalid env var: ${name}\n` +
      `   Kiểm tra file .env, hoặc copy từ .env.example`
    );
  }
  return value;
}

const collectionName = process.env.COLLECTION_NAME || "sop_documents";
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, "../../data");

// Manifest gắn với tên collection để mỗi collection có trạng thái index riêng
// (cho phép build collection mới song song rồi mới chuyển).
const manifestDir = process.env.MANIFEST_DIR || path.join(dataDir, "..");

export const config = {
  groqApiKey: required("GROQ_API_KEY"),
  qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
  port: parseInt(process.env.PORT || "8000", 10),
  collectionName,

  llmModel: process.env.LLM_MODEL || "openai/gpt-oss-120b",
  routerModel: process.env.ROUTER_MODEL || "openai/gpt-oss-20b",
  embedModel: process.env.EMBED_MODEL || "Xenova/multilingual-e5-base",

  // multilingual-e5-base cắt input ở 512 token → chunk phải đủ nhỏ để không bị cắt
  chunkSize: parseInt(process.env.CHUNK_SIZE || "1200", 10),
  chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || "150", 10),

  topK: parseInt(process.env.TOP_K || "20", 10),
  rerankTopK: parseInt(process.env.RERANK_TOP_K || "10", 10),

  // API_TOKEN trống = không bật auth cho /query* (dev, hoặc giai đoạn chuyển tiếp khi app cũ chưa gửi token)
  apiToken: process.env.API_TOKEN || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  // CORS_ORIGINS trống = cho phép mọi origin (như trước). Nhiều origin cách nhau bằng dấu phẩy.
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  cacheDir: process.env.CACHE_DIR || "./.cache",
  dataDir,
  manifestPath: path.join(manifestDir, `.ingest-manifest.${collectionName}.json`),
  // Nhật ký câu hỏi + phản hồi 👍/👎 (trên server là volume /app/state, giữ qua các lần deploy)
  stateDir: process.env.STATE_DIR || manifestDir,
  // Nhận dạng chữ cho PDF scan (cần tesseract + poppler-utils, có sẵn trong image Docker)
  ocrEnabled: process.env.OCR_ENABLED !== "false",
  // Trang có ít ký tự hơn mức này thì OCR; hoặc ít hơn OCR_IMAGE_TEXT_CHARS mà trang có ảnh lớn
  ocrMinTextChars: parseInt(process.env.OCR_MIN_TEXT_CHARS || "200", 10),
  ocrImageTextChars: parseInt(process.env.OCR_IMAGE_TEXT_CHARS || "1500", 10),
  ocrLang: process.env.OCR_LANG || "vie+eng",
  ocrDpi: parseInt(process.env.OCR_DPI || "300", 10),
  enhancedRetrieval: process.env.ENHANCED_RETRIEVAL === "true",
  // Tra cứu hồ sơ QualZen (Action Item, CCN, CAPA) - bật khi có đủ QUALZEN_DB_*
  qualzenEnabled: qualzenSettingsFromEnv() !== null,
  // Dữ liệu QualZen đưa vào prompt tối đa bao nhiêu ký tự (~3 ký tự / token). Mặc định vừa giới hạn
  // 8.000 token/phút của Groq gói miễn phí; danh sách dài hơn thì server tự in, LLM chỉ viết phần tóm tắt.
  // Nâng gói Groq thì có thể tăng (vd 40000) để LLM tự trình bày nhiều phiếu hơn.
  qualzenPromptBudgetChars: parseInt(process.env.QUALZEN_PROMPT_BUDGET_CHARS || "12000", 10),
  // Nội dung tài liệu tối đa đưa vào prompt so sánh / rà trùng lặp (ký tự). Tiếng Việt nhiều bảng chỉ
  // ~2,1 ký tự / token: 8000 ký tự + phần hướng dẫn ≈ 5.500 token, vừa giới hạn 8.000 token/phút gói miễn phí.
  overlapPromptBudgetChars: parseInt(process.env.OVERLAP_PROMPT_BUDGET_CHARS || "8000", 10),
  // Khi user gọi tắt mã tài liệu ("SOP 0005") mà nhiều phòng ban có mã trùng số,
  // ưu tiên phòng ban này (= tên thư mục cấp 1 trong DATA_DIR). Trống = giữ tất cả.
  defaultCategory: process.env.DEFAULT_CATEGORY || "",
};

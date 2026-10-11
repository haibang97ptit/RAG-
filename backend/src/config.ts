import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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
  enhancedRetrieval: process.env.ENHANCED_RETRIEVAL === "true",
};

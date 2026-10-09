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

export const config = {
  groqApiKey: required("GROQ_API_KEY"),
  qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
  port: parseInt(process.env.PORT || "8000", 10),
  collectionName: process.env.COLLECTION_NAME || "sop_documents",

  llmModel: process.env.LLM_MODEL || "openai/gpt-oss-120b",
  routerModel: process.env.ROUTER_MODEL || "openai/gpt-oss-20b",
  embedModel: process.env.EMBED_MODEL || "Xenova/multilingual-e5-base",

  chunkSize: parseInt(process.env.CHUNK_SIZE || "3000", 10),
  chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || "300", 10),

  topK: parseInt(process.env.TOP_K || "20", 10),
  rerankTopK: parseInt(process.env.RERANK_TOP_K || "10", 10),

  adminToken: process.env.ADMIN_TOKEN || "",
  cacheDir: process.env.CACHE_DIR || "./.cache",
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, "../../data"),
  enhancedRetrieval: process.env.ENHANCED_RETRIEVAL === "true",
};

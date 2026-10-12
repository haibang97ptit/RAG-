import crypto from "crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { initEmbedder, embedQuery } from "./embedding.js";
import {
  ensureCollection,
  searchSimilar,
  countPoints,
  getCategories,
  listIndexedFiles,
  type SearchResult,
} from "./qdrantService.js";
import {
  classifyIntent,
  classifyComplexity,
  rewriteFollowUpQuery,
  expandQuery,
  generateHypotheticalAnswer,
  rerankChunks,
  buildSOPSystemPrompt,
  buildFollowUpSystemPrompt,
  buildChitChatSystemPrompt,
  streamChatCompletion,
  type ChatMessage,
  type Intent,
} from "./llmService.js";
import { findCatalogForQuery } from "./fileCatalog.js";

const fastify = Fastify({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  },
});

await fastify.register(cors, {
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// ============== AUTH ==============

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  // So sánh trên hash để độ dài bằng nhau và không lộ thông tin qua thời gian so sánh
  const a = crypto.createHash("sha256").update(header.slice(7).trim()).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// /health luôn mở (Docker healthcheck). /stats cần ADMIN_TOKEN, còn lại cần API_TOKEN.
// Token nào để trống thì nhóm endpoint đó không bật auth.
fastify.addHook("onRequest", async (request, reply) => {
  if (request.method === "OPTIONS") return;

  const urlPath = request.url.split("?")[0];
  if (urlPath === "/health") return;

  const expected = urlPath === "/stats" ? config.adminToken || config.apiToken : config.apiToken;
  if (!expected) return;

  if (!bearerMatches(request.headers.authorization, expected)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

interface QueryBody {
  query: string;
  history?: ChatMessage[];
}

const MAX_HISTORY_MESSAGES = 20;
const MAX_UI_SOURCES = 5;
const MAX_QUERY_CHARS = 4000;
const MAX_HISTORY_CONTENT_CHARS = 8000;

/**
 * History do client gửi lên nên không tin được: chỉ giữ message user/assistant có nội dung
 * (bỏ role "system" và message rỗng), cắt bớt message quá dài.
 * Lọc chứ không trả 400 để app bản cũ vẫn dùng được.
 */
function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];

  const clean: ChatMessage[] = [];
  for (const m of history) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    clean.push({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CONTENT_CHARS) });
  }
  return clean.slice(-MAX_HISTORY_MESSAGES);
}

function validateQuery(query: unknown): string | null {
  if (!query || typeof query !== "string" || !query.trim()) return "Thiếu query";
  if (query.length > MAX_QUERY_CHARS) return `Query quá dài (tối đa ${MAX_QUERY_CHARS} ký tự)`;
  return null;
}

/**
 * Pipeline retrieval nâng cao:
 * - Query expansion → multiple variants
 * - HyDE (hypothetical answer) → embed cùng query gốc
 * - Search parallel cho từng variant
 * - Union + dedupe
 * - Rerank với topK adaptive
 */
async function enhancedRetrieve(
  query: string,
  complexity: "simple" | "complex"
): Promise<{ reranked: SearchResult[]; stats: any }> {
  const stats: any = {};

  // ============== SIMPLE PIPELINE (khi flag off) ==============
  if (!config.enhancedRetrieval) {
    stats.mode = "simple";
    const vec = await embedQuery(query);
    const results = await searchSimilar(vec, config.topK);
    const reranked = await rerankChunks(query, results, config.rerankTopK);
    stats.unique_candidates = results.length;
    stats.reranked_count = reranked.length;
    return { reranked, stats };
  }

  // ============== ENHANCED PIPELINE (HyDE + Query Expansion) ==============
  stats.mode = "enhanced";

  const [variants, hypothetical] = await Promise.all([
    expandQuery(query),
    generateHypotheticalAnswer(query),
  ]);
  stats.variants = variants;
  stats.hyde_length = hypothetical.length;

  const primaryText = hypothetical ? `${query}\n\n${hypothetical}` : query;
  const primaryVec = await embedQuery(primaryText);
  const primaryResults = await searchSimilar(primaryVec, config.topK);

  const allResults: SearchResult[] = [];
  const seen = new Set<string>();
  const addResult = (r: SearchResult) => {
    const key = `${r.fileName}::${r.text.slice(0, 60)}`;
    if (!seen.has(key)) {
      seen.add(key);
      allResults.push(r);
    }
  };

  for (const r of primaryResults) addResult(r);

  const secondaryK = Math.max(5, Math.floor(config.topK / 2));
  await Promise.all(
    variants.map(async (variant) => {
      try {
        const vec = await embedQuery(variant);
        const results = await searchSimilar(vec, secondaryK);
        for (const r of results) addResult(r);
      } catch (err) {
        fastify.log.warn(`Variant search failed: ${(err as Error).message}`);
      }
    })
  );
  stats.unique_candidates = allResults.length;

  const effectiveTopK = complexity === "complex" ? Math.min(10, allResults.length) : config.rerankTopK;
  const reranked = await rerankChunks(query, allResults, effectiveTopK);
  stats.reranked_count = reranked.length;

  return { reranked, stats };
}

// Health check
fastify.get("/health", async () => {
  const pointCount = await countPoints().catch(() => 0);
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    indexedChunks: pointCount,
  };
});

// Stats
fastify.get("/stats", async () => {
  const [total, categories, files] = await Promise.all([
    countPoints(),
    getCategories(),
    listIndexedFiles(),
  ]);
  return {
    totalChunks: total,
    categories,
    totalFiles: files.length,
    files: files.slice(0, 100),
  };
});

// JSON endpoint (debug)
fastify.post<{ Body: QueryBody }>("/query", async (request, reply) => {
  const { query, history } = request.body ?? ({} as QueryBody);
  const queryError = validateQuery(query);
  if (queryError) {
    return reply.code(400).send({ error: queryError });
  }

  const limitedHistory = sanitizeHistory(history);
  const intent = await classifyIntent(query, limitedHistory);

  let sources: any[] = [];
  let answer = "";

  if (intent === "CHITCHAT") {
    const sysPrompt = buildChitChatSystemPrompt();
    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    for await (const delta of streamChatCompletion(sysPrompt, messages)) {
      answer += delta;
    }
  } else {
    const complexity = classifyComplexity(query);
    const searchQuery =
      intent === "FOLLOW_UP" ? await rewriteFollowUpQuery(query, limitedHistory) : query;
    const [{ reranked }, catalog] = await Promise.all([
      enhancedRetrieve(searchQuery, complexity),
      findCatalogForQuery(`${query} ${searchQuery}`),
    ]);

    sources = reranked.map((r) => ({
      fileName: r.fileName,
      category: r.category,
      sheetName: r.sheetName,
      score: r.score,
    }));

    const useCoT = complexity === "complex";
    const sysPrompt =
      intent === "FOLLOW_UP"
        ? buildFollowUpSystemPrompt(reranked, catalog)
        : buildSOPSystemPrompt(reranked, useCoT, catalog);

    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    for await (const delta of streamChatCompletion(sysPrompt, messages)) {
      answer += delta;
    }
  }

  return { intent, answer, sources };
});

// SSE streaming endpoint
fastify.post<{ Body: QueryBody }>("/query/stream", async (request, reply) => {
  const { query, history } = request.body ?? ({} as QueryBody);
  const queryError = validateQuery(query);
  if (queryError) {
    return reply.code(400).send({ error: queryError });
  }

  // Ghi thẳng vào reply.raw nên header CORS của plugin không tự được gửi:
  // CORS_ORIGINS có cấu hình → dùng header plugin đã tính; không → "*" như trước.
  const corsHeaders =
    config.corsOrigins.length > 0
      ? (reply.getHeaders() as Record<string, string>)
      : { "Access-Control-Allow-Origin": "*" };

  reply.raw.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: any) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const limitedHistory = sanitizeHistory(history);
    const intent: Intent = await classifyIntent(query, limitedHistory);
    send("intent", { intent });

    let sysPrompt: string;
    let uiSources: any[] = [];

    if (intent === "CHITCHAT") {
      sysPrompt = buildChitChatSystemPrompt();
      send("sources", { sources: [] });
    } else {
      // 1. Classify complexity
      const complexity = classifyComplexity(query);
      send("complexity", { complexity });

      // 2. Follow-up: viết lại thành truy vấn độc lập để tìm đúng chủ đề đang nói
      const searchQuery =
        intent === "FOLLOW_UP" ? await rewriteFollowUpQuery(query, limitedHistory) : query;

      // 3. Enhanced retrieve (HyDE + Query Expansion + Rerank)
      // Song song: tra danh mục file theo mã tài liệu trong câu hỏi (cho câu hỏi đếm/liệt kê)
      const [{ reranked, stats }, catalog] = await Promise.all([
        enhancedRetrieve(searchQuery, complexity),
        findCatalogForQuery(`${query} ${searchQuery}`),
      ]);
      fastify.log.info(
        { query, searchQuery, intent, complexity, catalog_files: catalog?.total ?? 0, ...stats },
        "retrieval_stats"
      );

      // 4. Dedupe sources UI: top MAX_UI_SOURCES unique files
      const seenFiles = new Set<string>();
      for (const r of reranked) {
        const key = `${r.fileName}::${r.sheetName || ""}`;
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          uiSources.push({
            fileName: r.fileName,
            category: r.category,
            sheetName: r.sheetName,
            score: Math.round(r.score * 1000) / 1000,
          });
          if (uiSources.length >= MAX_UI_SOURCES) break;
        }
      }
      send("sources", { sources: uiSources });

      // 5. Build prompt (CoT khi complex, SOP vs FOLLOW_UP vs CHITCHAT)
      const useCoT = complexity === "complex";
      sysPrompt =
        intent === "FOLLOW_UP"
          ? buildFollowUpSystemPrompt(reranked, catalog)
          : buildSOPSystemPrompt(reranked, useCoT, catalog);
    }

    // 6. Stream LLM response
    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    for await (const delta of streamChatCompletion(sysPrompt, messages)) {
      send("chunk", { delta });
    }

    send("done", { intent, sources: uiSources });
  } catch (err) {
    fastify.log.error(err);
    send("error", { message: (err as Error).message });
  } finally {
    reply.raw.end();
  }
});

// Startup
async function start() {
  try {
    console.log("🚀 Khởi động SOP Backend...\n");

    console.log("1️⃣  Load embedding model...");
    await initEmbedder();

    console.log("\n2️⃣  Kết nối Qdrant...");
    await ensureCollection(false);
    const count = await countPoints();
    console.log(`   ✓ Collection '${config.collectionName}' có ${count} chunks`);

    console.log("\n3️⃣  Start Fastify server...");
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    console.log(`\n✅ Backend sẵn sàng tại http://0.0.0.0:${config.port}`);
    console.log(`   📊 Health:  GET  /health`);
    console.log(`   📈 Stats:   GET  /stats`);
    console.log(`   💬 Query:   POST /query`);
    console.log(`   🌊 Stream:  POST /query/stream (SSE)`);
    console.log(`\n   LLM main:    ${config.llmModel}`);
    console.log(`   LLM router:  ${config.routerModel}`);
    console.log(`   Pipeline:    ${config.enhancedRetrieval ? "ENHANCED (HyDE + Expansion + Adaptive)" : "SIMPLE (basic retrieval)"}`);
    console.log(`   Top-K:       ${config.topK} → rerank top ${config.rerankTopK}`);
    console.log(`   UI sources:  Max ${MAX_UI_SOURCES} unique files`);
    console.log(`   Auth:        /query* ${config.apiToken ? "cần API_TOKEN" : "KHÔNG auth (API_TOKEN trống)"} | /stats ${config.adminToken || config.apiToken ? "cần token" : "KHÔNG auth"}`);
    if (!config.apiToken) {
      fastify.log.warn("API_TOKEN chưa đặt: ai truy cập được port này cũng gọi được /query");
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

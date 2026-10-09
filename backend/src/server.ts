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
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

interface QueryBody {
  query: string;
  history?: ChatMessage[];
}

const MAX_HISTORY_MESSAGES = 20;
const MAX_UI_SOURCES = 5;

function limitHistory(history: ChatMessage[]): ChatMessage[] {
  if (!history || history.length === 0) return [];
  return history.slice(-MAX_HISTORY_MESSAGES);
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
  const { query, history = [] } = request.body;
  if (!query || typeof query !== "string") {
    return reply.code(400).send({ error: "Thiếu query" });
  }

  const limitedHistory = limitHistory(history);
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
    const { reranked } = await enhancedRetrieve(query, complexity);

    sources = reranked.map((r) => ({
      fileName: r.fileName,
      category: r.category,
      sheetName: r.sheetName,
      score: r.score,
    }));

    const useCoT = config.enhancedRetrieval &&  complexity === "complex";
    const sysPrompt =
      intent === "FOLLOW_UP"
        ? buildFollowUpSystemPrompt(reranked)
        : buildSOPSystemPrompt(reranked, useCoT);

    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    for await (const delta of streamChatCompletion(sysPrompt, messages)) {
      answer += delta;
    }
  }

  return { intent, answer, sources };
});

// SSE streaming endpoint
fastify.post<{ Body: QueryBody }>("/query/stream", async (request, reply) => {
  const { query, history = [] } = request.body;
  if (!query || typeof query !== "string") {
    return reply.code(400).send({ error: "Thiếu query" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: any) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const limitedHistory = limitHistory(history);
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

      // 2. Enhanced retrieve (HyDE + Query Expansion + Rerank)
      const { reranked, stats } = await enhancedRetrieve(query, complexity);
      fastify.log.info({ query, complexity, ...stats }, "retrieval_stats");

      // 3. Dedupe sources UI: top MAX_UI_SOURCES unique files
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

      // 4. Build prompt (CoT khi complex, SOP vs FOLLOW_UP vs CHITCHAT)
      const useCoT = complexity === "complex";
      sysPrompt =
        intent === "FOLLOW_UP"
          ? buildFollowUpSystemPrompt(reranked)
          : buildSOPSystemPrompt(reranked, useCoT);
    }

    // 5. Stream LLM response
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
    console.log(`   Pipeline:    ${config.enhancedRetrieval ? "ENHANCED (HyDE + Expansion + Adaptive)" : "SIMPLE (basic retrieval)"}`);    console.log(`   Top-K:       ${config.topK} → union variants → rerank (5-15 adaptive)`);
    console.log(`   UI sources:  Max ${MAX_UI_SOURCES} unique files`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
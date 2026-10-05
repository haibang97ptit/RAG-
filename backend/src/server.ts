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
} from "./qdrantService.js";
import {
  classifyIntent,
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

// Giới hạn history gửi cho LLM = 10 turns = 20 messages
const MAX_HISTORY_MESSAGES = 20;

function limitHistory(history: ChatMessage[]): ChatMessage[] {
  if (!history || history.length === 0) return [];
  return history.slice(-MAX_HISTORY_MESSAGES);
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

// Non-streaming (JSON) endpoint - dùng cho test/debug
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
    const messages: ChatMessage[] = [
      ...limitedHistory,
      { role: "user", content: query },
    ];
    for await (const delta of streamChatCompletion(sysPrompt, messages)) {
      answer += delta;
    }
  } else {
    // NEW_QUESTION hoặc FOLLOW_UP
    const qvec = await embedQuery(query);
    const topResults = await searchSimilar(qvec, config.topK);
    const reranked = await rerankChunks(query, topResults, config.rerankTopK);

    sources = reranked.map((r) => ({
      fileName: r.fileName,
      category: r.category,
      sheetName: r.sheetName,
      score: r.score,
    }));

    const sysPrompt =
      intent === "FOLLOW_UP"
        ? buildFollowUpSystemPrompt(reranked)
        : buildSOPSystemPrompt(reranked);

    const messages: ChatMessage[] = [
      ...limitedHistory,
      { role: "user", content: query },
    ];
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

  // Manual CORS headers vì ta bypass Fastify's response thường
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

    // 1. Phân loại intent
    const intent: Intent = await classifyIntent(query, limitedHistory);
    send("intent", { intent });

    let sysPrompt: string;
    let sources: any[] = [];

    if (intent === "CHITCHAT") {
      sysPrompt = buildChitChatSystemPrompt();
      send("sources", { sources: [] });
    } else {
      // 2. Retrieval: search top-K
      const qvec = await embedQuery(query);
      const topResults = await searchSimilar(qvec, config.topK);

      // 3. Rerank xuống top rerankTopK
      const reranked = await rerankChunks(query, topResults, config.rerankTopK);

      sources = reranked.map((r) => ({
        fileName: r.fileName,
        category: r.category,
        sheetName: r.sheetName,
        score: Math.round(r.score * 1000) / 1000,
      }));
      send("sources", { sources });

      sysPrompt =
        intent === "FOLLOW_UP"
          ? buildFollowUpSystemPrompt(reranked)
          : buildSOPSystemPrompt(reranked);
    }

    // 4. Stream LLM response
    const messages: ChatMessage[] = [
      ...limitedHistory,
      { role: "user", content: query },
    ];

    for await (const delta of streamChatCompletion(sysPrompt, messages)) {
      send("chunk", { delta });
    }

    send("done", { intent, sources });
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
    console.log(`   Top-K:       ${config.topK} → rerank → ${config.rerankTopK}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

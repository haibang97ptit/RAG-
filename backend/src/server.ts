import crypto from "crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { initEmbedder, embedQuery } from "./embedding.js";
import {
  ensureCollection,
  searchSimilar,
  fetchOpeningChunks,
  countPoints,
  getCategories,
  listIndexedFiles,
  type SearchResult,
} from "./qdrantService.js";
import {
  classifyIntent,
  classifyComplexity,
  isOverviewQuestion,
  rewriteFollowUpQuery,
  expandQuery,
  generateHypotheticalAnswer,
  rerankChunks,
  buildSOPSystemPrompt,
  buildFollowUpSystemPrompt,
  buildChitChatSystemPrompt,
  buildQualzenSystemPrompt,
  buildOverlapSystemPrompt,
  isOverlapQuestion,
  isCompareQuestion,
  streamChatCompletion,
  type ChatMessage,
  type Intent,
} from "./llmService.js";
import { selectDisplayedSources, type UiSource } from "./citedSources.js";
import { answerDataForQualzen, looksLikeQualzenQuestion } from "./qualzenAssistant.js";
import { findOverlapContext, type OverlapContext } from "./overlapFinder.js";
import {
  findCatalogForQuery,
  isMainDocument,
  mentionsFormOrAppendix,
  type CatalogMatch,
} from "./fileCatalog.js";

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
const OVERVIEW_OPENING_RATIO = 0.6;
// Câu trả lời từ QualZen có thể là danh sách dài ("liệt kê hết")
const QUALZEN_MAX_ANSWER_TOKENS = 6000;
// Báo cáo rà trùng lặp giữa các SOP dài hơn câu trả lời tra cứu thông thường
const OVERLAP_MAX_ANSWER_TOKENS = 4000;
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

// Danh mục bị cắt bớt (quá nhiều file khớp) thì con số trong câu hỏi nhiều khả năng
// không phải mã tài liệu → không thu hẹp phạm vi tìm kiếm.
function focusPathsOf(catalog: CatalogMatch | null): string[] {
  if (!catalog || catalog.total > catalog.files.length) return [];
  return catalog.files.map((f) => f.filePath);
}

/**
 * Pipeline retrieval nâng cao:
 * - Query expansion → multiple variants
 * - HyDE (hypothetical answer) → embed cùng query gốc
 * - Search parallel cho từng variant
 * - Union + dedupe
 * - Rerank với topK adaptive
 */
/**
 * Câu hỏi tổng quan về một tài liệu được nhắc đích danh ("nội dung SOP IT 1012") → các file
 * cần lấy phần mở đầu: SOP chính trong danh mục (không phải biểu mẫu/phụ lục).
 * Nếu user hỏi đích danh một biểu mẫu/phụ lục thì không áp dụng (để vector search xử lý).
 */
function overviewPathsOf(query: string, catalog: CatalogMatch | null): string[] {
  const focus = focusPathsOf(catalog);
  if (focus.length === 0 || !isOverviewQuestion(query) || mentionsFormOrAppendix(query)) return [];

  const mainDocs = catalog!.files.filter((f) => isMainDocument(f.fileName)).map((f) => f.filePath);
  return mainDocs.length > 0 ? mainDocs : focus;
}

async function enhancedRetrieve(
  query: string,
  complexity: "simple" | "complex",
  focusFilePaths: string[] = [],
  overviewFilePaths: string[] = []
): Promise<{ reranked: SearchResult[]; stats: any }> {
  const stats: any = {};

  const allResults: SearchResult[] = [];
  const seen = new Set<string>();
  const addResult = (r: SearchResult) => {
    const key = `${r.filePath}::${r.text.slice(0, 60)}`;
    if (!seen.has(key)) {
      seen.add(key);
      allResults.push(r);
    }
  };

  /**
   * Câu hỏi nhắc đích danh mã tài liệu ("SOP 0005 quy định gì về...") → tìm riêng trong các file
   * của tài liệu đó và xếp lên đầu. Nội dung chunk không chứa mã nên vector search thuần
   * không biết chunk nào thuộc SOP nào. Vẫn tìm thêm trên toàn bộ (ít hơn) để không bỏ sót
   * khi con số trong câu hỏi không phải mã tài liệu.
   */
  const searchWithFocus = async (vec: number[]) => {
    if (focusFilePaths.length === 0) {
      for (const r of await searchSimilar(vec, config.topK)) addResult(r);
      return;
    }
    const [focused, general] = await Promise.all([
      searchSimilar(vec, config.topK, focusFilePaths),
      searchSimilar(vec, Math.ceil(config.topK / 2)),
    ]);
    stats.focused_candidates = focused.length;
    for (const r of focused) addResult(r);
    for (const r of general) addResult(r);
  };

  // ============== OVERVIEW: phần mở đầu của tài liệu, theo thứ tự ==============
  // Không rerank: câu hỏi kiểu "nội dung SOP X" không có gì để chấm độ liên quan,
  // thứ tự trong tài liệu mới là thứ cần giữ.
  if (overviewFilePaths.length > 0) {
    stats.mode = "overview";
    // Phần mở đầu chiếm ~60% số đoạn, còn lại là đoạn giống câu hỏi nhất trong tài liệu,
    // để câu hỏi nghe như tổng quan nhưng thật ra hỏi chi tiết ("nội dung phần sao lưu") vẫn có đáp án.
    const openingBudget = Math.ceil(config.rerankTopK * OVERVIEW_OPENING_RATIO);
    const perFile = Math.max(1, Math.ceil(openingBudget / overviewFilePaths.length));
    const [opening, similar] = await Promise.all([
      fetchOpeningChunks(overviewFilePaths, perFile),
      embedQuery(query).then((vec) => searchSimilar(vec, config.topK, focusFilePaths)),
    ]);
    for (const r of opening.slice(0, openingBudget)) addResult(r);
    stats.opening_chunks = allResults.length;
    for (const r of similar) addResult(r);
    stats.unique_candidates = allResults.length;
    const reranked = allResults.slice(0, config.rerankTopK);
    stats.reranked_count = reranked.length;
    return { reranked, stats };
  }

  // ============== SIMPLE PIPELINE (khi flag off) ==============
  if (!config.enhancedRetrieval) {
    stats.mode = "simple";
    await searchWithFocus(await embedQuery(query));
    const reranked = await rerankChunks(query, allResults, config.rerankTopK);
    stats.unique_candidates = allResults.length;
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
  await searchWithFocus(await embedQuery(primaryText));

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

/**
 * Câu hỏi rà quy định trùng lặp / so sánh giữa các SOP → các cặp đoạn gần nghĩa nhất để LLM phân tích.
 * Trả về null nếu không phải dạng câu hỏi này (đi tiếp luồng tìm kiếm thông thường).
 */
async function overlapContextFor(query: string, catalog: CatalogMatch | null): Promise<OverlapContext | null> {
  const wantsOverlap = isOverlapQuestion(query);
  const wantsCompare = isCompareQuestion(query);
  if (!wantsOverlap && !wantsCompare) return null;

  try {
    return await findOverlapContext(query, catalog, wantsCompare, wantsOverlap);
  } catch (err) {
    fastify.log.warn(`Overlap analysis failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Câu hỏi về hồ sơ QualZen (Action Item, CCN, CAPA) → system prompt chứa dữ liệu truy vấn được.
 * Trả về null nếu tính năng tắt hoặc câu hỏi là về tài liệu SOP (đi tiếp luồng RAG bình thường).
 */
async function qualzenPromptFor(
  query: string,
  history: ChatMessage[]
): Promise<string | null> {
  if (!config.qualzenEnabled) return null;

  // Câu hỏi tiếp nối ("còn cái nào quá hạn?") không tự chứa từ khóa → xét cả lượt hỏi-đáp gần nhất.
  // Không dựa vào intent vì bộ phân loại có thể coi câu đó là câu hỏi mới.
  const recentContext = history.slice(-2).map((m) => m.content.slice(0, 500)).join("\n");
  if (!looksLikeQualzenQuestion(`${query}\n${recentContext}`)) return null;

  const data = await answerDataForQualzen(query, history);
  if (!data) return null;

  fastify.log.info({ query, plan: data.plan }, "qualzen_query");
  return buildQualzenSystemPrompt(data.dataJson, data.queriedAt);
}

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
    let sysPrompt = await qualzenPromptFor(query, limitedHistory);
    let maxTokens = sysPrompt ? QUALZEN_MAX_ANSWER_TOKENS : undefined;

    if (!sysPrompt) {
      const complexity = classifyComplexity(query);
      const searchQuery =
        intent === "FOLLOW_UP" ? await rewriteFollowUpQuery(query, limitedHistory) : query;
      const catalog = await findCatalogForQuery(`${query} ${searchQuery}`);
      const overlap = await overlapContextFor(searchQuery, catalog);
      const reranked = overlap
        ? overlap.chunks
        : (
            await enhancedRetrieve(
              searchQuery,
              complexity,
              focusPathsOf(catalog),
              overviewPathsOf(searchQuery, catalog)
            )
          ).reranked;

      sources = reranked.map((r) => ({
        fileName: r.fileName,
        category: r.category,
        sheetName: r.sheetName,
        score: r.score,
      }));

      const useCoT = complexity === "complex";
      if (overlap) {
        sysPrompt = buildOverlapSystemPrompt(overlap);
        maxTokens = OVERLAP_MAX_ANSWER_TOKENS;
      } else {
        sysPrompt =
          intent === "FOLLOW_UP"
            ? buildFollowUpSystemPrompt(reranked, catalog)
            : buildSOPSystemPrompt(reranked, useCoT, catalog);
      }
    }

    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    for await (const delta of streamChatCompletion(sysPrompt, messages, maxTokens)) {
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
    let maxTokens: number | undefined;
    // Mọi file có đoạn trích đưa vào prompt (không trùng), theo thứ tự ưu tiên
    const retrievedSources: UiSource[] = [];

    // Câu hỏi về hồ sơ QualZen (Action Item, CCN, CAPA) trả lời từ database, không qua tài liệu SOP
    const qualzenPrompt =
      intent === "CHITCHAT" ? null : await qualzenPromptFor(query, limitedHistory);

    if (intent === "CHITCHAT") {
      sysPrompt = buildChitChatSystemPrompt();
      send("sources", { sources: [] });
    } else if (qualzenPrompt) {
      sysPrompt = qualzenPrompt;
      maxTokens = QUALZEN_MAX_ANSWER_TOKENS;
      send("sources", { sources: [] });
    } else {
      // 1. Classify complexity
      const complexity = classifyComplexity(query);
      send("complexity", { complexity });

      // 2. Follow-up: viết lại thành truy vấn độc lập để tìm đúng chủ đề đang nói
      const searchQuery =
        intent === "FOLLOW_UP" ? await rewriteFollowUpQuery(query, limitedHistory) : query;

      // 3. Enhanced retrieve (HyDE + Query Expansion + Rerank)
      // Tra danh mục file theo mã tài liệu trong câu hỏi: dùng cho câu hỏi đếm/liệt kê,
      // và để ưu tiên tìm trong đúng các file của tài liệu được nhắc tới
      const catalog = await findCatalogForQuery(`${query} ${searchQuery}`);

      // Câu hỏi rà quy định trùng lặp / so sánh giữa các SOP: ghép các đoạn gần nghĩa nhất thay cho tìm kiếm thường
      const overlap = await overlapContextFor(searchQuery, catalog);
      const { reranked, stats } = overlap
        ? { reranked: overlap.chunks, stats: overlap.stats }
        : await enhancedRetrieve(
            searchQuery,
            complexity,
            focusPathsOf(catalog),
            overviewPathsOf(searchQuery, catalog)
          );
      fastify.log.info(
        { query, searchQuery, intent, complexity, catalog_files: catalog?.total ?? 0, ...stats },
        "retrieval_stats"
      );

      // 4. Dedupe sources theo file
      const seenFiles = new Set<string>();
      for (const r of reranked) {
        const key = `${r.fileName}::${r.sheetName || ""}`;
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          retrievedSources.push({
            fileName: r.fileName,
            category: r.category,
            sheetName: r.sheetName,
            score: Math.round(r.score * 1000) / 1000,
          });
        }
      }
      // Gửi trước khi có câu trả lời (app bản cũ hiển thị danh sách này).
      // Danh sách chính thức nằm trong event "done", sau khi biết câu trả lời dùng nguồn nào.
      send("sources", { sources: retrievedSources.slice(0, MAX_UI_SOURCES) });

      // 5. Build prompt (CoT khi complex, SOP vs FOLLOW_UP vs CHITCHAT)
      const useCoT = complexity === "complex";
      if (overlap) {
        sysPrompt = buildOverlapSystemPrompt(overlap);
        maxTokens = OVERLAP_MAX_ANSWER_TOKENS;
      } else {
        sysPrompt =
          intent === "FOLLOW_UP"
            ? buildFollowUpSystemPrompt(reranked, catalog)
            : buildSOPSystemPrompt(reranked, useCoT, catalog);
      }
    }

    // 6. Stream LLM response
    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    let answer = "";
    for await (const delta of streamChatCompletion(sysPrompt, messages, maxTokens)) {
      answer += delta;
      send("chunk", { delta });
    }

    // 7. Nguồn hiển thị: chỉ các file câu trả lời thật sự dùng; không có gì nếu "không tìm thấy"
    send("done", {
      intent,
      sources: selectDisplayedSources(answer, retrievedSources, MAX_UI_SOURCES),
    });
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
    console.log(`   QualZen:     ${config.qualzenEnabled ? "BẬT (Action Item, CCN, CAPA)" : "tắt (chưa có QUALZEN_DB_*)"}`);
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

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
  classifyComplexity,
  isOverviewQuestion,
  expandQuery,
  generateHypotheticalAnswer,
  rerankChunks,
  buildSOPSystemPrompt,
  buildFollowUpSystemPrompt,
  buildChitChatSystemPrompt,
  buildQualzenSystemPrompt,
  buildQualzenListIntroPrompt,
  buildInventoryIntroPrompt,
  buildOverlapSystemPrompt,
  isOverlapQuestion,
  isCompareQuestion,
  streamChatCompletion,
  type ChatMessage,
  type Intent,
} from "./llmService.js";
import { selectDisplayedSources, type UiSource } from "./citedSources.js";
import { answerDataForQualzen, QUALZEN_LIST_HEADING } from "./qualzenAssistant.js";
import { findOverlapContext, type OverlapContext } from "./overlapFinder.js";
import { INVENTORY_LIST_HEADING, inventoryReplyFor } from "./docInventory.js";
import { routeQuery, type RoutedQuery } from "./queryRouter.js";
import { expandWithGlossary } from "./glossary.js";
import { logFeedback, logInteraction } from "./interactionLog.js";
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
// Danh sách dài do server tự in: LLM chỉ viết đoạn mở đầu
const QUALZEN_LIST_INTRO_MAX_TOKENS = 1200;
const INVENTORY_INTRO_MAX_TOKENS = 1000;
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
    let content = m.content;
    // Danh sách do server in (phiếu QualZen, tài liệu trong kho) có thể rất dài: bỏ khỏi lịch sử
    // để câu hỏi sau không vượt hạn mức token
    if (m.role === "assistant") {
      const starts = [QUALZEN_LIST_HEADING, INVENTORY_LIST_HEADING].map((h) => content.indexOf(h)).filter((i) => i >= 0);
      if (starts.length > 0) content = `${content.slice(0, Math.min(...starts))}(Kèm danh sách chi tiết, đã lược bỏ ở đây.)`;
    }
    clean.push({ role: m.role, content: content.slice(0, MAX_HISTORY_CONTENT_CHARS) });
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
function overviewPathsOf(query: string, catalog: CatalogMatch | null, wantsOverview: boolean): string[] {
  const focus = focusPathsOf(catalog);
  if (focus.length === 0 || !wantsOverview || mentionsFormOrAppendix(query)) return [];

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
  // keywordText: câu hỏi gốc, để tìm kết hợp theo từ khóa (mã số, tên thiết bị...) nếu collection hỗ trợ
  const searchWithFocus = async (vec: number[], keywordText: string) => {
    if (focusFilePaths.length === 0) {
      for (const r of await searchSimilar(vec, config.topK, undefined, undefined, keywordText)) addResult(r);
      return;
    }
    const [focused, general] = await Promise.all([
      searchSimilar(vec, config.topK, focusFilePaths, undefined, keywordText),
      searchSimilar(vec, Math.ceil(config.topK / 2), undefined, undefined, keywordText),
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
      embedQuery(query).then((vec) => searchSimilar(vec, config.topK, focusFilePaths, undefined, query)),
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
    await searchWithFocus(await embedQuery(query), query);
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
  await searchWithFocus(await embedQuery(primaryText), query);

  const secondaryK = Math.max(5, Math.floor(config.topK / 2));
  await Promise.all(
    variants.map(async (variant) => {
      try {
        const vec = await embedQuery(variant);
        const results = await searchSimilar(vec, secondaryK, undefined, undefined, variant);
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

interface PreparedReply {
  prompt: string;
  maxTokens: number;
  // Danh sách dài: server in thẳng sau phần mở đầu của LLM (không tốn token)
  list: { markdown: string; fallbackIntro: string } | null;
}

/**
 * Câu hỏi về hồ sơ QualZen (Action Item, CCN, CAPA) → system prompt chứa dữ liệu truy vấn được.
 * Trả về null nếu tính năng tắt hoặc bước lập kế hoạch thấy đây là câu hỏi về tài liệu SOP.
 */
async function qualzenReplyFor(query: string, history: ChatMessage[], routed: boolean): Promise<PreparedReply | null> {
  if (!config.qualzenEnabled) return null;

  const data = await answerDataForQualzen(query, history, routed);
  if (!data) return null;

  fastify.log.info({ query, plan: data.plan, serverList: !!data.list, promptChars: data.dataJson.length }, "qualzen_query");
  return data.list
    ? {
        prompt: buildQualzenListIntroPrompt(data.dataJson, data.queriedAt),
        maxTokens: QUALZEN_LIST_INTRO_MAX_TOKENS,
        list: data.list,
      }
    : { prompt: buildQualzenSystemPrompt(data.dataJson, data.queriedAt), maxTokens: QUALZEN_MAX_ANSWER_TOKENS, list: null };
}

/** "Phòng QA có bao nhiêu SOP", "liệt kê biểu mẫu của IT": đếm trên danh mục file thay vì đoạn trích. */
async function inventoryReplyForRoute(route: RoutedQuery): Promise<PreparedReply | null> {
  const fromModel = route.source === "llm";
  const inventory = await inventoryReplyFor(route.standaloneQuery, {
    routed: fromModel,
    departments: fromModel ? route.departments : undefined,
    docTypes: fromModel ? route.docTypes : undefined,
    wantsList: route.wantsList,
  });
  if (!inventory) return null;

  fastify.log.info({ question: route.standaloneQuery, summary: JSON.parse(inventory.summaryJson) }, "inventory_query");
  return {
    prompt: buildInventoryIntroPrompt(inventory.summaryJson),
    maxTokens: INVENTORY_INTRO_MAX_TOKENS,
    list: inventory.list,
  };
}

/** Rà quy định trùng lặp / so sánh giữa các SOP → các cặp đoạn gần nghĩa nhất để LLM phân tích. */
async function overlapContextFor(route: RoutedQuery, catalog: CatalogMatch | null): Promise<OverlapContext | null> {
  const query = route.standaloneQuery;
  const fromModel = route.source === "llm";
  const wantsOverlap = fromModel ? route.task === "overlap_check" : isOverlapQuestion(query);
  const wantsCompare = fromModel ? route.task === "doc_compare" : isCompareQuestion(query);
  if (!wantsOverlap && !wantsCompare) return null;

  try {
    return await findOverlapContext(
      query,
      catalog,
      wantsCompare,
      wantsOverlap,
      fromModel ? { topic: route.topic, department: route.departments[0] ?? null } : undefined
    );
  } catch (err) {
    fastify.log.warn(`Overlap analysis failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Câu trả lời kèm danh sách do server in. Nếu LLM lỗi trước khi viết được chữ nào
 * (vd hết hạn mức Groq) thì vẫn trả danh sách, kèm một câu mở đầu dựng sẵn.
 */
async function* streamPreparedAnswer(reply: PreparedReply, messages: ChatMessage[]): AsyncGenerator<string> {
  let wroteAny = false;
  try {
    for await (const delta of streamChatCompletion(reply.prompt, messages, reply.maxTokens)) {
      wroteAny = true;
      yield delta;
    }
  } catch (err) {
    if (!reply.list || wroteAny) throw err;
    fastify.log.warn({ err: (err as Error).message }, "list_intro_failed");
    yield reply.list.fallbackIntro;
  }
  if (reply.list) yield reply.list.markdown;
}

interface AnswerPlan {
  intent: Intent;
  route: RoutedQuery;
  reply: PreparedReply;
  // Mọi file có đoạn trích đưa vào prompt (không trùng), theo thứ tự ưu tiên
  retrievedSources: UiSource[];
}

type Emit = (event: string, data: unknown) => void;

/**
 * Chuẩn bị câu trả lời: hiểu câu hỏi (một lần gọi model) → chọn nhánh → lấy dữ liệu → prompt.
 * Dùng chung cho /query và /query/stream để hai endpoint luôn trả lời giống nhau.
 */
async function prepareAnswer(query: string, history: ChatMessage[], emit: Emit = () => {}): Promise<AnswerPlan> {
  const route = await routeQuery(query, history);
  const intent: Intent = route.task === "chitchat" ? "CHITCHAT" : route.followUp ? "FOLLOW_UP" : "NEW_QUESTION";
  emit("intent", { intent });
  fastify.log.info({ query, route }, "route_query");

  const noSources = (reply: PreparedReply): AnswerPlan => {
    emit("sources", { sources: [] });
    return { intent, route, reply, retrievedSources: [] };
  };

  if (route.task === "chitchat") {
    return noSources({ prompt: buildChitChatSystemPrompt(), maxTokens: 2048, list: null });
  }

  // Hồ sơ QualZen: trả lời từ database. Bước lập kế hoạch vẫn có thể thấy đây là câu hỏi về
  // tài liệu → đi tiếp luồng SOP bên dưới.
  if (route.task === "qualzen") {
    const qualzen = await qualzenReplyFor(query, history, route.source === "llm");
    if (qualzen) return noSources(qualzen);
  }

  // Kho tài liệu: đếm / liệt kê trên danh mục file
  if (route.task === "doc_inventory") {
    const inventory = await inventoryReplyForRoute(route);
    if (inventory) return noSources(inventory);
  }

  // Còn lại: tìm trong tài liệu SOP
  const searchQuery = route.standaloneQuery;
  const complexity = classifyComplexity(searchQuery);
  emit("complexity", { complexity });

  // Tra danh mục file theo mã tài liệu: dùng cho câu hỏi đếm / liệt kê biểu mẫu của một SOP,
  // và để ưu tiên tìm trong đúng các file của tài liệu được nhắc tới
  const catalog = await findCatalogForQuery(`${query} ${searchQuery} ${route.docCodes.join(" ")}`);

  // Rà quy định trùng lặp / so sánh giữa các SOP: ghép các đoạn gần nghĩa nhất thay cho tìm kiếm thường
  const overlap = await overlapContextFor(route, catalog);
  const wantsOverview = route.source === "llm" ? route.task === "doc_overview" : isOverviewQuestion(searchQuery);
  // Tìm bằng cả các tên gọi khác trong bảng thuật ngữ ("tự thanh tra" → cả "self inspection")
  const retrievalQuery = overlap ? searchQuery : await expandWithGlossary(searchQuery);
  const { reranked, stats } = overlap
    ? { reranked: overlap.chunks, stats: overlap.stats }
    : await enhancedRetrieve(
        retrievalQuery,
        complexity,
        focusPathsOf(catalog),
        overviewPathsOf(searchQuery, catalog, wantsOverview)
      );
  fastify.log.info(
    { query, searchQuery, retrievalQuery, intent, task: route.task, complexity, catalog_files: catalog?.total ?? 0, ...stats },
    "retrieval_stats"
  );

  const retrievedSources: UiSource[] = [];
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
  emit("sources", { sources: retrievedSources.slice(0, MAX_UI_SOURCES) });

  if (overlap) {
    return { intent, route, reply: { prompt: buildOverlapSystemPrompt(overlap), maxTokens: OVERLAP_MAX_ANSWER_TOKENS, list: null }, retrievedSources };
  }
  const prompt = route.followUp
    ? buildFollowUpSystemPrompt(reranked, catalog)
    : buildSOPSystemPrompt(reranked, complexity === "complex", catalog);
  return { intent, route, reply: { prompt, maxTokens: 2048, list: null }, retrievedSources };
}

/**
 * Lỗi hiển thị cho người dùng: câu tiếng Việt dễ hiểu thay cho nguyên văn lỗi của Groq
 * (JSON tiếng Anh, lộ mã tổ chức). Lỗi gốc vẫn được ghi vào log.
 */
function userFacingError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? "";
  const waitText = (() => {
    const m = message.match(/try again in ((?:\d+h)?(?:\d+m)?[\d.]+s)/i);
    if (!m) return null;
    const hours = Number(m[1].match(/(\d+)h/)?.[1] ?? 0);
    const minutes = Number(m[1].match(/(\d+)m/)?.[1] ?? 0);
    const total = hours * 60 + minutes + 1; // làm tròn lên
    return total >= 60 ? `${Math.floor(total / 60)} giờ ${total % 60} phút` : `${total} phút`;
  })();

  // Một yêu cầu đã vượt giới hạn token/phút: hỏi lại y hệt cũng sẽ lỗi
  if (status === 413 || /request too large/i.test(message)) {
    return "Câu hỏi này cần đọc quá nhiều nội dung so với giới hạn hiện tại của hệ thống AI. Bạn hãy hỏi hẹp hơn (ví dụ một mục, một nội dung cụ thể) rồi thử lại.";
  }
  if (status === 429 || /rate.?limit/i.test(message)) {
    if (/per day|TPD|RPD/i.test(message)) {
      return `Hệ thống AI đã dùng hết lượt trong ngày. Vui lòng thử lại sau${waitText ? ` khoảng ${waitText}` : " ít phút"}.`;
    }
    return "Hệ thống AI đang nhận nhiều câu hỏi cùng lúc. Vui lòng thử lại sau khoảng 1 phút.";
  }
  return "Đã có lỗi khi tạo câu trả lời. Vui lòng thử lại; nếu vẫn lỗi, hãy báo quản trị viên.";
}

// JSON endpoint (debug)
fastify.post<{ Body: QueryBody }>("/query", async (request, reply) => {
  const { query, history } = request.body ?? ({} as QueryBody);
  const queryError = validateQuery(query);
  if (queryError) {
    return reply.code(400).send({ error: queryError });
  }

  const startedAt = Date.now();
  const answerId = crypto.randomUUID();
  const limitedHistory = sanitizeHistory(history);
  const plan = await prepareAnswer(query, limitedHistory);
  const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];

  let answer = "";
  for await (const delta of streamPreparedAnswer(plan.reply, messages)) {
    answer += delta;
  }
  void logInteraction({
    id: answerId,
    query,
    historyTurns: limitedHistory.length,
    intent: plan.intent,
    route: plan.route,
    answer,
    sources: plan.retrievedSources.map((s) => s.fileName),
    ms: Date.now() - startedAt,
  });
  return { answerId, intent: plan.intent, answer, sources: plan.retrievedSources };
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

  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Mã câu trả lời: app gửi kèm khi người dùng bấm 👍/👎 (POST /feedback)
  const answerId = crypto.randomUUID();
  const startedAt = Date.now();
  const limitedHistory = sanitizeHistory(history);
  let plan: AnswerPlan | null = null;
  let answer = "";
  let shownSources: UiSource[] = [];
  let error: string | undefined;

  try {
    plan = await prepareAnswer(query, limitedHistory, send);

    const messages: ChatMessage[] = [...limitedHistory, { role: "user", content: query }];
    for await (const delta of streamPreparedAnswer(plan.reply, messages)) {
      answer += delta;
      send("chunk", { delta });
    }

    // Nguồn hiển thị: chỉ các file câu trả lời thật sự dùng; không có gì nếu "không tìm thấy"
    shownSources = selectDisplayedSources(answer, plan.retrievedSources, MAX_UI_SOURCES);
    send("done", { answerId, intent: plan.intent, sources: shownSources });
  } catch (err) {
    error = (err as Error).message;
    fastify.log.error(err);
    send("error", { message: userFacingError(err) });
  } finally {
    reply.raw.end();
    void logInteraction({
      id: answerId,
      query,
      historyTurns: limitedHistory.length,
      intent: plan?.intent ?? "",
      route: plan?.route ?? null,
      answer,
      sources: shownSources.map((s) => s.fileName),
      ms: Date.now() - startedAt,
      ...(error ? { error } : {}),
    });
  }
});

// Phản hồi 👍/👎 cho một câu trả lời (answerId nhận từ event "done")
interface FeedbackBody {
  answerId?: unknown;
  rating?: unknown;
  comment?: unknown;
}
const ANSWER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FEEDBACK_COMMENT_CHARS = 1000;

fastify.post<{ Body: FeedbackBody }>("/feedback", async (request, reply) => {
  const { answerId, rating, comment } = request.body ?? {};
  if (typeof answerId !== "string" || !ANSWER_ID_PATTERN.test(answerId)) {
    return reply.code(400).send({ error: "answerId không hợp lệ" });
  }
  if (rating !== "up" && rating !== "down") {
    return reply.code(400).send({ error: "rating phải là up hoặc down" });
  }
  const note = typeof comment === "string" ? comment.trim().slice(0, MAX_FEEDBACK_COMMENT_CHARS) : "";
  await logFeedback({ id: answerId, rating, ...(note ? { comment: note } : {}) });
  return { ok: true };
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

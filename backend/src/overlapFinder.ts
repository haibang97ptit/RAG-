import { embed, embedQuery } from "./embedding.js";
import { getIndexedFiles, isMainDocument, type CatalogMatch } from "./fileCatalog.js";
import {
  fetchAllChunksWithVectors,
  fetchFileChunksWithVectors,
  searchSimilar,
  type ChunkWithVector,
  type CorpusChunk,
  type IndexedFile,
  type SearchResult,
} from "./qdrantService.js";

/**
 * Tìm QUY ĐỊNH TRÙNG LẶP giữa các SOP: cùng một chính sách được viết ở nhiều tài liệu,
 * tên mục và cách diễn đạt khác nhau (kể cả một bên tiếng Việt, một bên tiếng Anh).
 *
 * Cách làm: ghép theo độ gần NGỮ NGHĨA (vector) của từng MỤC, không theo tiêu đề mục.
 * Các đoạn đã index quá thô cho việc này (một đoạn thường chứa 2-3 mục, tiêu đề có khi nằm
 * ở cuối đoạn trước), nên lúc so sánh ta ghép lại toàn văn tài liệu, tách theo mục rồi embed lại.
 * Điểm giống không đủ để kết luận, nên đây chỉ là bước chọn ứng viên; LLM xét từng cặp có thật
 * sự cùng quy định không (xem buildOverlapSystemPrompt).
 *
 * 4 kiểu câu hỏi:
 *  - 2 tài liệu với nhau: "so sánh SOP 1012 và SOP 0020 có quy định nào trùng"
 *  - 1 tài liệu với phần còn lại: "SOP 1012 có quy định nào trùng lặp với các SOP khác"
 *  - theo chủ đề: "chính sách mật khẩu được quy định ở những SOP nào"
 *  - quét cả kho (không nêu SOP hay chủ đề): "các SOP của QA có SOP nào trùng lặp với SOP khác không"
 */

const MAX_PAIRS = 10;
// Đo với multilingual-e5-base trên từng mục: cùng quy định, cùng ngôn ngữ ≈ 0.90-0.92; cùng quy định
// Việt-Anh ≈ 0.85; khác chủ đề cùng ngôn ngữ có thể lên tới 0.88. Điểm tuyệt đối vì thế không đủ phân biệt,
// nên tiêu chí chính là KHỚP HAI CHIỀU: mục X và mục Y là lựa chọn gần nhất của nhau.
const MIN_MUTUAL_SCORE = 0.84; // sàn cho cặp khớp hai chiều
const HIGH_SCORE = 0.9; // giống tới mức này thì nhận cả khi không khớp hai chiều
const MAX_FILES_PER_SIDE = 3;
const MAX_CHUNKS_PER_SIDE = 150;
const MAX_UNITS_PER_SIDE = 200;

// Một "mục" để so khớp: đủ ngắn để chỉ nói về một việc
const UNIT_MAX_CHARS = 800;
const UNIT_MIN_BODY_CHARS = 80;
const EMBED_BATCH = 32;

// Đối chiếu 1 tài liệu với phần còn lại:
// bước 1 tìm các tài liệu có đoạn gần nghĩa nhất, bước 2 so từng mục với từng tài liệu đó
// (lấy rộng tay: đoạn cùng quy định nhưng khác ngôn ngữ có điểm thấp hơn đoạn khác chủ đề cùng ngôn ngữ)
const OTHERS_CANDIDATE_FILES = 5;
const OTHERS_SEARCH_K = 8;
const OTHERS_MAX_SECTIONS_PER_FILE = 80;
// Một mục có thể trùng với tối đa bấy nhiêu tài liệu khác
const OTHERS_MATCHES_PER_SECTION = 3;

const TOPIC_SEARCH_K = 40;
const TOPIC_MAX_FILES = 6;
const TOPIC_CHUNKS_PER_FILE = 2;

// Các mục khuôn mẫu mà SOP nào cũng có - giống nhau về hình thức chứ không phải cùng quy định.
// Chỉ tính khi tiêu đề NGẮN và BẮT ĐẦU bằng các từ này ("2. Phạm vi", "1. Purpose and scope"),
// để không loại nhầm mục thật như "5.4 Approval of suppliers" hay "Trách nhiệm xử lý sự cố mất dữ liệu".
const BOILERPLATE_START =
  /^(mục đích|phạm vi|định nghĩa|chữ viết tắt|từ viết tắt|thuật ngữ|trách nhiệm|tài liệu tham khảo|tài liệu liên quan|lịch sử sửa đổi|lịch sử thay đổi|phê duyệt|phân phối|purpose|objectives?|scope|definitions?|abbreviations?|responsibilit(y|ies)|references?|revision history|change history|approvals?|distribution)(?![\p{L}\p{N}])/iu;
const BOILERPLATE_MAX_WORDS = 5;

function isBoilerplateHeading(heading: string): boolean {
  const title = heading.replace(/^[\dIVXivx]+(\.\d+)*[.)]?\s+/, "").trim();
  return title.split(/\s+/).length <= BOILERPLATE_MAX_WORDS && BOILERPLATE_START.test(title);
}

type OverlapChunk = SearchResult & { heading?: string | null };

export interface OverlapPair {
  score: number;
  a: OverlapChunk;
  b: OverlapChunk;
}

/** Một cặp tài liệu nghi trùng nội dung, kết quả của việc quét cả kho. */
export interface ScanFilePair {
  fileA: string;
  categoryA: string;
  fileB: string;
  categoryB: string;
  similarChunks: number; // số đoạn rất giống nhau giữa 2 tài liệu
  bestScore: number;
  examples: { a: string; b: string }[];
}

export interface OverlapContext {
  mode: "pairs" | "topic" | "scan";
  labelA: string; // tài liệu được rà
  labelB: string; // tài liệu / nhóm tài liệu đem ra đối chiếu
  pairs: OverlapPair[];
  topicGroups: { fileName: string; category: string; chunks: SearchResult[] }[];
  scanPairs?: ScanFilePair[];
  scanScope?: string; // mô tả phạm vi đã quét
  // Mọi đoạn trích đưa vào prompt (để hiển thị nguồn)
  chunks: SearchResult[];
  stats: Record<string, unknown>;
}

interface Unit extends OverlapChunk {
  vector: number[];
}

// ============== Tách tài liệu thành các mục ==============

// Dòng tiêu đề: "## 5.3 Quản lý mật khẩu", "6.2.1 Kiểm soát truy cập", "4.5 User credentials"
function isHeading(paragraph: string): boolean {
  const text = paragraph.trim();
  if (text.includes("\n") || text.length > 110) return false;
  if (/^#{1,6}\s+\S/.test(text)) return true;
  return /^\d+(\.\d+)*[.)]?\s+\S/.test(text) && !/[.;:,]$/.test(text);
}

const cleanHeading = (heading: string) => heading.replace(/^#{1,6}\s+/, "").trim();

/**
 * Ghép các chunk của 1 file lại theo thứ tự rồi tách thành từng mục (tiêu đề + nội dung).
 * Bỏ phần bìa trước tiêu đề đầu tiên và các mục khuôn mẫu (mục đích, phạm vi...).
 */
export function splitIntoSections(chunks: ChunkWithVector[]): OverlapChunk[] {
  if (chunks.length === 0) return [];
  const { fileName, filePath, category, fileType } = chunks[0];

  const fullText = chunks
    .map((c) => c.text.replace(/^\[Tài liệu:[^\]]*\]\s*/, ""))
    .join("\n\n");
  const paragraphs = fullText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const sections: OverlapChunk[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  let seenHeading = false;

  const flush = () => {
    const text = body.join("\n");
    const isCover = !seenHeading; // phần trước tiêu đề đầu tiên: bìa, bảng ký duyệt
    const isBoilerplate = heading !== null && isBoilerplateHeading(heading);
    if (text.length >= UNIT_MIN_BODY_CHARS && !isCover && !isBoilerplate) {
      sections.push({
        score: 1,
        heading,
        text: heading ? `${heading}\n${text}` : text,
        fileName,
        filePath,
        category,
        fileType,
      });
    }
    body = [];
  };

  for (const paragraph of paragraphs) {
    if (isHeading(paragraph)) {
      flush();
      heading = cleanHeading(paragraph);
      seenHeading = true;
      continue;
    }
    // Mục dài thì cắt thành nhiều phần, giữ nguyên tiêu đề
    if (body.length > 0 && body.join("\n").length + paragraph.length > UNIT_MAX_CHARS) flush();
    body.push(paragraph);
  }
  flush();

  // Tài liệu không nhận ra tiêu đề nào (Word không dùng style Heading, không đánh số mục):
  // dùng luôn các chunk gốc, bỏ chunk đầu (bìa)
  if (sections.length === 0) {
    return chunks.slice(chunks.length > 2 ? 1 : 0).map(({ vector, chunkIndex, ...rest }) => ({ ...rest, heading: null }));
  }
  return sections.slice(0, MAX_UNITS_PER_SIDE);
}

async function embedSections(sections: OverlapChunk[]): Promise<Unit[]> {
  const units: Unit[] = [];
  for (let i = 0; i < sections.length; i += EMBED_BATCH) {
    const batch = sections.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map((s) => s.text));
    batch.forEach((section, k) => units.push({ ...section, vector: vectors[k] }));
  }
  return units;
}

// Tách mục + embed một tài liệu mất vài giây trên CPU → nhớ tạm, vì người dùng thường hỏi tiếp về cùng tài liệu.
// Hết hạn sau 30 phút để tài liệu được index lại sẽ được đọc mới.
const SECTION_CACHE_TTL_MS = 30 * 60 * 1000;
const SECTION_CACHE_MAX_FILES = 40;
const sectionCache = new Map<string, { units: Unit[]; loadedAt: number }>();

async function loadFileSections(file: IndexedFile): Promise<Unit[]> {
  const cached = sectionCache.get(file.filePath);
  if (cached && Date.now() - cached.loadedAt < SECTION_CACHE_TTL_MS) return cached.units;

  const chunks = await fetchFileChunksWithVectors([file.filePath], MAX_CHUNKS_PER_SIDE);
  const units = await embedSections(splitIntoSections(chunks));

  if (sectionCache.size >= SECTION_CACHE_MAX_FILES) {
    sectionCache.delete(sectionCache.keys().next().value as string); // bỏ mục cũ nhất
  }
  sectionCache.set(file.filePath, { units, loadedAt: Date.now() });
  return units;
}

async function loadSections(files: IndexedFile[], maxUnits = MAX_UNITS_PER_SIDE): Promise<{ units: Unit[] }> {
  const units: Unit[] = [];
  for (const file of files) units.push(...(await loadFileSections(file)));
  return { units: units.slice(0, maxUnits) };
}

// ============== Ghép cặp ==============

// Vector đã chuẩn hóa nên tích vô hướng = cosine
const dot = (a: number[], b: number[]) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/**
 * Ứng viên cặp trùng giữa 2 tài liệu: mục a và mục b là lựa chọn gần nhất CỦA NHAU,
 * hoặc giống nhau rất cao. Loại được các cặp "na ná" do cùng văn phong / cùng khuôn mẫu.
 */
export function mutualBestPairs(aUnits: Unit[], bUnits: Unit[]): OverlapPair[] {
  if (aUnits.length === 0 || bUnits.length === 0) return [];

  const scores = aUnits.map((a) => bUnits.map((b) => dot(a.vector, b.vector)));
  const bestForA = scores.map((row) => row.indexOf(Math.max(...row)));
  const bestForB = bUnits.map((_, j) => {
    let best = 0;
    for (let i = 1; i < aUnits.length; i++) if (scores[i][j] > scores[best][j]) best = i;
    return best;
  });

  const pairs: OverlapPair[] = [];
  for (let i = 0; i < aUnits.length; i++) {
    for (let j = 0; j < bUnits.length; j++) {
      const score = scores[i][j];
      const mutual = bestForA[i] === j && bestForB[j] === i;
      if ((mutual && score >= MIN_MUTUAL_SCORE) || score >= HIGH_SCORE) {
        pairs.push({ score, a: aUnits[i], b: bUnits[j] });
      }
    }
  }
  return pairs;
}

/**
 * Chọn các cặp giống nhau nhất. Mỗi đoạn phía B chỉ nằm trong 1 cặp.
 * @param maxPerA số cặp tối đa cho 1 mục phía A. So 2 tài liệu: 1. Đối chiếu với nhiều tài liệu: > 1,
 *                vì cùng một quy định có thể bị lặp ở vài tài liệu khác nhau (mỗi tài liệu tính 1 lần).
 */
export function selectTopPairs(candidates: OverlapPair[], maxPerA: number = 1): OverlapPair[] {
  const usedA = new Map<string, Set<string>>(); // mục A → các file B đã ghép
  const usedB = new Set<string>();
  const key = (c: SearchResult) => `${c.filePath}::${c.text.slice(0, 80)}`;
  const selected: OverlapPair[] = [];

  for (const pair of [...candidates].sort((x, y) => y.score - x.score)) {
    if (pair.score < MIN_MUTUAL_SCORE || selected.length >= MAX_PAIRS) break;
    const filesForA = usedA.get(key(pair.a)) ?? new Set<string>();
    if (filesForA.size >= maxPerA || filesForA.has(pair.b.filePath) || usedB.has(key(pair.b))) continue;
    filesForA.add(pair.b.filePath);
    usedA.set(key(pair.a), filesForA);
    usedB.add(key(pair.b));
    selected.push(pair);
  }
  return selected;
}

const withoutVector = ({ vector, ...rest }: Unit): OverlapChunk => rest;

// SOP chính của nhóm (không phải biểu mẫu / phụ lục); nhóm chỉ có biểu mẫu thì lấy cả nhóm
function mainFiles(group: IndexedFile[]): IndexedFile[] {
  const main = group.filter((f) => isMainDocument(f.fileName));
  return (main.length > 0 ? main : group).slice(0, MAX_FILES_PER_SIDE);
}

const label = (files: IndexedFile[]) => files.map((f) => f.fileName).join(", ");

async function compareTwoDocuments(groupA: IndexedFile[], groupB: IndexedFile[]): Promise<OverlapContext | null> {
  const filesA = mainFiles(groupA);
  const filesB = mainFiles(groupB);
  const [a, b] = await Promise.all([loadSections(filesA), loadSections(filesB)]);
  if (a.units.length === 0 || b.units.length === 0) return null;

  const pairs = selectTopPairs(mutualBestPairs(a.units, b.units)).map((p) => ({
    score: p.score,
    a: withoutVector(p.a as Unit),
    b: withoutVector(p.b as Unit),
  }));

  return {
    mode: "pairs",
    labelA: label(filesA),
    labelB: label(filesB),
    pairs,
    topicGroups: [],
    chunks: pairs.flatMap((p) => [p.a, p.b]),
    stats: { mode: "overlap_two_docs", sections_a: a.units.length, sections_b: b.units.length, pairs: pairs.length },
  };
}

/**
 * Một tài liệu đối chiếu với TOÀN BỘ các tài liệu khác, theo 2 bước:
 *  1. Mỗi mục tìm các đoạn gần nghĩa nhất trong kho → chọn ra vài tài liệu có khả năng trùng nhất.
 *  2. Tách các tài liệu đó thành mục và ghép hai chiều với tài liệu đang rà (chính xác hơn so theo đoạn).
 */
async function compareWithOthers(group: IndexedFile[]): Promise<OverlapContext | null> {
  const files = mainFiles(group);
  const a = await loadSections(files);
  if (a.units.length === 0) return null;

  // Loại cả biểu mẫu / phụ lục của chính SOP đó khỏi phía đối chiếu
  const exclude = group.map((f) => f.filePath);
  const bestScoreByFile = new Map<string, { file: IndexedFile; score: number }>();
  const BATCH = 10;
  for (let i = 0; i < a.units.length; i += BATCH) {
    const batch = a.units.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((unit) => searchSimilar(unit.vector, OTHERS_SEARCH_K, undefined, exclude))
    );
    for (const match of results.flat()) {
      const current = bestScoreByFile.get(match.filePath);
      if (!current || match.score > current.score) {
        bestScoreByFile.set(match.filePath, {
          file: { fileName: match.fileName, filePath: match.filePath, category: match.category },
          score: match.score,
        });
      }
    }
  }
  const candidateFiles = Array.from(bestScoreByFile.values())
    .sort((x, y) => y.score - x.score)
    .slice(0, OTHERS_CANDIDATE_FILES)
    .map((c) => c.file);

  const candidates: OverlapPair[] = [];
  for (const file of candidateFiles) {
    const b = await loadSections([file], OTHERS_MAX_SECTIONS_PER_FILE);
    candidates.push(...mutualBestPairs(a.units, b.units));
  }

  const pairs = selectTopPairs(candidates, OTHERS_MATCHES_PER_SECTION).map((p) => ({
    score: p.score,
    a: withoutVector(p.a as Unit),
    b: withoutVector(p.b as Unit),
  }));
  return {
    mode: "pairs",
    labelA: label(files),
    labelB: `các tài liệu khác (đã đối chiếu kỹ với: ${candidateFiles.map((f) => f.fileName).join("; ")})`,
    pairs,
    topicGroups: [],
    chunks: pairs.flatMap((p) => [p.a, p.b]),
    stats: {
      mode: "overlap_doc_vs_all",
      sections_a: a.units.length,
      candidate_files: candidateFiles.length,
      pairs: pairs.length,
    },
  };
}

/** Một chủ đề được viết ở những tài liệu nào: lấy các đoạn liên quan nhất, gom theo file. */
async function findTopicAcrossDocuments(query: string): Promise<OverlapContext | null> {
  const results = await searchSimilar(await embedQuery(query), TOPIC_SEARCH_K);

  const byFile = new Map<string, SearchResult[]>();
  for (const r of results) {
    const list = byFile.get(r.filePath) ?? [];
    if (list.length < TOPIC_CHUNKS_PER_FILE) list.push(r);
    byFile.set(r.filePath, list);
  }
  // Map giữ thứ tự chèn = thứ tự file có đoạn liên quan nhất
  const topicGroups = Array.from(byFile.values())
    .slice(0, TOPIC_MAX_FILES)
    .map((chunks) => ({ fileName: chunks[0].fileName, category: chunks[0].category, chunks }));
  if (topicGroups.length < 2) return null;

  return {
    mode: "topic",
    labelA: "",
    labelB: "",
    pairs: [],
    topicGroups,
    chunks: topicGroups.flatMap((g) => g.chunks),
    stats: { mode: "overlap_topic", files: topicGroups.length },
  };
}

// ============== Quét cả kho ==============

// Quét theo các đoạn đã index (không tách mục lại - quá nặng cho cả kho), nên chỉ là bước KHOANH VÙNG:
// kết quả là danh sách cặp tài liệu nghi trùng để người dùng hỏi tiếp "so sánh SOP X và SOP Y".
const SCAN_MAX_CHUNKS = 6000;
const SCAN_MIN_SCORE = 0.9; // hai đoạn (mỗi đoạn có thể chứa vài mục) giống tới mức này mới tính
const SCAN_MAX_FILE_PAIRS = 8;
const SCAN_EXAMPLES_PER_PAIR = 2;
const SCAN_EXAMPLE_CHARS = 450;
const SCAN_CACHE_TTL_MS = 30 * 60 * 1000;
const scanCache = new Map<string, { result: ScanFilePair[]; stats: Record<string, unknown>; loadedAt: number }>();

function dotTyped(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const clipExample = (text: string) => {
  const clean = text.replace(/^\[Tài liệu:[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
  return clean.length > SCAN_EXAMPLE_CHARS ? clean.slice(0, SCAN_EXAMPLE_CHARS) + "…" : clean;
};

/**
 * Với mỗi đoạn của các tài liệu nguồn, tìm đoạn giống nhất ở MỖI tài liệu khác; đếm số đoạn rất giống
 * theo từng cặp tài liệu. Chỉ xét SOP chính (bỏ biểu mẫu, phụ lục - vốn giống nhau theo mẫu) và bỏ đoạn bìa.
 * @param department chỉ lấy tài liệu nguồn thuộc phòng ban này (null = mọi phòng ban)
 */
export function scanChunksForOverlap(all: CorpusChunk[], department: string | null): ScanFilePair[] {
  const usable = all.filter((c) => isMainDocument(c.fileName) && c.chunkIndex > 0);
  const byFile = new Map<string, CorpusChunk[]>();
  for (const chunk of usable) {
    const list = byFile.get(chunk.filePath) ?? [];
    list.push(chunk);
    byFile.set(chunk.filePath, list);
  }
  const files = Array.from(byFile.keys());
  const inScope = (filePath: string) =>
    !department || byFile.get(filePath)![0].category.toLowerCase() === department.toLowerCase();

  const pairs: ScanFilePair[] = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      // Ít nhất một bên phải thuộc phòng ban được hỏi
      if (!inScope(files[i]) && !inScope(files[j])) continue;
      const a = byFile.get(files[i])!;
      const b = byFile.get(files[j])!;

      // Mỗi đoạn của A lấy đoạn giống nhất bên B; mỗi đoạn của B chỉ tính 1 lần
      const matches: { score: number; a: CorpusChunk; b: CorpusChunk }[] = [];
      const usedB = new Set<number>();
      for (const ca of a) {
        let best = -1;
        let bestScore = SCAN_MIN_SCORE;
        for (let k = 0; k < b.length; k++) {
          if (usedB.has(k)) continue;
          const score = dotTyped(ca.vector, b[k].vector);
          if (score >= bestScore) {
            bestScore = score;
            best = k;
          }
        }
        if (best >= 0) {
          usedB.add(best);
          matches.push({ score: bestScore, a: ca, b: b[best] });
        }
      }
      if (matches.length === 0) continue;

      matches.sort((x, y) => y.score - x.score);
      pairs.push({
        fileA: a[0].fileName,
        categoryA: a[0].category,
        fileB: b[0].fileName,
        categoryB: b[0].category,
        similarChunks: matches.length,
        bestScore: matches[0].score,
        examples: matches
          .slice(0, SCAN_EXAMPLES_PER_PAIR)
          .map((m) => ({ a: clipExample(m.a.text), b: clipExample(m.b.text) })),
      });
    }
  }

  return pairs
    .sort((x, y) => y.similarChunks - x.similarChunks || y.bestScore - x.bestScore)
    .slice(0, SCAN_MAX_FILE_PAIRS);
}

async function scanWholeCorpus(department: string | null): Promise<OverlapContext> {
  const cacheKey = (department ?? "*").toLowerCase();
  let cached = scanCache.get(cacheKey);
  if (!cached || Date.now() - cached.loadedAt > SCAN_CACHE_TTL_MS) {
    const startedAt = Date.now();
    const all = await fetchAllChunksWithVectors(SCAN_MAX_CHUNKS);
    const result = scanChunksForOverlap(all, department);
    const mainDocs = new Set(all.filter((c) => isMainDocument(c.fileName)).map((c) => c.filePath)).size;
    cached = {
      result,
      stats: { chunks: all.length, main_documents: mainDocs, scan_ms: Date.now() - startedAt },
      loadedAt: Date.now(),
    };
    scanCache.set(cacheKey, cached);
  }

  const scope = department
    ? `các SOP chính của phòng ${department.toUpperCase()}, đối chiếu với mọi SOP chính khác (${cached.stats.main_documents} tài liệu)`
    : `toàn bộ ${cached.stats.main_documents} SOP chính trong hệ thống`;
  return {
    mode: "scan",
    labelA: "",
    labelB: "",
    pairs: [],
    topicGroups: [],
    scanPairs: cached.result,
    scanScope: scope,
    chunks: [],
    stats: { mode: "overlap_scan", department, file_pairs: cached.result.length, ...cached.stats },
  };
}

// Từ không mang chủ đề: nếu bỏ hết các từ này mà câu hỏi không còn gì thì người dùng đang hỏi chung chung
const GENERIC_WORDS = new Set(
  "sop sops các những mọi tất cả toàn bộ tài liệu quy trình định chính sách nào có không trùng lặp nhau với khác nội dung trong của và hay hoặc bị chồng chéo mâu thuẫn giữa phòng ban bộ phận hệ thống kiểm tra rà soát giúp tôi anh em chị mình cho xem liệt kê hiện tại nay đang được ở là gì thì hãy xin vui lòng tìm thấy cái phần đoạn mục bất kỳ nào đó chưa rồi nhé ạ document documents procedure procedures any other overlap overlapping duplicate duplicated with between is are there the of in and or do does have has"
    .split(" ")
);

/**
 * Câu hỏi không nêu chủ đề cụ thể → trả về phòng ban được nhắc tới (hoặc null = cả kho).
 * Câu hỏi có chủ đề ("chính sách mật khẩu ở những SOP nào") → trả về undefined.
 */
export function detectCorpusScan(query: string, categories: string[]): { department: string | null } | undefined {
  const tokens = query.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const categoryByToken = new Map(categories.map((c) => [c.toLowerCase(), c]));

  let department: string | null = null;
  let topicTokens = 0;
  for (const token of tokens) {
    if (categoryByToken.has(token)) department = categoryByToken.get(token)!;
    else if (!GENERIC_WORDS.has(token)) topicTokens++;
  }
  return topicTokens <= 1 ? { department } : undefined;
}

/**
 * @param wantsCompare câu hỏi có ý so sánh giữa các tài liệu được nêu mã
 * @param wantsOverlap câu hỏi nói rõ về trùng lặp / chồng chéo / "quy định ở những SOP nào"
 */
export async function findOverlapContext(
  query: string,
  catalog: CatalogMatch | null,
  wantsCompare: boolean,
  wantsOverlap: boolean
): Promise<OverlapContext | null> {
  // Danh mục bị cắt bớt = con số trong câu hỏi nhiều khả năng không phải mã tài liệu
  const groups = catalog && catalog.total <= catalog.files.length ? catalog.groups : [];

  if (groups.length >= 2 && (wantsCompare || wantsOverlap)) {
    return compareTwoDocuments(groups[0], groups[1]);
  }
  if (!wantsOverlap) return null;
  if (groups.length === 1) return compareWithOthers(groups[0]);

  // Không nêu SOP nào: có chủ đề cụ thể thì tìm theo chủ đề, không thì quét cả kho
  const categories = Array.from(new Set((await getIndexedFiles()).map((f) => f.category)));
  const scan = detectCorpusScan(query, categories);
  return scan ? scanWholeCorpus(scan.department) : findTopicAcrossDocuments(query);
}

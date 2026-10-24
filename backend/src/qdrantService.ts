import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";
import { getEmbeddingDimension } from "./embedding.js";
import { toSparseVector, type SparseVector } from "./sparseVector.js";

// Tên vector thưa (tìm theo từ khóa). Vector nghĩa (dense) là vector không tên ("").
const SPARSE_NAME = "text";
// Mỗi nhánh (nghĩa / từ khóa) lấy nhiều hơn số cần rồi trộn bằng RRF
const HYBRID_PREFETCH_FACTOR = 2;

let client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url: config.qdrantUrl });
  }
  return client;
}

export async function ensureCollection(reset: boolean = false): Promise<void> {
  const c = getQdrantClient();
  const collectionName = config.collectionName;

  if (reset) {
    try {
      await c.deleteCollection(collectionName);
      console.log(`   🗑️  Deleted collection '${collectionName}'`);
    } catch {}
  }

  const collections = await c.getCollections();
  const exists = collections.collections.some((col) => col.name === collectionName);

  if (!exists) {
    await c.createCollection(collectionName, {
      vectors: {
        size: getEmbeddingDimension(),
        distance: "Cosine",
      },
      // Tìm theo từ khóa: Qdrant tự tính IDF từ toàn bộ kho
      sparse_vectors: { [SPARSE_NAME]: { modifier: "idf" } },
    } as any);

    console.log(`   ✓ Created collection '${collectionName}' (tìm theo nghĩa + từ khóa)`);
  }
  hybridCache = null;

  // Payload index để delete theo file nhanh (dùng cho incremental).
  // Chạy cả với collection đã có sẵn - tạo lại index đã tồn tại là no-op.
  for (const field of ["fileName", "filePath"]) {
    try {
      await c.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: "keyword",
      });
    } catch (err) {
      console.warn(`Could not create ${field} index:`, (err as Error).message);
    }
  }
}

let hybridCache: { collection: string; enabled: boolean } | null = null;

/**
 * Collection có vector từ khóa không. Collection tạo trước khi có tính năng này thì không
 * (cấu hình vector không thêm được vào collection có sẵn) → tìm theo nghĩa như cũ cho tới khi
 * index sang collection mới (xem docs/DEPLOY.md).
 */
export async function isHybridEnabled(): Promise<boolean> {
  if (hybridCache?.collection === config.collectionName) return hybridCache.enabled;
  try {
    const info: any = await getQdrantClient().getCollection(config.collectionName);
    const enabled = !!info.config?.params?.sparse_vectors?.[SPARSE_NAME];
    hybridCache = { collection: config.collectionName, enabled };
    return enabled;
  } catch {
    return false;
  }
}

/** Collection có vector từ khóa thì point trả về vector dạng { "": dense, text: sparse }. */
function denseOf(vector: unknown): number[] {
  if (Array.isArray(vector)) return vector as number[];
  return ((vector as Record<string, unknown>)?.[""] as number[]) ?? [];
}

export interface PointToInsert {
  id: string | number;
  vector: number[];
  // Văn bản dùng để tạo vector từ khóa (tên tài liệu + mục + nội dung)
  keywordText?: string;
  payload: {
    text: string;
    fileName: string;
    filePath: string;
    category: string;
    fileType: string;
    sheetName?: string;
    chunkIndex: number;
    section?: string; // mục chứa đoạn này trong tài liệu
    ocr?: boolean; // nội dung có phần lấy từ bản scan (nhận dạng chữ tự động)
  };
}

export async function upsertPoints(points: PointToInsert[]): Promise<void> {
  if (points.length === 0) return;

  const c = getQdrantClient();
  const hybrid = await isHybridEnabled();
  const toVector = (p: PointToInsert): any =>
    hybrid && p.keywordText ? { "": p.vector, [SPARSE_NAME]: toSparseVector(p.keywordText) } : p.vector;

  // Retry 3 lần với exponential backoff
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await c.upsert(config.collectionName, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: toVector(p),
          payload: p.payload as unknown as Record<string, unknown>,
        })),
      });
      return; // success
    } catch (err) {
      lastErr = err as Error;
      if (attempt < 3) {
        const waitMs = attempt * 2000; // 2s, 4s
        console.warn(
          `   ⚠️  Upsert thất bại lần ${attempt}: ${(err as Error).message}. Retry sau ${waitMs}ms...`
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

// Xóa theo filePath (không phải fileName) vì 2 phòng ban có thể có file trùng tên.
// Throw khi lỗi để caller không ghi nhận nhầm là đã xóa.
export async function deleteByFilePath(filePath: string): Promise<void> {
  const c = getQdrantClient();
  await c.delete(config.collectionName, {
    wait: true,
    filter: {
      must: [
        { key: "filePath", match: { value: filePath } },
      ],
    },
  });
}

// Scroll toàn bộ collection, chỉ lấy các field payload cần dùng (không kéo text về)
async function scrollPayload(fields: string[], onPayload: (payload: any) => void): Promise<void> {
  const c = getQdrantClient();
  let offset: any = undefined;
  do {
    const result: any = await c.scroll(config.collectionName, {
      limit: 1000,
      with_payload: fields,
      with_vector: false,
      offset,
    });

    for (const point of result.points) {
      onPayload(point.payload || {});
    }
    offset = result.next_page_offset;
  } while (offset !== null && offset !== undefined);
}

async function scrollPayloadField(field: string, onValue: (value: any) => void): Promise<void> {
  await scrollPayload([field], (payload) => onValue(payload[field]));
}

export interface IndexedFile {
  fileName: string;
  filePath: string;
  category: string;
  // Có khi danh mục lấy từ Docuzen (docuzenCatalog.ts): thông tin chính thức thay cho việc đoán từ tên file
  docuzen?: DocuzenMeta;
}

export interface DocuzenMeta {
  documentId: number;
  number: string; // số tài liệu chính thức: "FRM/QA/SOP-GEN/0005", "FRM/QC/RQP/0006/F02"
  title: string;
  typeCode: string; // mã loại: "SOP-GEN", "Formats", "Annexures", "L", "SPE-FCT"...
  group: "sop" | "form" | "appendix" | "list" | "other";
  serial: string | null; // số 4 chữ số cuối trong số tài liệu ("0005")
  sub: { kind: "form" | "appendix"; number: string } | null; // "/F02" → form "02"
  parentId: number | null; // tài liệu mẹ của biểu mẫu / phụ lục (LinkedDocumentID)
  versionId: number;
  version: number;
  effectiveDate: string | null; // yyyy-mm-dd
  expirationDate: string | null;
}

// Danh sách file đã index (mỗi file 1 dòng, kèm phòng ban). Throw khi lỗi.
export async function listIndexedFileEntries(): Promise<IndexedFile[]> {
  const byPath = new Map<string, IndexedFile>();
  await scrollPayload(["filePath", "fileName", "category"], (payload) => {
    if (!payload.fileName || !payload.filePath) return;
    if (!byPath.has(payload.filePath)) {
      byPath.set(payload.filePath, {
        fileName: payload.fileName,
        filePath: payload.filePath,
        category: payload.category || "Chung",
      });
    }
  });
  return Array.from(byPath.values());
}

export async function listIndexedFiles(): Promise<string[]> {
  const fileNames = new Set<string>();

  try {
    await scrollPayloadField("fileName", (fname) => {
      if (fname) fileNames.add(fname);
    });
  } catch (err) {
    console.error("Failed to list files:", err);
  }

  return Array.from(fileNames).sort();
}

// Throw khi lỗi: kết quả dùng để quyết định xóa nên không được trả về danh sách thiếu.
export async function listIndexedFilePaths(): Promise<Set<string>> {
  const filePaths = new Set<string>();
  await scrollPayloadField("filePath", (p) => {
    if (p) filePaths.add(p);
  });
  return filePaths;
}

export interface SearchResult {
  score: number;
  text: string;
  fileName: string;
  filePath: string;
  category: string;
  fileType: string;
  sheetName?: string;
  section?: string; // mục chứa đoạn này (chỉ có ở collection index từ bản có tên mục)
  ocr?: boolean; // tài liệu là bản scan, chữ nhận dạng tự động (có thể sai chính tả)
}

// onlyFilePaths: chỉ tìm trong các file này (dùng khi câu hỏi nhắc đích danh mã tài liệu)
// excludeFilePaths: bỏ qua các file này (dùng khi tìm nội dung trùng ở các tài liệu KHÁC)
// keywordText: có thì tìm kết hợp nghĩa + từ khóa (điểm trộn RRF, không còn là độ tương đồng cosine
//   → các chỗ dùng điểm làm ngưỡng như rà trùng lặp không truyền tham số này)
export async function searchSimilar(
  queryVector: number[],
  topK: number,
  onlyFilePaths?: string[],
  excludeFilePaths?: string[],
  keywordText?: string
): Promise<SearchResult[]> {
  const filter: Record<string, unknown> = {};
  if (onlyFilePaths?.length) filter.must = [{ key: "filePath", match: { any: onlyFilePaths } }];
  if (excludeFilePaths?.length) filter.must_not = [{ key: "filePath", match: { any: excludeFilePaths } }];
  const filterPart = Object.keys(filter).length > 0 ? { filter } : {};

  const c = getQdrantClient();
  const sparse = keywordText && (await isHybridEnabled()) ? toSparseVector(keywordText) : null;
  const response: any =
    sparse && sparse.indices.length > 0
      ? await c.query(config.collectionName, {
          prefetch: [
            { query: queryVector, limit: topK * HYBRID_PREFETCH_FACTOR, ...filterPart },
            { query: sparse, using: SPARSE_NAME, limit: topK * HYBRID_PREFETCH_FACTOR, ...filterPart },
          ],
          query: { fusion: "rrf" },
          limit: topK,
          with_payload: true,
        } as any)
      : await c.query(config.collectionName, {
          query: queryVector,
          limit: topK,
          with_payload: true,
          ...filterPart,
        });

  return response.points.map((r: any) => {
    const payload = r.payload as any;
    return {
      score: r.score,
      text: payload.text,
      fileName: payload.fileName,
      filePath: payload.filePath,
      category: payload.category,
      fileType: payload.fileType,
      sheetName: payload.sheetName,
      section: payload.section,
      ocr: payload.ocr === true,
    };
  });
}

export interface ChunkWithVector extends SearchResult {
  chunkIndex: number;
  vector: number[];
}

export interface CorpusChunk {
  text: string;
  fileName: string;
  filePath: string;
  category: string;
  chunkIndex: number;
  vector: Float32Array;
}

/** Toàn bộ chunk của kho kèm vector (dùng cho việc quét trùng lặp giữa mọi tài liệu). */
export async function fetchAllChunksWithVectors(maxChunks: number): Promise<CorpusChunk[]> {
  const c = getQdrantClient();
  const chunks: CorpusChunk[] = [];
  let offset: any = undefined;
  do {
    const result: any = await c.scroll(config.collectionName, {
      limit: 500,
      with_payload: ["text", "fileName", "filePath", "category", "chunkIndex"],
      with_vector: true,
      offset,
    });
    for (const point of result.points) {
      const payload = point.payload as any;
      if (!payload?.filePath) continue;
      chunks.push({
        text: payload.text,
        fileName: payload.fileName,
        filePath: payload.filePath,
        category: payload.category || "Chung",
        chunkIndex: payload.chunkIndex ?? 0,
        vector: Float32Array.from(denseOf(point.vector)),
      });
    }
    offset = result.next_page_offset;
  } while (offset !== null && offset !== undefined && chunks.length < maxChunks);
  return chunks.slice(0, maxChunks);
}

/** Toàn bộ chunk (kèm vector) của các file, theo thứ tự trong tài liệu. Dùng để so khớp nội dung giữa 2 tài liệu. */
export async function fetchFileChunksWithVectors(
  filePaths: string[],
  maxChunks: number = 400
): Promise<ChunkWithVector[]> {
  if (filePaths.length === 0) return [];

  const c = getQdrantClient();
  const chunks: ChunkWithVector[] = [];
  let offset: any = undefined;
  do {
    const result: any = await c.scroll(config.collectionName, {
      limit: 200,
      with_payload: true,
      with_vector: true,
      filter: { must: [{ key: "filePath", match: { any: filePaths } }] },
      offset,
    });
    for (const point of result.points) {
      const payload = point.payload as any;
      chunks.push({
        score: 1,
        text: payload.text,
        fileName: payload.fileName,
        filePath: payload.filePath,
        category: payload.category,
        fileType: payload.fileType,
        sheetName: payload.sheetName,
        chunkIndex: payload.chunkIndex ?? 0,
        vector: denseOf(point.vector),
      });
    }
    offset = result.next_page_offset;
  } while (offset !== null && offset !== undefined && chunks.length < maxChunks);

  const fileOrder = new Map(filePaths.map((p, i) => [p, i]));
  return chunks
    .slice(0, maxChunks)
    .sort(
      (a, b) =>
        (fileOrder.get(a.filePath) ?? 0) - (fileOrder.get(b.filePath) ?? 0) || a.chunkIndex - b.chunkIndex
    );
}

/**
 * Lấy `perFile` chunk ĐẦU TIÊN của mỗi file, theo đúng thứ tự trong tài liệu.
 * Dùng cho câu hỏi tổng quan ("nội dung SOP X", "tóm tắt SOP X"): câu hỏi không có nội dung
 * để so khớp vector, còn phần mở đầu tài liệu thì có mục đích, phạm vi, trách nhiệm.
 */
export async function fetchOpeningChunks(
  filePaths: string[],
  perFile: number
): Promise<SearchResult[]> {
  if (filePaths.length === 0) return [];

  const c = getQdrantClient();
  const response: any = await c.scroll(config.collectionName, {
    limit: filePaths.length * perFile,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        { key: "filePath", match: { any: filePaths } },
        { key: "chunkIndex", range: { lt: perFile } },
      ],
    },
  });

  const fileOrder = new Map(filePaths.map((p, i) => [p, i]));
  return response.points
    .map((p: any) => p.payload)
    .sort(
      (a: any, b: any) =>
        (fileOrder.get(a.filePath) ?? 0) - (fileOrder.get(b.filePath) ?? 0) ||
        a.chunkIndex - b.chunkIndex
    )
    .map((payload: any) => ({
      score: 1,
      text: payload.text,
      fileName: payload.fileName,
      filePath: payload.filePath,
      category: payload.category,
      fileType: payload.fileType,
      sheetName: payload.sheetName,
      section: payload.section,
      ocr: payload.ocr === true,
    }));
}

export async function countPoints(): Promise<number> {
  try {
    const c = getQdrantClient();
    const info = await c.getCollection(config.collectionName);
    return info.points_count || 0;
  } catch {
    return 0;
  }
}

export async function getCategories(): Promise<Record<string, number>> {
  const categories: Record<string, number> = {};

  try {
    await scrollPayloadField("category", (value) => {
      const cat = value || "Chung";
      categories[cat] = (categories[cat] || 0) + 1;
    });
  } catch (err) {
    console.error("Get categories failed:", err);
  }

  return categories;
}

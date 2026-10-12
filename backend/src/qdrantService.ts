import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";
import { getEmbeddingDimension } from "./embedding.js";

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
    });

    console.log(`   ✓ Created collection '${collectionName}'`);
  }

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

export interface PointToInsert {
  id: string | number;
  vector: number[];
  payload: {
    text: string;
    fileName: string;
    filePath: string;
    category: string;
    fileType: string;
    sheetName?: string;
    chunkIndex: number;
  };
}

export async function upsertPoints(points: PointToInsert[]): Promise<void> {
  if (points.length === 0) return;

  const c = getQdrantClient();

  // Retry 3 lần với exponential backoff
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await c.upsert(config.collectionName, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
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
}

// onlyFilePaths: chỉ tìm trong các file này (dùng khi câu hỏi nhắc đích danh mã tài liệu)
export async function searchSimilar(
  queryVector: number[],
  topK: number,
  onlyFilePaths?: string[]
): Promise<SearchResult[]> {
  const c = getQdrantClient();
  const response = await c.query(config.collectionName, {
    query: queryVector,
    limit: topK,
    with_payload: true,
    ...(onlyFilePaths && onlyFilePaths.length > 0
      ? { filter: { must: [{ key: "filePath", match: { any: onlyFilePaths } }] } }
      : {}),
  });

  return response.points.map((r) => {
    const payload = r.payload as any;
    return {
      score: r.score,
      text: payload.text,
      fileName: payload.fileName,
      filePath: payload.filePath,
      category: payload.category,
      fileType: payload.fileType,
      sheetName: payload.sheetName,
    };
  });
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

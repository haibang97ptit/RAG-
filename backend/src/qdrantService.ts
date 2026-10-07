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

    // Payload index cho fileName để delete nhanh (dùng cho incremental)
    try {
      await c.createPayloadIndex(collectionName, {
        field_name: "fileName",
        field_schema: "keyword",
      });
    } catch (err) {
      console.warn("Could not create fileName index:", (err as Error).message);
    }

    console.log(`   ✓ Created collection '${collectionName}' with fileName index`);
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

export async function deleteByFileName(fileName: string): Promise<number> {
  const c = getQdrantClient();
  try {
    const result = await c.delete(config.collectionName, {
      wait: true,
      filter: {
        must: [
          { key: "fileName", match: { value: fileName } },
        ],
      },
    });
    return (result.operation_id as any) ?? 0;
  } catch (err) {
    console.error(`Failed to delete chunks for ${fileName}:`, err);
    return 0;
  }
}

export async function listIndexedFiles(): Promise<string[]> {
  const c = getQdrantClient();
  const fileNames = new Set<string>();

  try {
    let offset: any = undefined;
    do {
      const result: any = await c.scroll(config.collectionName, {
        limit: 500,
        with_payload: true,
        offset,
      });

      for (const point of result.points) {
        const fname = (point.payload as any)?.fileName;
        if (fname) fileNames.add(fname);
      }
      offset = result.next_page_offset;
    } while (offset !== null && offset !== undefined);
  } catch (err) {
    console.error("Failed to list files:", err);
  }

  return Array.from(fileNames).sort();
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

export async function searchSimilar(
  queryVector: number[],
  topK: number
): Promise<SearchResult[]> {
  const c = getQdrantClient();
  const response = await c.query(config.collectionName, {
    query: queryVector,
    limit: topK,
    with_payload: true,
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
  const c = getQdrantClient();
  const categories: Record<string, number> = {};

  try {
    let offset: any = undefined;
    do {
      const result: any = await c.scroll(config.collectionName, {
        limit: 500,
        with_payload: true,
        offset,
      });

      for (const point of result.points) {
        const cat = (point.payload as any)?.category || "Chung";
        categories[cat] = (categories[cat] || 0) + 1;
      }
      offset = result.next_page_offset;
    } while (offset !== null && offset !== undefined);
  } catch (err) {
    console.error("Get categories failed:", err);
  }

  return categories;
}

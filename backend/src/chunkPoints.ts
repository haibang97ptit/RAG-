import { config } from "./config.js";
import { embed } from "./embedding.js";
import { chunkTextWithSections } from "./chunker.js";
import type { ParsedDocument } from "./fileReaders.js";
import type { PointToInsert } from "./qdrantService.js";

const EMBED_BATCH_SIZE = 32;

export function makePointId(filePath: string, chunkIndex: number, sheetName?: string): number {
  const key = `${filePath}::${sheetName || ""}::${chunkIndex}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Đầu mỗi đoạn khi tạo vector: tên tài liệu + phòng ban + mục. Đoạn ở giữa một SOP dài vốn không
 * nhắc tên SOP hay tên mục, nên trước đây câu hỏi "SOP 0005 quy định gì về..." khó khớp với nó.
 * Chỉ dùng để tạo vector; nội dung lưu (payload.text) giữ nguyên để hiển thị và so khớp trùng lặp.
 */
function contextLine(doc: ParsedDocument, section: string): string {
  const { fileName, category, sheetName } = doc.metadata;
  const parts = [`Tài liệu: ${fileName}`, `Phòng ban: ${category}`];
  if (sheetName) parts.push(`Sheet: ${sheetName}`);
  if (section) parts.push(`Mục: ${section}`);
  return `[${parts.join(" | ")}]`;
}

/** Cắt một tài liệu thành đoạn, tạo vector (nghĩa + từ khóa) cho từng đoạn. */
export async function buildPointsForDocument(doc: ParsedDocument, firstChunkIndex: number): Promise<PointToInsert[]> {
  const chunks = chunkTextWithSections(doc.text, {
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
  });

  const points: PointToInsert[] = [];
  for (let j = 0; j < chunks.length; j += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(j, j + EMBED_BATCH_SIZE);
    // Đoạn đầu tài liệu đã mở đầu bằng "[Tài liệu: ...]" (do fileReaders thêm) → thay bằng dòng đầy đủ hơn
    const withContext = batch.map(
      (c) => `${contextLine(doc, c.section)}\n${c.text.replace(/^\[Tài liệu:[^\]]*\]\s*/, "")}`
    );
    const vectors = await embed(withContext);

    batch.forEach((chunk, k) => {
      const chunkIndex = firstChunkIndex + points.length;
      points.push({
        id: makePointId(doc.metadata.filePath, chunkIndex, doc.metadata.sheetName),
        vector: vectors[k],
        keywordText: withContext[k],
        payload: {
          text: chunk.text,
          fileName: doc.metadata.fileName,
          filePath: doc.metadata.filePath,
          category: doc.metadata.category,
          fileType: doc.metadata.fileType,
          sheetName: doc.metadata.sheetName,
          ...(doc.metadata.ocr ? { ocr: true } : {}),
          chunkIndex,
          ...(chunk.section ? { section: chunk.section } : {}),
        },
      });
    });
  }
  return points;
}

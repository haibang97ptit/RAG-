import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { config } from "./config.js";
import { chunkTextWithSections, type SectionedChunk } from "./chunker.js";
import { parseFileCode, type FileCode } from "./docCode.js";
import { embed, embedQuery } from "./embedding.js";
import { readUploadedText } from "./fileReaders.js";

/**
 * File người dùng upload để so sánh / tìm đoạn: chỉ giữ phần CHỮ trong RAM, không index vào Qdrant,
 * không ghi DB, không lưu ra đĩa (file tạm xoá ngay sau khi đọc). Không dùng quá UPLOAD_IDLE_MS thì xoá;
 * khởi động lại server cũng mất.
 */

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MAX_OCR_PAGES = 30;
export const UPLOAD_MAX_PER_QUERY = 2;
const UPLOAD_IDLE_MS = 30 * 60 * 1000;
const MAX_UPLOADS = 100; // giữ trong RAM cùng lúc; vượt thì bỏ file lâu không dùng nhất
const EMBED_BATCH = 16;

export interface UploadChunk {
  text: string;
  section: string;
  vector: number[];
}

export interface UploadedDoc {
  id: string;
  fileName: string;
  size: number;
  text: string;
  ocrPages: number;
  ocrSkippedPages: number;
  code: FileCode | null; // mã đọc được từ tên file ("FRM-QA-SOP-GEN-0005-11 ...")
  lastUsedAt: number;
  chunks?: Promise<UploadChunk[]>; // chỉ cắt đoạn + tính vector khi có câu hỏi cần tìm theo nghĩa
}

const store = new Map<string, UploadedDoc>();

function sweep(now = Date.now()) {
  for (const [id, doc] of store) if (now - doc.lastUsedAt > UPLOAD_IDLE_MS) store.delete(id);
  while (store.size > MAX_UPLOADS) {
    const oldest = [...store.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    store.delete(oldest.id);
  }
}
setInterval(sweep, 60 * 1000).unref();

export const uploadIdleMinutes = UPLOAD_IDLE_MS / 60000;

/** Đọc chữ của file vừa upload và giữ trong RAM. Throw nếu định dạng không hỗ trợ / không đọc được. */
export async function saveUpload(buffer: Buffer, fileName: string): Promise<UploadedDoc> {
  // Bộ đọc file cần đường dẫn: ghi tạm vào thư mục riêng rồi xoá ngay
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sop-upload-"));
  const safeName = path.basename(fileName).replace(/[^\p{L}\p{N}._ -]/gu, "_") || "upload";
  try {
    const filePath = path.join(workDir, safeName);
    await fs.writeFile(filePath, buffer);
    const read = await readUploadedText(filePath, safeName, UPLOAD_MAX_OCR_PAGES);
    const doc: UploadedDoc = {
      id: crypto.randomUUID(),
      fileName: path.basename(fileName),
      size: buffer.length,
      text: read.text,
      ocrPages: read.ocrPages,
      ocrSkippedPages: read.ocrSkippedPages,
      code: parseFileCode(path.basename(fileName)),
      lastUsedAt: Date.now(),
    };
    store.set(doc.id, doc);
    sweep();
    return doc;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Các file còn giữ (đánh dấu vừa dùng); id hết hạn / không có thì bỏ qua. */
export function getUploads(ids: string[]): UploadedDoc[] {
  sweep();
  const now = Date.now();
  return ids
    .map((id) => store.get(id))
    .filter((d): d is UploadedDoc => !!d)
    .map((d) => {
      d.lastUsedAt = now;
      return d;
    });
}

function chunksOf(doc: UploadedDoc): Promise<UploadChunk[]> {
  doc.chunks ??= (async () => {
    const pieces = chunkTextWithSections(doc.text, { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap });
    const chunks: UploadChunk[] = [];
    for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
      const batch = pieces.slice(i, i + EMBED_BATCH);
      const vectors = await embed(batch.map((p) => (p.section ? `${p.section}\n${p.text}` : p.text)));
      batch.forEach((p, j) => chunks.push({ ...p, vector: vectors[j] }));
    }
    return chunks;
  })().catch((err) => {
    doc.chunks = undefined; // lần sau thử lại
    throw err;
  });
  return doc.chunks;
}

/** Các đoạn trong file giống câu hỏi nhất (vector đã chuẩn hoá: tích vô hướng = cosine). */
export async function searchUpload(doc: UploadedDoc, query: string, k: number): Promise<(UploadChunk & { score: number })[]> {
  const [chunks, q] = await Promise.all([chunksOf(doc), embedQuery(query)]);
  return chunks
    .map((c) => ({ ...c, score: c.vector.reduce((sum, x, i) => sum + x * q[i], 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Các đoạn của file theo thứ tự, không tính vector (dùng khi không cần tìm theo nghĩa, vd tóm tắt). */
export function uploadSections(doc: UploadedDoc): SectionedChunk[] {
  return chunkTextWithSections(doc.text, { chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap });
}

/** Toàn bộ đoạn của file (kèm vector), theo thứ tự trong file. */
export function uploadChunks(doc: UploadedDoc): Promise<UploadChunk[]> {
  return chunksOf(doc);
}

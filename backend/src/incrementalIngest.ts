import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "./config.js";
import { initEmbedder, embed } from "./embedding.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFileName,
  countPoints,
  type PointToInsert,
} from "./qdrantService.js";
import { readFile, walkDirectory } from "./fileReaders.js";
import { chunkText } from "./chunker.js";

const BATCH_SIZE = 32;
const MANIFEST_PATH = path.join(config.dataDir, "..", ".ingest-manifest.json");

interface FileRecord {
  filePath: string;
  fileName: string;
  hash: string;
  mtime: number;
  size: number;
  chunksCount: number;
  indexedAt: string;
}

interface Manifest {
  version: 1;
  lastRun: string;
  files: Record<string, FileRecord>; // key = filePath
}

async function loadManifest(): Promise<Manifest> {
  try {
    const content = await fs.readFile(MANIFEST_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      version: 1,
      lastRun: new Date().toISOString(),
      files: {},
    };
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  manifest.lastRun = new Date().toISOString();
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

async function hashFile(filePath: string): Promise<{ hash: string; mtime: number; size: number }> {
  const [stat, buf] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  return { hash, mtime: stat.mtimeMs, size: stat.size };
}

function makePointId(filePath: string, chunkIndex: number, sheetName?: string): number {
  const key = `${filePath}::${sheetName || ""}::${chunkIndex}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

async function indexFile(filePath: string): Promise<number> {
  const docs = await readFile(filePath, config.dataDir);
  if (docs.length === 0) return 0;

  let totalChunks = 0;

  for (const doc of docs) {
    const chunks = chunkText(doc.text, {
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
    });
    if (chunks.length === 0) continue;

    for (let j = 0; j < chunks.length; j += BATCH_SIZE) {
      const batch = chunks.slice(j, j + BATCH_SIZE);
      const vectors = await embed(batch);

      const points: PointToInsert[] = batch.map((text, k) => {
        const globalIdx = totalChunks + j + k;
        return {
          id: makePointId(filePath, globalIdx, doc.metadata.sheetName),
          vector: vectors[k],
          payload: {
            text,
            fileName: doc.metadata.fileName,
            filePath: doc.metadata.filePath,
            category: doc.metadata.category,
            fileType: doc.metadata.fileType,
            sheetName: doc.metadata.sheetName,
            chunkIndex: globalIdx,
          },
        };
      });

      await upsertPoints(points);
    }

    totalChunks += chunks.length;
  }

  return totalChunks;
}

async function incrementalIngest() {
  console.log("🔄 INCREMENTAL INGEST\n");
  console.log(`   Data dir:    ${config.dataDir}`);
  console.log(`   Manifest:    ${MANIFEST_PATH}\n`);

  console.log("1️⃣  Load embedding model...");
  await initEmbedder();

  console.log("\n2️⃣  Ensure Qdrant collection...");
  await ensureCollection(false);

  console.log("\n3️⃣  Load manifest...");
  const manifest = await loadManifest();
  const previousCount = Object.keys(manifest.files).length;
  console.log(`   Previous: ${previousCount} files tracked`);

  console.log("\n4️⃣  Scan filesystem...");
  const currentFiles = await walkDirectory(config.dataDir);
  const currentPaths = new Set(currentFiles);
  console.log(`   Current:  ${currentFiles.length} files on disk`);

  // Phân loại files
  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const toDelete: string[] = [];
  const unchanged: string[] = [];

  console.log("\n5️⃣  Diff files...");
  for (const filePath of currentFiles) {
    const prev = manifest.files[filePath];
    const { hash, mtime, size } = await hashFile(filePath);

    if (!prev) {
      toAdd.push(filePath);
    } else if (prev.hash !== hash || Math.abs(prev.mtime - mtime) > 1 || prev.size !== size) {
      toUpdate.push(filePath);
    } else {
      unchanged.push(filePath);
    }
  }

  // Files bị xóa (có trong manifest nhưng ko có trên disk)
  for (const filePath of Object.keys(manifest.files)) {
    if (!currentPaths.has(filePath)) {
      toDelete.push(filePath);
    }
  }

  console.log(`   ➕ Thêm mới:   ${toAdd.length}`);
  console.log(`   🔄 Cập nhật:  ${toUpdate.length}`);
  console.log(`   ❌ Xóa:        ${toDelete.length}`);
  console.log(`   ✓  Giữ nguyên: ${unchanged.length}`);

  if (toAdd.length + toUpdate.length + toDelete.length === 0) {
    console.log("\n✅ Không có thay đổi. Thoát.");
    return;
  }

  // 6. Xử lý DELETE
  if (toDelete.length > 0) {
    console.log(`\n6️⃣  Xóa ${toDelete.length} files khỏi vector DB...`);
    for (const filePath of toDelete) {
      const prev = manifest.files[filePath];
      if (prev) {
        await deleteByFileName(prev.fileName);
        delete manifest.files[filePath];
        console.log(`   ❌ ${prev.fileName}`);
      }
    }
  }

  // 7. Xử lý UPDATE: delete trước rồi re-index
  if (toUpdate.length > 0) {
    console.log(`\n7️⃣  Cập nhật ${toUpdate.length} files...`);
    for (let i = 0; i < toUpdate.length; i++) {
      const filePath = toUpdate[i];
      const fileName = path.basename(filePath);
      const progress = `[${i + 1}/${toUpdate.length}]`;

      try {
        // Xóa chunks cũ
        await deleteByFileName(fileName);

        // Index lại
        const chunksCount = await indexFile(filePath);
        const { hash, mtime, size } = await hashFile(filePath);

        manifest.files[filePath] = {
          filePath,
          fileName,
          hash,
          mtime,
          size,
          chunksCount,
          indexedAt: new Date().toISOString(),
        };

        console.log(`${progress} 🔄 ${fileName} → ${chunksCount} chunks`);
      } catch (err) {
        console.error(`${progress} ❌ ${fileName}: ${(err as Error).message}`);
      }
    }
  }

  // 8. Xử lý ADD
  if (toAdd.length > 0) {
    console.log(`\n8️⃣  Thêm mới ${toAdd.length} files...`);
    for (let i = 0; i < toAdd.length; i++) {
      const filePath = toAdd[i];
      const fileName = path.basename(filePath);
      const progress = `[${i + 1}/${toAdd.length}]`;

      try {
        const chunksCount = await indexFile(filePath);
        const { hash, mtime, size } = await hashFile(filePath);

        manifest.files[filePath] = {
          filePath,
          fileName,
          hash,
          mtime,
          size,
          chunksCount,
          indexedAt: new Date().toISOString(),
        };

        console.log(`${progress} ➕ ${fileName} → ${chunksCount} chunks`);
      } catch (err) {
        console.error(`${progress} ❌ ${fileName}: ${(err as Error).message}`);
      }
    }
  }

  // 9. Save manifest
  await saveManifest(manifest);

  const finalCount = await countPoints();
  console.log(`\n✅ INCREMENTAL INGEST HOÀN TẤT`);
  console.log(`   Files in manifest: ${Object.keys(manifest.files).length}`);
  console.log(`   Total chunks DB:   ${finalCount}`);
}

incrementalIngest().catch((err) => {
  console.error("❌ Incremental ingest thất bại:", err);
  process.exit(1);
});

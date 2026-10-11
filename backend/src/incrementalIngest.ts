import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "./config.js";
import { initEmbedder, embed } from "./embedding.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFilePath,
  listIndexedFilePaths,
  countPoints,
  type PointToInsert,
} from "./qdrantService.js";
import { readFile, walkDirectory } from "./fileReaders.js";
import { chunkText } from "./chunker.js";

const BATCH_SIZE = 32;
const MANIFEST_PATH = config.manifestPath;
const SAVE_MANIFEST_EVERY = 20; // files

// Chốt an toàn: nếu số file cần xóa vượt ngưỡng (vd SMB hỏng, rsync lỗi, DATA_DIR sai)
// thì dừng, không xóa gì. Chạy lại với --force nếu việc xóa là có chủ đích.
const MAX_DELETE_RATIO = 0.3;
const MIN_DELETE_COUNT_FOR_GUARD = 20;

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
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  // Ghi ra file tạm rồi rename để không để lại manifest hỏng nếu bị kill giữa chừng
  const tmpPath = `${MANIFEST_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  await fs.rename(tmpPath, MANIFEST_PATH);
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

/**
 * Index (hoặc index lại) 1 file. Parse + embed xong hết rồi mới xóa chunks cũ và upsert,
 * nên file lỗi parse/embed không làm mất dữ liệu đang có.
 */
async function indexFile(filePath: string): Promise<number> {
  const docs = await readFile(filePath, config.dataDir);

  const points: PointToInsert[] = [];

  for (const doc of docs) {
    const chunks = chunkText(doc.text, {
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
    });

    for (let j = 0; j < chunks.length; j += BATCH_SIZE) {
      const batch = chunks.slice(j, j + BATCH_SIZE);
      const vectors = await embed(batch);

      batch.forEach((text, k) => {
        const globalIdx = points.length;
        points.push({
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
        });
      });
    }
  }

  await deleteByFilePath(filePath);
  for (let j = 0; j < points.length; j += BATCH_SIZE) {
    await upsertPoints(points.slice(j, j + BATCH_SIZE));
  }

  return points.length;
}

async function incrementalIngest() {
  const force = process.argv.includes("--force");

  console.log("🔄 INCREMENTAL INGEST\n");
  console.log(`   Data dir:    ${config.dataDir}`);
  console.log(`   Collection:  ${config.collectionName}`);
  console.log(`   Chunk size:  ${config.chunkSize}`);
  console.log(`   Manifest:    ${MANIFEST_PATH}\n`);

  console.log("1️⃣  Load embedding model...");
  await initEmbedder();

  console.log("\n2️⃣  Ensure Qdrant collection...");
  await ensureCollection(false);

  console.log("\n3️⃣  Load manifest...");
  // Fail sớm nếu không ghi được manifest, thay vì index xong hàng giờ rồi mới lỗi lúc lưu
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.access(path.dirname(MANIFEST_PATH), fs.constants.W_OK);
  const manifest = await loadManifest();
  const previousCount = Object.keys(manifest.files).length;
  console.log(`   Previous: ${previousCount} files tracked`);

  console.log("\n4️⃣  Scan filesystem...");
  const currentFiles = await walkDirectory(config.dataDir);
  const currentPaths = new Set(currentFiles);
  console.log(`   Current:  ${currentFiles.length} files on disk`);

  // File đang có trong vector DB (kể cả file manifest không biết, vd manifest bị mất)
  const indexedPaths = await listIndexedFilePaths();
  console.log(`   Indexed:  ${indexedPaths.size} files in vector DB`);

  const trackedPaths = new Set([...Object.keys(manifest.files), ...indexedPaths]);

  if (currentFiles.length === 0 && trackedPaths.size > 0 && !force) {
    throw new Error(
      `Không thấy file nào trong ${config.dataDir} nhưng đang có ${trackedPaths.size} files đã index. ` +
        `Có thể thư mục data chưa mount/sync. Không xóa gì. Chạy lại với --force nếu thật sự muốn xóa hết.`
    );
  }

  // Phân loại files
  const toIndex: { filePath: string; isNew: boolean }[] = [];
  const unchanged: string[] = [];

  console.log("\n5️⃣  Diff files...");
  for (const filePath of currentFiles) {
    const prev = manifest.files[filePath];
    const { hash, mtime, size } = await hashFile(filePath);

    if (!prev) {
      toIndex.push({ filePath, isNew: true });
    } else if (prev.hash !== hash || Math.abs(prev.mtime - mtime) > 1 || prev.size !== size) {
      toIndex.push({ filePath, isNew: false });
    } else {
      unchanged.push(filePath);
    }
  }

  // Files bị xóa: có trong manifest hoặc vector DB nhưng ko còn trên disk
  const toDelete = [...trackedPaths].filter((p) => !currentPaths.has(p));

  const addCount = toIndex.filter((f) => f.isNew).length;
  console.log(`   ➕ Thêm mới:   ${addCount}`);
  console.log(`   🔄 Cập nhật:  ${toIndex.length - addCount}`);
  console.log(`   ❌ Xóa:        ${toDelete.length}`);
  console.log(`   ✓  Giữ nguyên: ${unchanged.length}`);

  if (toIndex.length + toDelete.length === 0) {
    console.log("\n✅ Không có thay đổi. Thoát.");
    return;
  }

  if (
    !force &&
    toDelete.length >= MIN_DELETE_COUNT_FOR_GUARD &&
    toDelete.length / trackedPaths.size > MAX_DELETE_RATIO
  ) {
    throw new Error(
      `Sắp xóa ${toDelete.length}/${trackedPaths.size} files đã index (> ${MAX_DELETE_RATIO * 100}%). ` +
        `Dừng lại để tránh xóa nhầm (data chưa sync đủ? DATA_DIR khác lúc index?). ` +
        `Nếu đúng là muốn xóa, chạy lại với --force.`
    );
  }

  let failed = 0;

  // 6. Xử lý DELETE
  if (toDelete.length > 0) {
    console.log(`\n6️⃣  Xóa ${toDelete.length} files khỏi vector DB...`);
    for (const filePath of toDelete) {
      try {
        await deleteByFilePath(filePath);
        delete manifest.files[filePath];
        console.log(`   ❌ ${path.basename(filePath)}`);
      } catch (err) {
        failed++;
        console.error(`   ⚠️  Không xóa được ${filePath}: ${(err as Error).message}`);
      }
    }
    await saveManifest(manifest);
  }

  // 7. Xử lý ADD + UPDATE (indexFile tự xóa chunks cũ của file trước khi upsert)
  if (toIndex.length > 0) {
    console.log(`\n7️⃣  Index ${toIndex.length} files...`);
    for (let i = 0; i < toIndex.length; i++) {
      const { filePath, isNew } = toIndex[i];
      const fileName = path.basename(filePath);
      const progress = `[${i + 1}/${toIndex.length}]`;

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

        console.log(`${progress} ${isNew ? "➕" : "🔄"} ${fileName} → ${chunksCount} chunks`);
      } catch (err) {
        // Không ghi vào manifest → lần chạy sau sẽ thử lại file này
        failed++;
        console.error(`${progress} ❌ ${fileName}: ${(err as Error).message}`);
      }

      if ((i + 1) % SAVE_MANIFEST_EVERY === 0) {
        await saveManifest(manifest);
      }
    }
  }

  // 8. Save manifest
  await saveManifest(manifest);

  const finalCount = await countPoints();
  console.log(`\n✅ INCREMENTAL INGEST HOÀN TẤT`);
  console.log(`   Files in manifest: ${Object.keys(manifest.files).length}`);
  console.log(`   Total chunks DB:   ${finalCount}`);
  if (failed > 0) {
    console.log(`   ⚠️  Lỗi:            ${failed} files (sẽ thử lại ở lần chạy sau)`);
  }
}

incrementalIngest().catch((err) => {
  console.error("❌ Incremental ingest thất bại:", (err as Error).message || err);
  process.exit(1);
});

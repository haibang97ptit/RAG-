import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "./config.js";
import { initEmbedder } from "./embedding.js";
import {
  ensureCollection,
  upsertPoints,
  deleteByFilePath,
  listIndexedFilePaths,
  countPoints,
  type PointToInsert,
} from "./qdrantService.js";
import { readFile, walkDirectory } from "./fileReaders.js";
import { buildPointsForDocument } from "./chunkPoints.js";
import { reportOcr } from "./pdfReader.js";
import { DOCUZEN_PATH_PREFIX, docuzenNumberKeys, getDocuzenFiles, isOnDocuzen } from "./docuzenCatalog.js";

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

/**
 * File SMB đã có trên Docuzen (khi DOCUZEN_ENABLED): do ingest:docuzen index, thư mục SMB chỉ còn giữ file
 * KHÔNG có trên Docuzen. Không đọc được Docuzen → không bỏ file nào.
 */
async function docuzenDuplicates(files: string[]): Promise<Set<string>> {
  if (!config.docuzenEnabled) return new Set();
  let keys: Set<string>;
  try {
    keys = docuzenNumberKeys(await getDocuzenFiles());
  } catch (err) {
    console.warn(`   ⚠️  Không đọc được danh mục Docuzen, giữ mọi file SMB: ${(err as Error).message}`);
    return new Set();
  }
  return new Set(files.filter((f) => isOnDocuzen(path.basename(f), keys)));
}

/**
 * Index (hoặc index lại) 1 file. Parse + embed xong hết rồi mới xóa chunks cũ và upsert,
 * nên file lỗi parse/embed không làm mất dữ liệu đang có.
 */
async function indexFile(filePath: string): Promise<number> {
  const docs = await readFile(filePath, config.dataDir);

  const points: PointToInsert[] = [];

  for (const doc of docs) {
    points.push(...(await buildPointsForDocument(doc, points.length)));
  }

  await deleteByFilePath(filePath);
  for (let j = 0; j < points.length; j += BATCH_SIZE) {
    await upsertPoints(points.slice(j, j + BATCH_SIZE));
  }

  return points.length;
}

async function incrementalIngest() {
  const force = process.argv.includes("--force");
  // Index lại MỌI file dù không đổi (dùng sau khi sửa cách cắt đoạn / cách đọc file).
  // Từng file được thay tại chỗ nên bot vẫn trả lời được trong lúc chạy.
  const reindex = process.argv.includes("--reindex");

  console.log("🔄 INCREMENTAL INGEST\n");
  console.log(`   Data dir:    ${config.dataDir}`);
  console.log(`   Collection:  ${config.collectionName}`);
  console.log(`   Chunk size:  ${config.chunkSize}`);
  console.log(`   Manifest:    ${MANIFEST_PATH}`);
  console.log(`   Reindex:     ${reindex ? "YES (index lại mọi file)" : "NO (chỉ file mới / thay đổi)"}\n`);

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
  const filesOnDisk = await walkDirectory(config.dataDir);
  console.log(`   Current:  ${filesOnDisk.length} files on disk`);

  // Tài liệu đã có trên Docuzen thì do ingest:docuzen index (đúng bản hiện hành): thư mục SMB chỉ còn giữ
  // những file KHÔNG có trên Docuzen. File trùng đã index trước đây sẽ được gỡ để không có 2 bản.
  const onDocuzen = await docuzenDuplicates(filesOnDisk);
  const currentFiles = filesOnDisk.filter((f) => !onDocuzen.has(f));
  const currentPaths = new Set(currentFiles);
  if (onDocuzen.size > 0) console.log(`   Bỏ qua:   ${onDocuzen.size} files đã có trên Docuzen`);

  // File đang có trong vector DB (kể cả file manifest không biết, vd manifest bị mất).
  // Bỏ tài liệu Docuzen (docuzen://...): do ingest:docuzen quản lý, script này không đụng tới.
  const indexedPaths = new Set([...(await listIndexedFilePaths())].filter((p) => !p.startsWith(DOCUZEN_PATH_PREFIX)));
  console.log(`   Indexed:  ${indexedPaths.size} files in vector DB (không tính tài liệu Docuzen)`);

  const trackedPaths = new Set([...Object.keys(manifest.files), ...indexedPaths]);

  if (filesOnDisk.length === 0 && trackedPaths.size > 0 && !force) {
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
    } else if (reindex || prev.hash !== hash || Math.abs(prev.mtime - mtime) > 1 || prev.size !== size) {
      toIndex.push({ filePath, isNew: false });
    } else {
      unchanged.push(filePath);
    }
  }

  // Files bị xóa: có trong manifest hoặc vector DB nhưng ko còn trên disk.
  // File trùng Docuzen gỡ riêng: không tính vào chốt an toàn (lần đầu bật Docuzen có thể gỡ phần lớn file SMB).
  const duplicates = [...trackedPaths].filter((p) => onDocuzen.has(p));
  const toDelete = [...trackedPaths].filter((p) => !currentPaths.has(p) && !onDocuzen.has(p));

  const addCount = toIndex.filter((f) => f.isNew).length;
  console.log(`   ➕ Thêm mới:   ${addCount}`);
  console.log(`   🔄 Cập nhật:  ${toIndex.length - addCount}`);
  console.log(`   ❌ Xóa:        ${toDelete.length}`);
  console.log(`   🔁 Gỡ (đã có trên Docuzen): ${duplicates.length}`);
  console.log(`   ✓  Giữ nguyên: ${unchanged.length}`);

  if (toIndex.length + toDelete.length + duplicates.length === 0) {
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

  // 6. Xử lý DELETE (file không còn trên disk + file trùng Docuzen)
  if (toDelete.length + duplicates.length > 0) {
    console.log(`\n6️⃣  Xóa ${toDelete.length + duplicates.length} files khỏi vector DB...`);
    for (const filePath of [...toDelete, ...duplicates]) {
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
  await reportOcr();
}

incrementalIngest()
  // Kết nối database Docuzen (nếu có) giữ tiến trình sống: thoát hẳn khi xong
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Incremental ingest thất bại:", (err as Error).message || err);
    process.exit(1);
  });

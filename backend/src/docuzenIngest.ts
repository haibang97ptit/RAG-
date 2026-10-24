import fs from "fs/promises";
import os from "os";
import path from "path";
import { config } from "./config.js";
import { initEmbedder } from "./embedding.js";
import {
  countPoints,
  deleteByFilePath,
  ensureCollection,
  listIndexedFilePaths,
  upsertPoints,
  type IndexedFile,
  type PointToInsert,
} from "./qdrantService.js";
import { readFile } from "./fileReaders.js";
import { buildPointsForDocument } from "./chunkPoints.js";
import { reportOcr } from "./pdfReader.js";
import { DOCUZEN_PATH_PREFIX, downloadDocuzenFile, loadDocuzenCatalog } from "./docuzenCatalog.js";

/**
 * Index NỘI DUNG tài liệu từ Docuzen (thay cho thư mục SMB): mọi tài liệu có phiên bản đang hiệu lực.
 *   npm run ingest:docuzen                  chỉ tài liệu mới / có phiên bản mới / không còn hiệu lực
 *   npm run ingest:docuzen -- --limit 100   index tối đa 100 tài liệu lần này (chạy thử, đo thời gian)
 *   npm run ingest:docuzen -- --dry-run     chỉ báo sẽ thêm / cập nhật / gỡ bao nhiêu, không làm gì
 *   npm run ingest:docuzen -- --reindex     index lại mọi tài liệu (sau khi đổi cách đọc / cắt đoạn)
 *   npm run ingest:docuzen -- --force       bỏ qua chốt an toàn khi số tài liệu cần gỡ lớn bất thường
 * Chạy mỗi đêm (cron). Collection theo COLLECTION_NAME: index vào collection mới, kiểm xong mới đổi cho server.
 *
 * Mỗi tài liệu: tải file của bản hiện hành (.docx trước, không có thì .pdf) vào thư mục tạm → đọc, cắt đoạn,
 * tạo vector → ghi Qdrant với đường dẫn "docuzen://<DocumentID>" → xoá file tạm. Không lưu bản sao file.
 * Tài liệu SMB (ingest:incremental) nằm chung collection, đường dẫn khác: hai script không đụng dữ liệu của nhau.
 */

const BATCH_SIZE = 32;
const WORKERS = 2; // tải file song song với tạo vector, không làm nặng file server
const SAVE_MANIFEST_EVERY = 20;
// Chốt an toàn: database lỗi / trả thiếu dữ liệu thì đừng gỡ hàng loạt tài liệu đã index
const MAX_DELETE_RATIO = 0.3;
const MIN_DELETE_COUNT_FOR_GUARD = 20;
const MAX_FILE_NAME_CHARS = 150; // tên file tạm (tên tài liệu có thể dài 500 ký tự)

const MANIFEST_PATH = path.join(path.dirname(config.manifestPath), `.docuzen-manifest.${config.collectionName}.json`);

interface DocRecord {
  documentId: number;
  versionId: number;
  number: string;
  sourcePath: string;
  chunksCount: number;
  indexedAt: string;
}

interface Manifest {
  version: 1;
  lastRun: string;
  documents: Record<string, DocRecord>; // key = DocumentID
}

async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf-8"));
  } catch {
    return { version: 1, lastRun: new Date().toISOString(), documents: {} };
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  manifest.lastRun = new Date().toISOString();
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  const tmpPath = `${MANIFEST_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  await fs.rename(tmpPath, MANIFEST_PATH);
}

const docuzenPath = (documentId: number) => `${DOCUZEN_PATH_PREFIX}${documentId}`;

// SOP trước rồi tới biểu mẫu / phụ lục / list / loại khác: chạy thử --limit thì có ngay phần quan trọng nhất
const GROUP_ORDER = ["sop", "form", "appendix", "list", "other"];

/**
 * Tải, đọc, tạo vector cho một tài liệu rồi thay các đoạn cũ trong Qdrant. Đọc + tạo vector xong hết mới xoá
 * đoạn cũ, nên tài liệu lỗi không làm mất dữ liệu đang có.
 */
async function indexDocument(file: IndexedFile, sourcePath: string, workDir: string): Promise<number> {
  const meta = file.docuzen!;
  const ext = path.extname(sourcePath.replace(/\\/g, "/")).toLowerCase();
  // Đặt file tạm theo "<phòng>/<tên hiển thị><đuôi>": bộ đọc lấy phòng ban từ thư mục, tên tài liệu từ tên file
  const baseName = file.fileName.replace(/[\\/:*?"<>|]+/g, "-").slice(0, MAX_FILE_NAME_CHARS).trim();
  const tmpPath = path.join(workDir, file.category, `${baseName}${ext}`);
  try {
    await downloadDocuzenFile(sourcePath, tmpPath);
    const docs = await readFile(tmpPath, workDir);
    if (docs.length === 0) throw new Error("không đọc được chữ (file rỗng / scan chưa nhận dạng được)");

    const points: PointToInsert[] = [];
    for (const doc of docs) {
      doc.metadata.filePath = docuzenPath(meta.documentId);
      points.push(...(await buildPointsForDocument(doc, points.length)));
    }
    await deleteByFilePath(docuzenPath(meta.documentId));
    for (let i = 0; i < points.length; i += BATCH_SIZE) await upsertPoints(points.slice(i, i + BATCH_SIZE));
    return points.length;
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

async function docuzenIngest() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const reindex = args.includes("--reindex");
  const force = args.includes("--force");
  const limitArg = args[args.indexOf("--limit") + 1];
  const limit = args.includes("--limit") && /^\d+$/.test(limitArg ?? "") ? Number(limitArg) : Infinity;

  console.log("📚 DOCUZEN INGEST\n");
  console.log(`   Collection:  ${config.collectionName}`);
  console.log(`   File server: ${config.docuzenFileBaseUrl}`);
  console.log(`   Manifest:    ${MANIFEST_PATH}`);
  console.log(`   Chế độ:      ${dryRun ? "CHẠY THỬ (không ghi gì)" : reindex ? "index lại mọi tài liệu" : "chỉ tài liệu thay đổi"}${limit < Infinity ? `, tối đa ${limit} tài liệu` : ""}\n`);

  console.log("1️⃣  Đọc danh mục Docuzen (bản đang hiệu lực)...");
  const catalog = await loadDocuzenCatalog();
  const current = catalog.files;
  if (current.length === 0) throw new Error("Docuzen không trả về tài liệu nào (database lỗi?). Không làm gì.");
  console.log(`   ${current.length} tài liệu đang hiệu lực`);

  if (!dryRun) {
    console.log("\n2️⃣  Load embedding model + Qdrant collection...");
    await initEmbedder();
    await ensureCollection(false);
  }

  console.log("\n3️⃣  So với lần index trước...");
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.access(path.dirname(MANIFEST_PATH), fs.constants.W_OK); // lỗi sớm, đừng để index hàng giờ rồi mới lỗi
  const manifest = await loadManifest();
  // Đoạn Docuzen đang có trong Qdrant (kể cả khi mất manifest): chỉ xét đường dẫn docuzen://, không đụng file SMB
  const indexedIds = new Set(
    [...(dryRun ? new Set<string>() : await listIndexedFilePaths())]
      .filter((p) => p.startsWith(DOCUZEN_PATH_PREFIX))
      .map((p) => p.slice(DOCUZEN_PATH_PREFIX.length))
  );
  const trackedIds = new Set([...Object.keys(manifest.documents), ...indexedIds]);
  const currentIds = new Set(current.map((f) => String(f.docuzen!.documentId)));

  const noSource: IndexedFile[] = [];
  const toIndex: { file: IndexedFile; sourcePath: string; isNew: boolean }[] = [];
  let unchanged = 0;
  for (const file of current) {
    const id = String(file.docuzen!.documentId);
    const sourcePath = catalog.sourceByDocumentId.get(file.docuzen!.documentId);
    if (!sourcePath) {
      noSource.push(file);
      continue;
    }
    const prev = manifest.documents[id];
    // Có trong Qdrant nhưng manifest không biết phiên bản (manifest mất) → index lại cho chắc
    if (!prev) toIndex.push({ file, sourcePath, isNew: !indexedIds.has(id) });
    else if (reindex || prev.versionId !== file.docuzen!.versionId || (!dryRun && !indexedIds.has(id))) {
      toIndex.push({ file, sourcePath, isNew: false });
    } else unchanged++;
  }
  // Không còn bản hiện hành (thu hồi / hết hiệu lực) → gỡ khỏi bot
  const toDelete = [...trackedIds].filter((id) => !currentIds.has(id));
  toIndex.sort((a, b) => GROUP_ORDER.indexOf(a.file.docuzen!.group) - GROUP_ORDER.indexOf(b.file.docuzen!.group));
  const batch = toIndex.slice(0, limit);

  const added = toIndex.filter((t) => t.isNew).length;
  console.log(`   ➕ Thêm mới:   ${added}`);
  console.log(`   🔄 Cập nhật:  ${toIndex.length - added} (có phiên bản mới)`);
  console.log(`   ❌ Gỡ:        ${toDelete.length} (không còn bản hiện hành)`);
  console.log(`   ✓  Giữ nguyên: ${unchanged}`);
  if (noSource.length > 0) {
    console.log(`   ⚠️  Bỏ qua ${noSource.length} tài liệu không có file đọc được (.docx / .pdf / .xlsx), vd: ${noSource.slice(0, 3).map((f) => f.docuzen!.number).join(", ")}`);
  }
  if (batch.length < toIndex.length) console.log(`   Lần này index ${batch.length}/${toIndex.length} (--limit)`);

  if (
    !force &&
    toDelete.length >= MIN_DELETE_COUNT_FOR_GUARD &&
    toDelete.length / Math.max(1, trackedIds.size) > MAX_DELETE_RATIO
  ) {
    throw new Error(
      `Sắp gỡ ${toDelete.length}/${trackedIds.size} tài liệu đã index (> ${MAX_DELETE_RATIO * 100}%). ` +
        `Dừng lại để tránh gỡ nhầm (database trả thiếu dữ liệu?). Nếu đúng là muốn gỡ, chạy lại với --force.`
    );
  }
  if (dryRun) {
    console.log("\n(Chạy thử: không ghi gì.)");
    return;
  }
  if (batch.length + toDelete.length === 0) {
    console.log("\n✅ Không có thay đổi.");
    return;
  }

  let failed = 0;
  if (toDelete.length > 0) {
    console.log(`\n4️⃣  Gỡ ${toDelete.length} tài liệu không còn hiệu lực...`);
    for (const id of toDelete) {
      try {
        await deleteByFilePath(docuzenPath(Number(id)));
        console.log(`   ❌ ${manifest.documents[id]?.number ?? `DocumentID ${id}`}`);
        delete manifest.documents[id];
      } catch (err) {
        failed++;
        console.error(`   ⚠️  Không gỡ được DocumentID ${id}: ${(err as Error).message}`);
      }
    }
    await saveManifest(manifest);
  }

  if (batch.length > 0) {
    console.log(`\n5️⃣  Index ${batch.length} tài liệu...`);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "docuzen-ingest-"));
    const startedAt = Date.now();
    const pointsBefore = await countPoints();
    let done = 0;
    let next = 0;
    const failures: string[] = [];
    const worker = async () => {
      while (next < batch.length) {
        const { file, sourcePath, isNew } = batch[next++];
        const meta = file.docuzen!;
        try {
          const chunksCount = await indexDocument(file, sourcePath, workDir);
          manifest.documents[String(meta.documentId)] = {
            documentId: meta.documentId,
            versionId: meta.versionId,
            number: meta.number,
            sourcePath,
            chunksCount,
            indexedAt: new Date().toISOString(),
          };
          done++;
          console.log(`[${done + failures.length}/${batch.length}] ${isNew ? "➕" : "🔄"} ${meta.number} (bản ${meta.version}) → ${chunksCount} đoạn`);
        } catch (err) {
          // Không ghi manifest → lần chạy sau thử lại
          failed++;
          failures.push(`${meta.number}: ${(err as Error).message}`);
          console.error(`[${done + failures.length}/${batch.length}] ❌ ${meta.number}: ${(err as Error).message}`);
        }
        if ((done + failures.length) % SAVE_MANIFEST_EVERY === 0) await saveManifest(manifest);
      }
    };
    try {
      await Promise.all(Array.from({ length: WORKERS }, worker));
    } finally {
      await saveManifest(manifest);
      await fs.rm(workDir, { recursive: true, force: true });
    }

    // Số liệu để ước tính lần chạy toàn bộ và dung lượng Qdrant
    const seconds = (Date.now() - startedAt) / 1000;
    const pointsAdded = (await countPoints()) - pointsBefore;
    const remaining = toIndex.length - batch.length;
    console.log(`\n   Thời gian: ${Math.round(seconds)}s (~${(seconds / Math.max(1, batch.length)).toFixed(1)}s / tài liệu)`);
    console.log(`   Đoạn thêm: ${pointsAdded} (~${Math.round(pointsAdded / Math.max(1, done))} đoạn / tài liệu)`);
    if (remaining > 0) {
      const estimate = (seconds / Math.max(1, batch.length)) * remaining;
      console.log(`   Còn ${remaining} tài liệu, ước tính ~${(estimate / 3600).toFixed(1)} giờ`);
    }
    if (failures.length > 0) {
      console.log(`\n   ⚠️  ${failures.length} tài liệu lỗi (lần chạy sau thử lại):`);
      for (const f of failures.slice(0, 20)) console.log(`      - ${f}`);
    }
  }

  console.log(`\n✅ DOCUZEN INGEST HOÀN TẤT`);
  console.log(`   Tài liệu đã index: ${Object.keys(manifest.documents).length}`);
  console.log(`   Tổng đoạn trong collection: ${await countPoints()}`);
  if (failed > 0) console.log(`   ⚠️  Lỗi: ${failed}`);
  await reportOcr();
}

docuzenIngest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Docuzen ingest thất bại:", (err as Error).message || err);
    process.exit(1);
  });

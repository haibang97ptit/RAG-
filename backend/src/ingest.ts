import path from "path";
import { config } from "./config.js";
import { initEmbedder } from "./embedding.js";
import { ensureCollection, upsertPoints, countPoints } from "./qdrantService.js";
import { readFile, walkDirectory } from "./fileReaders.js";
import { buildPointsForDocument } from "./chunkPoints.js";

const BATCH_SIZE = 32;

async function ingest() {
  const reset = process.argv.includes("--reset");

  console.log("🚀 BẮT ĐẦU INGEST\n");
  console.log(`   Data dir:    ${config.dataDir}`);
  console.log(`   Collection:  ${config.collectionName}`);
  console.log(`   Chunk size:  ${config.chunkSize}`);
  console.log(`   Reset mode:  ${reset ? "YES (xóa hết + index lại)" : "NO (upsert)"}\n`);

  console.log("1️⃣  Load embedding model...");
  await initEmbedder();

  console.log("\n2️⃣  Ensure Qdrant collection...");
  await ensureCollection(reset);

  console.log("\n3️⃣  Scan files...");
  const files = await walkDirectory(config.dataDir);
  console.log(`   Tìm thấy ${files.length} files`);

  if (files.length === 0) {
    console.log("\n⚠️  Không có file nào để index. Kiểm tra thư mục data/");
    return;
  }

  let totalChunks = 0;
  let totalDocs = 0;

  console.log("\n4️⃣  Processing files...\n");

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const fileName = path.basename(filePath);
    const progress = `[${i + 1}/${files.length}]`;

    try {
      const docs = await readFile(filePath, config.dataDir);
      if (docs.length === 0) {
        console.log(`${progress} ⏭️  ${fileName} (skip - không có nội dung)`);
        continue;
      }

      let fileChunks = 0;

      for (const doc of docs) {
        const points = await buildPointsForDocument(doc, fileChunks);
        for (let j = 0; j < points.length; j += BATCH_SIZE) {
          await upsertPoints(points.slice(j, j + BATCH_SIZE));
        }
        fileChunks += points.length;
      }

      totalChunks += fileChunks;
      totalDocs += 1;
      console.log(`${progress} ✓ ${fileName} → ${fileChunks} chunks`);
    } catch (err) {
      const e = err as any;
      console.error(`${progress} ❌ ${fileName}: ${e.message}`);
      if (e.cause) {
        console.error(`   cause: ${e.cause?.code || e.cause?.name || "?"} - ${e.cause?.message || "?"}`);
      }
      if (e.stack) {
        console.error(`   stack: ${e.stack.split("\n").slice(0, 5).join("\n")}`);
      }
    }
  }

  const finalCount = await countPoints();

  console.log(`\n✅ INGEST HOÀN TẤT`);
  console.log(`   Files processed: ${totalDocs}/${files.length}`);
  console.log(`   New chunks:      ${totalChunks}`);
  console.log(`   Total in DB:     ${finalCount}`);
}

ingest().catch((err) => {
  console.error("❌ Ingest thất bại:", err);
  process.exit(1);
});
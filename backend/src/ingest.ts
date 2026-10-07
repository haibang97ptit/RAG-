import path from "path";
import { config } from "./config.js";
import { initEmbedder, embed } from "./embedding.js";
import {
  ensureCollection,
  upsertPoints,
  countPoints,
  type PointToInsert,
} from "./qdrantService.js";
import { readFile, walkDirectory } from "./fileReaders.js";
import { chunkText } from "./chunker.js";

const BATCH_SIZE = 32;

function makePointId(filePath: string, chunkIndex: number, sheetName?: string): number {
  const key = `${filePath}::${sheetName || ""}::${chunkIndex}`;
  // Simple hash → positive 32-bit int (Qdrant chấp nhận unsigned)
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

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
        console.log(`${progress} ⏭️  ${fileName} (skip - không parse được)`);
        continue;
      }

      let fileChunks = 0;

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
            const globalIdx = fileChunks + j + k;
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

        fileChunks += chunks.length;
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

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { connectQualzen, qualzenSettingsFromEnv } from "./qualzenDb.js";
import {
  getActionItemDetail,
  getCapaDetail,
  getCcnDetail,
  searchActionItems,
  searchCapas,
  searchCcns,
} from "./qualzenQueries.js";

/**
 * Chạy thử các truy vấn QualZen trên database thật (chỉ SELECT), không cần Groq:
 *   npm run qualzen:smoke
 * In số liệu tóm tắt ra màn hình và ghi kết quả đầy đủ vào .cache/qualzen-smoke.json (gitignored).
 * Dùng để xác nhận truy vấn đúng với cấu trúc bảng thật trước khi bật tính năng trên server.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const OUTPUT_PATH = path.resolve(__dirname, "../.cache/qualzen-smoke.json");

async function smoke() {
  const settings = qualzenSettingsFromEnv();
  if (!settings) throw new Error("Thiếu cấu hình QUALZEN_DB_* trong backend/.env");

  const pool = await connectQualzen(settings);
  const report: Record<string, unknown> = {};
  let failed = 0;

  const step = async (name: string, run: () => Promise<any>, summarize: (result: any) => string) => {
    try {
      const result = await run();
      const { _rows, ...clean } = result ?? {};
      report[name] = clean;
      console.log(`✓ ${name}: ${summarize(result)}`);
      return result;
    } catch (err) {
      failed++;
      report[name] = { loi: (err as Error).message };
      console.log(`✗ ${name}: ${(err as Error).message}`);
      return null;
    }
  };

  const listSummary = (r: any) => `tổng ${r.tongSo}, hiển thị ${r.soDongHienThi}`;

  // ---- Action Item ----
  const all = await step("action_item / tất cả", () => searchActionItems(pool, {}, 5), (r) =>
    `${listSummary(r)} | ${JSON.stringify(r.thongKe)}`
  );
  await step("action_item / quá hạn", () => searchActionItems(pool, { status: "overdue" }, 5), listSummary);
  await step("action_item / IT đang mở", () => searchActionItems(pool, { department: "IT", status: "open" }, 5), listSummary);
  await step("action_item / chờ QA duyệt", () => searchActionItems(pool, { status: "pending_qa" }, 5), listSummary);
  await step("action_item / tạo trong 30 ngày", () => {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return searchActionItems(pool, { createdFrom: from }, 5);
  }, listSummary);

  const firstAi = all?._rows?.[0];
  if (firstAi) {
    await step(`action_item / chi tiết ${firstAi.ActionPlanNumber}`, () => getActionItemDetail(pool, firstAi), (r) =>
      `trạng thái "${r.trangThai}", chờ: ${r.dangChoAi ?? "-"}, ${r.lichSuXuLy.length} dòng lịch sử, thuộc ${r.thuocSuKien}`
    );
    // Tra lại bằng cách gõ tắt: chỉ số thứ tự cuối mã
    const seq = String(firstAi.ActionPlanNumber).split("/").pop();
    await step(`action_item / gõ tắt "AI ${seq}"`, () => searchActionItems(pool, { number: `AI ${seq}` }, 5), listSummary);
  }

  // ---- CCN ----
  const ccns = await step("ccn / mới nhất", () => searchCcns(pool, {}, 5), listSummary);
  const firstCcn = ccns?._rows?.find((r: any) => !String(r.CCN_No).startsWith("DFT/"));
  if (firstCcn) {
    await step(`ccn / chi tiết ${firstCcn.CCN_No}`, () => getCcnDetail(pool, firstCcn), (r) =>
      `trạng thái "${r.trangThai}", chờ: ${r.dangChoAi ?? "-"}, ${r.actionItems.tongSo} action item`
    );
  }
  await step("ccn / phòng IT", () => searchCcns(pool, { department: "IT" }, 5), listSummary);

  // ---- CAPA ----
  const capas = await step("capa / mới nhất", () => searchCapas(pool, {}, 5), listSummary);
  const firstCapa = capas?._rows?.[0];
  if (firstCapa) {
    await step(`capa / chi tiết ${firstCapa.CAPA_Number}`, () => getCapaDetail(pool, firstCapa), (r) =>
      `sự kiện gốc ${r.suKienGoc}, chờ: ${r.dangChoAi ?? "-"}, ${r.actionItems.tongSo} action item`
    );
    await step(
      `action_item / thuộc ${firstCapa.CAPA_Number}`,
      () => searchActionItems(pool, { sourceType: "CAPA", sourceNumber: firstCapa.CAPA_Number }, 5),
      listSummary
    );
  }

  await pool.close();
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2), "utf-8");

  console.log(`\n${failed === 0 ? "✅ Tất cả truy vấn chạy được" : `❌ ${failed} truy vấn lỗi`}. Kết quả đầy đủ: ${OUTPUT_PATH}`);
  if (failed > 0) process.exit(1);
}

smoke().catch((err) => {
  console.error("❌ Chạy thử thất bại:", (err as Error).message || err);
  process.exit(1);
});

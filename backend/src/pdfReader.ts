import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import pdfParse from "pdf-parse";
import { config } from "./config.js";
import { repairMisencodedPage } from "./textRepair.js";

/**
 * Đọc PDF, nhận dạng chữ (OCR) cho các trang scan.
 *
 * pdf-parse chỉ lấy được lớp chữ có sẵn trong file: PDF scan (ảnh chụp) gần như không có chữ nào.
 * Trang được coi là scan khi lớp chữ quá ít (OCR_MIN_TEXT_CHARS), hoặc hơi ít mà trang có ảnh lớn
 * (OCR_IMAGE_TEXT_CHARS) - con dấu, header in thêm lên bản scan vẫn tạo ra vài chục ký tự thật.
 * Trang scan: pdftoppm (poppler) chuyển thành ảnh → tesseract nhận dạng tiếng Việt + tiếng Anh.
 * Giữ bản nào nhiều chữ hơn (OCR hay lớp chữ gốc), nên trang chữ thật không bị thay bằng bản kém hơn.
 *
 * Kết quả OCR được lưu theo mã băm nội dung file trong <STATE_DIR>/ocr-cache (không OCR lại file
 * không đổi, kể cả khi index lại toàn bộ), kèm bản chữ để người xem lại trong <STATE_DIR>/ocr-text.
 * Máy không có tesseract / poppler (vd máy dev Windows) → đọc như cũ, chỉ cảnh báo một lần.
 */

const run = promisify(execFile);

// Đổi khi đổi cách OCR (ngưỡng, độ phân giải, ngôn ngữ...) để cache cũ không còn được dùng
const OCR_CACHE_VERSION = 1;
const PAGE_TIMEOUT_MS = 180_000;
// Ảnh chiếm từ chừng này điểm ảnh trở lên coi là ảnh "lớn" (trang A4 scan 150 dpi ≈ 1240 x 1754)
const LARGE_IMAGE_PIXELS = 800_000;

export interface PdfPage {
  page: number; // bắt đầu từ 1
  text: string;
  source: "text" | "ocr";
  confidence?: number; // độ tin cậy trung bình của tesseract (0-100), chỉ có ở trang OCR
}

export interface PdfReadResult {
  text: string;
  pages: PdfPage[];
  ocrPages: number; // số trang lấy chữ từ OCR
  confidence: number | null; // trung bình các trang OCR
  fromCache: boolean;
}

/** Thống kê OCR trong một lần nạp tài liệu, để in báo cáo cuối lần nạp. */
export interface OcrFileStat {
  filePath: string;
  pages: number;
  ocrPages: number;
  confidence: number | null;
  minConfidence: number | null; // trang kém nhất: độ tin cậy trung bình cả file che mất trang hỏng
  fromCache: boolean;
}
export const ocrStats: OcrFileStat[] = [];

let toolsChecked: Promise<boolean> | null = null;

/** Có đủ pdftoppm, pdfimages, tesseract (kèm gói tiếng Việt) không. Kiểm tra một lần. */
export function ocrAvailable(): Promise<boolean> {
  toolsChecked ??= (async () => {
    if (!config.ocrEnabled) return false;
    try {
      await run("pdftoppm", ["-v"]);
      await run("pdfimages", ["-v"]);
      const { stdout } = await run("tesseract", ["--list-langs"]);
      const langs = stdout.split(/\s+/);
      const missing = config.ocrLang.split("+").filter((l) => !langs.includes(l));
      if (missing.length > 0) {
        console.warn(`⚠️  OCR tắt: tesseract thiếu gói ngôn ngữ ${missing.join(", ")}`);
        return false;
      }
      return true;
    } catch {
      console.warn("⚠️  OCR tắt: máy này không có tesseract / poppler-utils - PDF scan sẽ không đọc được");
      return false;
    }
  })();
  return toolsChecked;
}

/**
 * Lớp chữ của từng trang, cùng cách ghép dòng với pdf-parse trước đây (để PDF thường không đổi nội dung).
 * Trang có chữ tiếng Việt bị lỗi bảng mã font được sửa lại (xem textRepair.ts).
 */
async function textLayerPages(buffer: Buffer): Promise<string[]> {
  const pages: string[] = [];
  await pdfParse(buffer, {
    pagerender: async (pageData: any) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined;
      let text = "";
      for (const item of content.items) {
        if (lastY === item.transform[5] || !lastY) text += item.str;
        else text += "\n" + item.str;
        lastY = item.transform[5];
      }
      const repaired = repairMisencodedPage(text);
      pages.push(repaired);
      return repaired;
    },
  });
  return pages;
}

/** Các trang có ảnh lớn (dấu hiệu trang scan), theo `pdfimages -list`. */
async function pagesWithLargeImages(filePath: string): Promise<Set<number>> {
  const result = new Set<number>();
  try {
    const { stdout } = await run("pdfimages", ["-list", filePath], { maxBuffer: 16 * 1024 * 1024 });
    // Cột: page num type width height ...
    for (const line of stdout.split("\n").slice(2)) {
      const cols = line.trim().split(/\s+/);
      const page = Number(cols[0]);
      const width = Number(cols[3]);
      const height = Number(cols[4]);
      if (page > 0 && width * height >= LARGE_IMAGE_PIXELS) result.add(page);
    }
  } catch {
    // không đọc được danh sách ảnh → chỉ dựa vào số ký tự
  }
  return result;
}

/** OCR một trang: trả về chữ và độ tin cậy trung bình của các từ. */
async function ocrPage(filePath: string, page: number, workDir: string): Promise<{ text: string; confidence: number }> {
  const imagePrefix = path.join(workDir, `p${page}`);
  await run(
    "pdftoppm",
    ["-r", String(config.ocrDpi), "-gray", "-png", "-f", String(page), "-l", String(page), "-singlefile", filePath, imagePrefix],
    { timeout: PAGE_TIMEOUT_MS }
  );
  const outBase = path.join(workDir, `o${page}`);
  // Một lần chạy cho ra cả bản chữ (.txt) và bảng từng từ kèm độ tin cậy (.tsv)
  await run("tesseract", [`${imagePrefix}.png`, outBase, "-l", config.ocrLang, "--psm", "3", "txt", "tsv"], {
    timeout: PAGE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const [text, tsv] = await Promise.all([
    fs.readFile(`${outBase}.txt`, "utf-8"),
    fs.readFile(`${outBase}.tsv`, "utf-8"),
  ]);
  const confidences = tsv
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 12 && cols[11].trim() !== "" && Number(cols[10]) >= 0)
    .map((cols) => Number(cols[10]));
  const confidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return { text: text.replace(/\f/g, "").trim(), confidence };
}

const cacheDir = () => path.join(config.stateDir, "ocr-cache");
const textExportDir = () => path.join(config.stateDir, "ocr-text");

/** Bản chữ để người xem lại: cùng đường dẫn tương đối với file trong thư mục tài liệu, đuôi .txt. */
async function exportText(filePath: string, pages: PdfPage[]): Promise<void> {
  const relative = path.relative(config.dataDir, filePath);
  const safeRelative = relative.startsWith("..") ? path.basename(filePath) : relative;
  const target = path.join(textExportDir(), `${safeRelative}.txt`);
  const body = pages
    .map((p) => {
      const label = p.source === "ocr" ? `OCR, độ tin cậy ${Math.round(p.confidence ?? 0)}%` : "lớp chữ có sẵn";
      return `===== Trang ${p.page} (${label}) =====\n${p.text}`;
    })
    .join("\n\n");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, "utf-8");
}

function joinPages(pages: PdfPage[]): string {
  // Cùng cách nối trang với pdf-parse: mỗi trang bắt đầu bằng một dòng trống
  return pages.map((p) => `\n\n${p.text}`).join("");
}

// Có trang độ tin cậy dưới mức này: nên người kiểm tra tay / thay bằng bản Word gốc.
// Đo thử: trang scan nghiêng + mờ tesseract vẫn chấm ~82% mà chỉ đúng ~60% số từ, nên ngưỡng phải cao.
const LOW_CONFIDENCE = 85;

/**
 * In báo cáo OCR của lần nạp này và ghi ra <STATE_DIR>/ocr-report.md.
 * Chỉ liệt kê file được OCR trong lần chạy này (file không đổi thì không đọc lại).
 */
export async function reportOcr(): Promise<void> {
  const ocred = ocrStats.filter((s) => s.ocrPages > 0);
  if (ocred.length === 0) return;

  const relative = (p: string) => path.relative(config.dataDir, p) || p;
  const low = ocred.filter((s) => (s.minConfidence ?? 0) < LOW_CONFIDENCE);
  const totalPages = ocred.reduce((n, s) => n + s.ocrPages, 0);

  console.log(`\n🔎 OCR: ${ocred.length} file PDF scan, ${totalPages} trang nhận dạng chữ`);
  if (low.length > 0) {
    console.log(`   ⚠️  ${low.length} file có trang độ tin cậy thấp (< ${LOW_CONFIDENCE}%), nên kiểm tra tay hoặc thay bằng bản Word gốc:`);
    for (const s of low) console.log(`      - ${relative(s.filePath)} (trang kém nhất ${Math.round(s.minConfidence ?? 0)}%)`);
  }

  const lines = [
    `# Báo cáo OCR (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`,
    "",
    `${ocred.length} file PDF scan, ${totalPages} trang nhận dạng chữ. Bản chữ của từng file nằm trong ${textExportDir()}.`,
    "",
    "| File | Trang OCR / tổng | Độ tin cậy trung bình | Trang kém nhất | Ghi chú |",
    "|---|---|---|---|---|",
    ...ocred
      .sort((a, b) => (a.minConfidence ?? 0) - (b.minConfidence ?? 0))
      .map((s) => {
        const conf = Math.round(s.confidence ?? 0);
        const worst = Math.round(s.minConfidence ?? 0);
        const note = [worst < LOW_CONFIDENCE ? "cần kiểm tra" : "", s.fromCache ? "dùng lại kết quả cũ" : ""].filter(Boolean).join(", ");
        return `| ${relative(s.filePath)} | ${s.ocrPages} / ${s.pages} | ${conf}% | ${worst}% | ${note} |`;
      }),
  ];
  const reportPath = path.join(config.stateDir, "ocr-report.md");
  try {
    await fs.mkdir(config.stateDir, { recursive: true });
    await fs.writeFile(reportPath, lines.join("\n") + "\n", "utf-8");
    console.log(`   Báo cáo: ${reportPath}`);
  } catch (err) {
    console.warn(`   Không ghi được báo cáo OCR: ${(err as Error).message}`);
  }
}

export async function readPdf(filePath: string): Promise<PdfReadResult> {
  const buffer = await fs.readFile(filePath);
  const layer = await textLayerPages(buffer);
  const plain = (): PdfReadResult => ({
    text: joinPages(layer.map((text, i) => ({ page: i + 1, text, source: "text" as const }))),
    pages: layer.map((text, i) => ({ page: i + 1, text, source: "text" as const })),
    ocrPages: 0,
    confidence: null,
    fromCache: false,
  });

  if (!(await ocrAvailable())) return plain();

  const charCount = (t: string) => t.replace(/\s+/g, "").length;
  const imagePages = await pagesWithLargeImages(filePath);
  const needsOcr = layer
    .map((text, i) => ({ page: i + 1, chars: charCount(text) }))
    .filter(({ page, chars }) => chars < config.ocrMinTextChars || (chars < config.ocrImageTextChars && imagePages.has(page)))
    .map(({ page }) => page);
  if (needsOcr.length === 0) return plain();

  // Cache theo nội dung file + cách OCR
  const hash = crypto
    .createHash("sha256")
    .update(buffer)
    .update(JSON.stringify([OCR_CACHE_VERSION, config.ocrLang, config.ocrDpi, needsOcr]))
    .digest("hex");
  const cachePath = path.join(cacheDir(), `${hash}.json`);
  let ocrByPage: Record<number, { text: string; confidence: number }> = {};
  let fromCache = false;
  try {
    ocrByPage = JSON.parse(await fs.readFile(cachePath, "utf-8"));
    fromCache = true;
  } catch {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sop-ocr-"));
    try {
      for (const page of needsOcr) {
        ocrByPage[page] = await ocrPage(filePath, page, workDir);
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(ocrByPage), "utf-8");
  }

  const pages: PdfPage[] = layer.map((text, i) => {
    const ocr = ocrByPage[i + 1];
    // Giữ bản nhiều chữ hơn: trang chữ thật ít chữ (bìa, trang ký) không bị thay bằng bản OCR kém hơn
    if (ocr && charCount(ocr.text) > charCount(text)) {
      return { page: i + 1, text: ocr.text, source: "ocr", confidence: ocr.confidence };
    }
    return { page: i + 1, text, source: "text" };
  });
  const ocrPages = pages.filter((p) => p.source === "ocr");
  const confidence = ocrPages.length > 0 ? ocrPages.reduce((s, p) => s + (p.confidence ?? 0), 0) / ocrPages.length : null;

  if (ocrPages.length > 0) {
    await exportText(filePath, pages).catch((err) => console.warn(`   Không lưu được bản chữ OCR: ${(err as Error).message}`));
  }
  const minConfidence = ocrPages.length > 0 ? Math.min(...ocrPages.map((p) => p.confidence ?? 0)) : null;
  ocrStats.push({ filePath, pages: pages.length, ocrPages: ocrPages.length, confidence, minConfidence, fromCache });

  return { text: joinPages(pages), pages, ocrPages: ocrPages.length, confidence, fromCache };
}

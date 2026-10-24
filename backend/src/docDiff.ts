import path from "path";
import { diffArrays, diffWords } from "diff";
import { config } from "./config.js";
import fs from "fs/promises";
import os from "os";
import { readFile, type ParsedDocument } from "./fileReaders.js";
import { currentSourceOf, docuzenDocumentId, downloadDocuzenFile } from "./docuzenCatalog.js";
import { stripExtension } from "./fileCatalog.js";

/**
 * So sánh hai phiên bản tài liệu: tìm đủ các đoạn thêm, bỏ, sửa, chuyển vị trí.
 *
 * Code so toàn văn (không qua AI) để không sót thay đổi nào:
 *  1. đọc lại hai file gốc (không ghép từ các đoạn đã cắt, vì các đoạn chồng mép nhau);
 *  2. ghép các dòng bị ngắt (PDF xuống dòng theo khổ giấy) thành đoạn;
 *  3. chia mỗi bản thành KHỐI theo mã (MaV-1, MiV-PA12…) hoặc theo tiêu đề mục, rồi ghép khối cùng mã /
 *     cùng tên mục giữa hai bản. So trong từng cặp khối thay vì so cả tài liệu như một chuỗi đoạn liền nhau:
 *     hai bản trình bày khác nhau (bảng, đánh số lại, đổi thứ tự mục) vẫn ghép đúng mục với mục;
 *  4. trong mỗi cặp khối: so theo đoạn (thuật toán Myers, như git diff) với cách so "lỏng" - bỏ qua
 *     khoảng trắng, dấu câu, số thứ tự đầu dòng - rồi so từng từ trong các đoạn bị sửa.
 * Danh sách thay đổi do server in đầy đủ; AI chỉ nhận phần tóm tắt để viết đoạn mở đầu.
 */

export const DIFF_LIST_HEADING = "**Chi tiết các thay đổi";

const MAX_LISTED_CHANGES = 150;
const ITEM_CHARS = 320; // độ dài tối đa mỗi mục trong danh sách (giữ phần quanh chỗ đổi)
const CONTEXT_WORDS = 12; // số từ giữ lại trước / sau chỗ đổi trong đoạn sửa
// Hai đoạn bị thay cùng chỗ được coi là "sửa" (thay vì bỏ + thêm) khi giống nhau ít nhất mức này
const MODIFY_SIMILARITY = 0.45;
// Khối không cùng mã / cùng tên: ghép với nhau khi tên mục giống nhau ít nhất mức này
const BLOCK_TITLE_SIMILARITY = 0.6;
const PREAMBLE = "(phần đầu tài liệu)";

export interface DiffChange {
  kind: "added" | "removed" | "modified" | "moved";
  section: string;
  before?: string;
  after?: string;
  rendered: string; // markdown một dòng
  weight: number; // độ lớn thay đổi (số ký tự đổi), để chọn thay đổi quan trọng cho AI
  wholeSection?: boolean; // cả mục chỉ có ở một bản
}

export interface DiffResult {
  fileA: string;
  fileB: string;
  paragraphsA: number;
  paragraphsB: number;
  // Tỉ lệ đoạn giống nhau (trên bản dài hơn): thấp nghĩa là hai tài liệu khác nhau phần lớn,
  // có thể không phải hai phiên bản của cùng một tài liệu
  similarity: number;
  formatOnly: number; // đoạn chỉ khác khoảng trắng / dấu câu / số thứ tự: không liệt kê
  addedSections: string[];
  removedSections: string[];
  changes: DiffChange[];
  counts: Record<DiffChange["kind"], number>;
  bySection: Record<string, number>;
}

// ---------------- Tách đoạn ----------------

// Dòng bắt đầu một ý mới: đánh số, chữ cái, số La Mã, gạch đầu dòng, mã thay đổi (MaV-1, MiV-2)…
// Số phải có dấu chấm / ngoặc ("4.", "4)", "3.1"): dòng bị ngắt giữa câu có thể bắt đầu bằng con số ("4 tại khoản…")
const STARTS_ITEM =
  /^(?:\d+[.)]\s|\d+(?:\.\d+)+[.)]?\s|[A-ZĐ][.)]\s|[IVXLC]+[.)]\s|[a-zđ][.)]\s|\(\w{1,3}\)\s|[-•+*–]\s|M[ai]V\s*[-–—]\s*(?:PA|N)?\s*\d|Điều\s+\d|Chương\s+[IVXLC\d]|#)/u;
// Dòng gạch / chấm trang trí trong văn bản hành chính
const DECORATION = /[_.…·\-–=]{4,}/g;
const ENDS_SENTENCE = /[.:;!?…)]$/;
const PAGE_NUMBER = /^(?:trang\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?$/iu;
const STARTS_LOWERCASE = /^\p{Ll}/u;

/**
 * Tiêu đề mục: dòng ngắn đánh số / La Mã / chữ cái ở đầu, "Chương I", "Điều 1.", hoặc toàn chữ in hoa.
 * Dòng đánh số dài là đoạn văn bị ngắt dòng ("1. Thông tư này quy định chi tiết…"), không phải tiêu đề;
 * dòng mà dòng sau viết tiếp bằng chữ thường ("1. Nội" / "dung thay đổi") cũng không phải tiêu đề.
 */
function isSectionHeading(line: string, nextLine: string): boolean {
  const text = line.trim();
  if (text.length < 3 || text.length > 120) return false;
  if (STARTS_LOWERCASE.test(nextLine)) return false;
  // Dòng chưa trọn ý ("7 (MaV-" rồi dòng sau "7)"): ngoặc chưa đóng hoặc kết thúc bằng gạch nối
  if ((text.match(/\(/g) ?? []).length > (text.match(/\)/g) ?? []).length || /[-(/]$/.test(text)) return false;
  if (/^#{1,6}\s/.test(text)) return true;
  if (/^(?:Chương\s+[IVXLC\d]+|Điều\s+\d+[a-zđ]?\.)/u.test(text) && text.length <= 90) return true;
  if (/^(?:[IVXLC]+|[A-ZĐ]|\d+(?:\.\d+)*)[.)]?\s+\S/u.test(text) && text.length <= 60 && !/[.;,:]$/.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 6 && letters === letters.toUpperCase();
}

interface Paragraph {
  text: string; // để hiển thị
  key: string; // so "lỏng": bỏ khoảng trắng, dấu câu, số thứ tự đầu dòng
  exact: string; // so chính xác (chỉ gộp khoảng trắng), để đếm đoạn chỉ khác định dạng
  heading: boolean;
}

const normalizeExact = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
// Số thứ tự đầu dòng: "3.", "3.2", "1.2.", "a)", "IV.", "(b)" (số không có dấu chấm như "5 năm" thì không phải)
const LEADING_NUMBER = /^\s*\(?(?:\d+(?:\.\d+)+[.)]?|\d+[.)]|[a-zđ][.)]|[ivxlc]+[.)])\s*/iu;
const normalizeLenient = (text: string) =>
  text.normalize("NFC").toLowerCase().replace(LEADING_NUMBER, "").replace(/[^\p{L}\p{N}]+/gu, "");

function makeParagraph(text: string, heading = false): Paragraph {
  return { text, key: normalizeLenient(text) || normalizeExact(text).toLowerCase(), exact: normalizeExact(text), heading };
}

/** Ghép các dòng bị ngắt thành đoạn; bỏ số trang và các dòng lặp ở mọi trang (đầu / chân trang). */
function toParagraphs(rawText: string): Paragraph[] {
  const lines = rawText
    .replace(/^\[Tài liệu:[^\]]*\]\s*/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(DECORATION, " ").replace(/\s+/g, " ").trim());

  // Dòng xuất hiện rất nhiều lần (đầu trang, chân trang: tên / mã tài liệu) không phải nội dung.
  // Dòng ngắn lặp lại ("dung" trong ô bảng "Nội / dung / thay đổi N") là nội dung, không bỏ.
  const freq = new Map<string, number>();
  for (const l of lines) if (l) freq.set(l, (freq.get(l) ?? 0) + 1);
  const repeated = (l: string) => l.length >= 12 && l.length < 80 && (freq.get(l) ?? 0) >= 5;
  const nextNonEmpty = (i: number) => {
    for (let k = i + 1; k < lines.length; k++) if (lines[k]) return lines[k];
    return "";
  };

  const paragraphs: Paragraph[] = [];
  let current = "";
  const flush = () => {
    const text = current.trim();
    if (text) paragraphs.push(makeParagraph(text));
    current = "";
  };

  lines.forEach((line, i) => {
    if (!line) {
      // dòng trống: hết đoạn nếu câu trước đã trọn
      if (ENDS_SENTENCE.test(current)) flush();
      return;
    }
    if (PAGE_NUMBER.test(line) || repeated(line)) return;
    // Dòng bảng (bảng trong file Word đọc ra dạng | ô | ô |): mỗi hàng là một đơn vị so sánh riêng
    if (line.startsWith("|")) {
      flush();
      if (!/^\|[\s:|-]+\|?$/.test(line)) paragraphs.push(makeParagraph(line));
      return;
    }
    if (isSectionHeading(line, nextNonEmpty(i))) {
      flush();
      paragraphs.push(makeParagraph(line.slice(0, 120), true));
      return;
    }
    if (current && (STARTS_ITEM.test(line) || ENDS_SENTENCE.test(current))) flush();
    current = current ? `${current} ${line}` : line;
  });
  flush();
  return paragraphs;
}

// ---------------- Chia khối ----------------

interface Block {
  key: string;
  title: string;
  paragraphs: Paragraph[];
}

// Mã thay đổi trong văn bản đăng ký thuốc: MaV-1, MiV-PA12, MiV-N3 (viết "MaV- 1", "MiV-PA 44"...)
// (gạch nối có khi là gạch thường, có khi là gạch dài "–")
const CODE = /(M[ai]V)\s*[-–—]\s*(PA|N)?\s*[-–—]?\s*(\d{1,3}[a-z]?)/iu;
const normalizeCode = (m: RegExpMatchArray) => `${m[1].toUpperCase()}-${(m[2] ?? "").toUpperCase()}${m[3].toLowerCase()}`;

/**
 * Mã của khối nếu đoạn này mở đầu một khối mã: "MaV-1 Thay đổi, bổ sung…" (bản mới) hoặc
 * "1. Nội dung thay đổi 1 (MaV-1)" (bản cũ). Đoạn chỉ nhắc tới mã ("áp dụng MiV-PA3") thì không.
 */
function blockCode(p: Paragraph): string | null {
  const text = p.exact;
  const leading = text.match(new RegExp(`^${CODE.source}\\s+\\p{Lu}`, "iu"));
  if (leading) return normalizeCode(leading);
  if (/^\d*\.?\s*nội\s+(?:dung\s+)?thay\s+đổi/iu.test(text) && text.length <= 80) {
    const m = text.match(CODE);
    if (m) return normalizeCode(m);
  }
  return null;
}

function toBlocks(paragraphs: Paragraph[]): Block[] {
  const blocks: Block[] = [{ key: "__preamble#1", title: PREAMBLE, paragraphs: [] }];
  const seen = new Map<string, number>();
  const start = (base: string, title: string) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    blocks.push({ key: `${base}#${n}`, title: title.slice(0, 100), paragraphs: [] });
  };
  for (const p of paragraphs) {
    const code = blockCode(p);
    if (code) start(`code:${code}`, code);
    else if (p.heading) start(`title:${p.key}`, p.text);
    blocks[blocks.length - 1].paragraphs.push(p);
  }
  return blocks.filter((b) => b.paragraphs.length > 0);
}

// ---------------- So sánh ----------------

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** Độ giống (Dice trên tập từ) giữa hai đoạn. */
function similarity(a: string, b: string): number {
  const wa = new Set(words(a.toLowerCase()));
  const wb = new Set(words(b.toLowerCase()));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return (2 * common) / (wa.size + wb.size);
}

const clip = (text: string, max = ITEM_CHARS) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
// Ký tự markdown trong nội dung tài liệu không được làm vỡ định dạng danh sách
// (| không cần thoát: một dòng trong danh sách không thành bảng markdown)
const escapeMd = (text: string) => text.replace(/([*_~`[\]])/g, "\\$1");

/**
 * Đoạn bị sửa: chỉ giữ phần quanh chỗ đổi, chữ bỏ gạch ngang, chữ thêm in đậm.
 * Số thứ tự đầu dòng lấy theo bản mới và không tính là thay đổi (đánh số lại không phải sửa nội dung).
 */
function renderModification(before: string, after: string): { rendered: string; weight: number } {
  const lead = after.match(LEADING_NUMBER)?.[0] ?? "";
  const parts = diffWords(before.replace(LEADING_NUMBER, ""), after.replace(LEADING_NUMBER, ""));
  let weight = 0;
  const pieces: string[] = [];
  parts.forEach((p, i) => {
    if (p.added || p.removed) {
      // Chỉ tính là thay đổi khi có chữ / số, không tính khác biệt dấu câu, khoảng trắng
      if (/[\p{L}\p{N}]/u.test(p.value)) weight += p.value.trim().length;
      const value = escapeMd(p.value.trim());
      if (value) pieces.push(p.added ? `**${value}**` : `~~${value}~~`);
      return;
    }
    // Phần giống nhau: giữ vài từ sát chỗ đổi, phần giữa dài thì rút gọn
    const w = words(p.value);
    const isFirst = i === 0;
    const isLast = i === parts.length - 1;
    if (isFirst) pieces.push((w.length > CONTEXT_WORDS ? "… " : "") + escapeMd(w.slice(-CONTEXT_WORDS).join(" ")));
    else if (isLast) pieces.push(escapeMd(w.slice(0, CONTEXT_WORDS).join(" ")) + (w.length > CONTEXT_WORDS ? " …" : ""));
    else if (w.length > 2 * CONTEXT_WORDS) {
      pieces.push(`${escapeMd(w.slice(0, CONTEXT_WORDS).join(" "))} … ${escapeMd(w.slice(-CONTEXT_WORDS).join(" "))}`);
    } else pieces.push(escapeMd(w.join(" ")));
  });
  const body = pieces.filter(Boolean).join(" ");
  return { rendered: clip(lead && !body.startsWith("…") ? `${escapeMd(lead.trim())} ${body}` : body, ITEM_CHARS * 2), weight };
}

interface BlockDiff {
  changes: DiffChange[];
  unchanged: number;
  formatOnly: number;
}

/** So hai danh sách đoạn (thuộc cùng một mục ở hai bản). */
function diffParagraphs(a: Paragraph[], b: Paragraph[], section: string): BlockDiff {
  const hunks = diffArrays(a.map((p) => p.key), b.map((p) => p.key));
  const changes: DiffChange[] = [];
  let ia = 0;
  let ib = 0;
  let unchanged = 0;
  let formatOnly = 0;

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const n = hunk.count ?? hunk.value.length;
    if (!hunk.added && !hunk.removed) {
      for (let k = 0; k < n; k++) if (a[ia + k].exact !== b[ib + k].exact) formatOnly++;
      ia += n;
      ib += n;
      unchanged += n;
      continue;
    }
    // Một cụm bỏ đi ngay cạnh một cụm thêm vào: ghép từng cặp đoạn giống nhau thành "sửa"
    const removed: Paragraph[] = [];
    const added: Paragraph[] = [];
    if (hunk.removed) {
      removed.push(...a.slice(ia, ia + n));
      ia += n;
      const next = hunks[h + 1];
      if (next?.added) {
        const m = next.count ?? next.value.length;
        added.push(...b.slice(ib, ib + m));
        ib += m;
        h++;
      }
    } else {
      added.push(...b.slice(ib, ib + n));
      ib += n;
    }

    const usedAdded = new Set<number>();
    for (const r of removed) {
      let best = -1;
      let bestScore = MODIFY_SIMILARITY;
      added.forEach((ad, k) => {
        if (usedAdded.has(k)) return;
        const score = similarity(r.text, ad.text);
        if (score >= bestScore) {
          best = k;
          bestScore = score;
        }
      });
      if (best >= 0) {
        usedAdded.add(best);
        const ad = added[best];
        const { rendered, weight } = renderModification(r.text, ad.text);
        if (weight > 0) changes.push({ kind: "modified", section, before: r.text, after: ad.text, rendered, weight });
        else formatOnly++;
      } else {
        changes.push({ kind: "removed", section, before: r.text, rendered: `“${escapeMd(clip(r.text))}”`, weight: r.text.length });
      }
    }
    added.forEach((ad, k) => {
      if (usedAdded.has(k)) return;
      changes.push({ kind: "added", section, after: ad.text, rendered: `“${escapeMd(clip(ad.text))}”`, weight: ad.text.length });
    });
  }
  return { changes, unchanged, formatOnly };
}

/** Cả mục chỉ có ở một bản: một dòng gọn thay vì liệt kê từng đoạn. */
function wholeBlockChange(block: Block, kind: "added" | "removed"): DiffChange {
  const body = block.paragraphs.filter((p) => !p.heading).map((p) => p.text);
  const text = body.join(" ");
  const excerpt = body.length > 0 ? `: “${escapeMd(clip(body[0], 200))}”` : "";
  return {
    kind,
    section: block.title,
    ...(kind === "added" ? { after: text || block.title } : { before: text || block.title }),
    rendered: `cả mục **${escapeMd(block.title)}** (${block.paragraphs.length} đoạn)${excerpt}`,
    weight: Math.max(text.length, block.title.length),
    wholeSection: true,
  };
}

/** Ghép khối hai bản: cùng mã / cùng tên mục trước, sau đó tên mục gần giống. */
function matchBlocks(a: Block[], b: Block[]): Map<number, number> {
  const pairs = new Map<number, number>(); // chỉ số khối A → chỉ số khối B
  const usedB = new Set<number>();
  const byKey = new Map(b.map((block, j) => [block.key, j]));
  a.forEach((block, i) => {
    const j = byKey.get(block.key);
    if (j !== undefined && !usedB.has(j)) {
      pairs.set(i, j);
      usedB.add(j);
    }
  });
  a.forEach((block, i) => {
    if (pairs.has(i) || block.key.startsWith("code:")) return;
    let best = -1;
    let bestScore = BLOCK_TITLE_SIMILARITY;
    b.forEach((other, j) => {
      if (usedB.has(j) || other.key.startsWith("code:")) return;
      const score = similarity(block.title, other.title);
      if (score >= bestScore) {
        best = j;
        bestScore = score;
      }
    });
    if (best >= 0) {
      pairs.set(i, best);
      usedB.add(best);
    }
  });
  return pairs;
}

function diffBlocks(a: Block[], b: Block[]) {
  const pairs = matchBlocks(a, b);
  const pairedB = new Map([...pairs].map(([i, j]) => [j, i]));
  // Khối chỉ có ở bản A: đặt ngay sau khối B tương ứng với khối A đứng trước nó
  const removedAfterB = new Map<number, number[]>();
  let lastPairedB = -1;
  a.forEach((_, i) => {
    if (pairs.has(i)) lastPairedB = pairs.get(i)!;
    else removedAfterB.set(lastPairedB, [...(removedAfterB.get(lastPairedB) ?? []), i]);
  });

  const changes: DiffChange[] = [];
  let unchanged = 0;
  let formatOnly = 0;
  const addedSections: string[] = [];
  const removedSections: string[] = [];
  const emitRemoved = (afterB: number) => {
    for (const i of removedAfterB.get(afterB) ?? []) {
      changes.push(wholeBlockChange(a[i], "removed"));
      removedSections.push(a[i].title);
    }
  };

  emitRemoved(-1);
  b.forEach((blockB, j) => {
    const i = pairedB.get(j);
    if (i === undefined) {
      changes.push(wholeBlockChange(blockB, "added"));
      addedSections.push(blockB.title);
    } else {
      const d = diffParagraphs(a[i].paragraphs, blockB.paragraphs, blockB.title);
      changes.push(...d.changes);
      unchanged += d.unchanged;
      formatOnly += d.formatOnly;
    }
    emitRemoved(j);
  });
  return { changes, unchanged, formatOnly, addedSections, removedSections };
}

/** Đoạn bỏ ở chỗ này và xuất hiện y nguyên ở chỗ khác: chỉ là chuyển vị trí. */
function detectMoves(changes: DiffChange[]): DiffChange[] {
  const addedByKey = new Map<string, DiffChange>();
  for (const c of changes) if (c.kind === "added" && c.after && !c.wholeSection) addedByKey.set(normalizeLenient(c.after), c);
  const movedAdded = new Set<DiffChange>();
  const result: DiffChange[] = [];
  for (const c of changes) {
    if (c.kind === "removed" && c.before && !c.wholeSection) {
      const match = addedByKey.get(normalizeLenient(c.before));
      if (match && !movedAdded.has(match)) {
        movedAdded.add(match);
        const target = match.section && match.section !== c.section ? ` → sang mục **${escapeMd(match.section)}**` : "";
        result.push({ ...c, kind: "moved", after: c.before, rendered: `${c.rendered}${target}`, weight: 1 });
        continue;
      }
    }
    result.push(c);
  }
  return result.filter((c) => !movedAdded.has(c));
}

// ---------------- Đọc file + kết quả ----------------

/**
 * Toàn văn một tài liệu trong kho. Tài liệu Docuzen ("docuzen://<DocumentID>", index bằng ingest:docuzen) không
 * có bản sao trên đĩa: tải file của bản đang hiệu lực vào thư mục tạm, đọc xong xoá.
 */
export async function readFullText(filePath: string): Promise<string> {
  const documentId = docuzenDocumentId(filePath);
  if (documentId === null) return joinParts(await readFile(filePath, config.dataDir));

  const source = await currentSourceOf(documentId);
  if (!source) throw new Error(`Tài liệu Docuzen ${documentId} không còn bản hiện hành hoặc không có file đọc được`);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "docuzen-read-"));
  try {
    const ext = path.extname(source.sourcePath.replace(/\\/g, "/")).toLowerCase();
    const tmpPath = path.join(workDir, source.file.category, `doc${ext}`);
    await downloadDocuzenFile(source.sourcePath, tmpPath);
    return joinParts(await readFile(tmpPath, workDir));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

const joinParts = (docs: ParsedDocument[]) =>
  docs.map((d) => (d.metadata.sheetName ? `${d.metadata.sheetName}\n${d.text}` : d.text)).join("\n\n");

export async function diffDocuments(filePathA: string, filePathB: string): Promise<DiffResult> {
  const [textA, textB] = await Promise.all([readFullText(filePathA), readFullText(filePathB)]);
  return diffTexts(textA, path.basename(filePathA), textB, path.basename(filePathB));
}

/** So sánh hai bản chữ đã đọc sẵn (vd file người dùng upload, không nằm trong kho). */
export function diffTexts(textA: string, fileA: string, textB: string, fileB: string): DiffResult {
  const a = toParagraphs(textA);
  const b = toParagraphs(textB);
  const d = diffBlocks(toBlocks(a), toBlocks(b));
  const changes = detectMoves(d.changes);

  const counts = { added: 0, removed: 0, modified: 0, moved: 0 };
  const bySection: Record<string, number> = {};
  for (const c of changes) {
    counts[c.kind]++;
    bySection[c.section || PREAMBLE] = (bySection[c.section || PREAMBLE] ?? 0) + 1;
  }
  return {
    fileA,
    fileB,
    paragraphsA: a.length,
    paragraphsB: b.length,
    similarity: d.unchanged / Math.max(1, a.length, b.length),
    formatOnly: d.formatOnly,
    addedSections: d.addedSections,
    removedSections: d.removedSections,
    changes,
    counts,
    bySection,
  };
}

const KIND_LABEL: Record<DiffChange["kind"], string> = {
  added: "Thêm",
  removed: "Bỏ",
  modified: "Sửa",
  moved: "Chuyển vị trí",
};

/** Danh sách đầy đủ do server in, nhóm theo mục. */
export function renderDiffList(result: DiffResult): string {
  if (result.changes.length === 0) return "";
  const shown = result.changes.slice(0, MAX_LISTED_CHANGES);
  const lines = [`${DIFF_LIST_HEADING} (${shown.length}/${result.changes.length})**`];
  lines.push(
    "",
    `_A = ${stripExtension(result.fileA)} · B = ${stripExtension(result.fileB)}. Chữ ~~gạch ngang~~ là nội dung bị bỏ, chữ **in đậm** là nội dung mới._`
  );
  if (result.formatOnly > 0) {
    lines.push("", `_Không liệt kê ${result.formatOnly} đoạn chỉ khác về đánh số, dấu câu hoặc khoảng trắng._`);
  }
  let lastSection: string | null = null;
  for (const c of shown) {
    const section = c.section || PREAMBLE;
    if (section !== lastSection) {
      lines.push("", `**${escapeMd(section)}**`, "");
      lastSection = section;
    }
    lines.push(`- **${KIND_LABEL[c.kind]}**: ${c.rendered}`);
  }
  if (result.changes.length > shown.length) {
    lines.push("", `_Còn ${result.changes.length - shown.length} thay đổi nữa. Hỏi theo từng mục (ví dụ "khác nhau ở mục MaV-1") để xem tiếp._`);
  }
  return `\n\n${lines.join("\n")}`;
}

/** Số liệu + các thay đổi lớn nhất (vừa ngân sách) để AI viết đoạn tóm tắt. */
export function diffSummaryForAi(result: DiffResult, budgetChars: number): string {
  const top = [...result.changes].sort((x, y) => y.weight - x.weight);
  const picked: { loai: string; muc: string; truoc?: string; sau?: string }[] = [];
  let used = 0;
  for (const c of top) {
    const item = {
      loai: c.wholeSection ? `${KIND_LABEL[c.kind]} cả mục` : KIND_LABEL[c.kind],
      muc: c.section || PREAMBLE,
      ...(c.before && c.kind !== "added" ? { truoc: clip(c.before, 400) } : {}),
      ...(c.after && c.kind !== "removed" ? { sau: clip(c.after, 400) } : {}),
    };
    const size = JSON.stringify(item).length;
    if (used + size > budgetChars) break;
    picked.push(item);
    used += size;
  }
  const bySection = Object.entries(result.bySection)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 15);
  return JSON.stringify(
    {
      taiLieuA: stripExtension(result.fileA),
      taiLieuB: stripExtension(result.fileB),
      tongSoThayDoi: result.changes.length,
      tyLeDoanGiongNhau: `${Math.round(result.similarity * 100)}%`,
      theoLoai: { them: result.counts.added, bo: result.counts.removed, sua: result.counts.modified, chuyenViTri: result.counts.moved },
      doanChiKhacDinhDang: result.formatOnly,
      mucMoiChiCoOBanB: result.addedSections.slice(0, 30),
      mucBiBoChiCoOBanA: result.removedSections.slice(0, 30),
      mucCoNhieuThayDoiNhat: Object.fromEntries(bySection),
      cacThayDoiLonNhat: picked,
    },
    null,
    1
  );
}


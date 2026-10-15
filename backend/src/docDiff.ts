import path from "path";
import { diffArrays, diffWords } from "diff";
import { config } from "./config.js";
import { readFile } from "./fileReaders.js";
import { stripExtension } from "./fileCatalog.js";

/**
 * So sánh hai phiên bản tài liệu: tìm đủ các đoạn thêm, bỏ, sửa, chuyển vị trí.
 *
 * Code so toàn văn (không qua AI) để không sót thay đổi nào:
 *  1. đọc lại hai file gốc (không ghép từ các đoạn đã cắt, vì các đoạn chồng mép nhau);
 *  2. ghép các dòng bị ngắt (PDF xuống dòng theo khổ giấy) thành đoạn, để hai bản dàn trang khác nhau
 *     vẫn so được với nhau;
 *  3. so theo đoạn (thuật toán Myers, như git diff), rồi so từng từ trong các đoạn bị sửa;
 *  4. gắn mỗi thay đổi vào mục chứa nó.
 * Danh sách thay đổi do server in đầy đủ; AI chỉ nhận phần tóm tắt để viết đoạn mở đầu.
 */

export const DIFF_LIST_HEADING = "**Chi tiết các thay đổi";

const MAX_LISTED_CHANGES = 150;
const ITEM_CHARS = 320; // độ dài tối đa mỗi mục trong danh sách (giữ phần quanh chỗ đổi)
const CONTEXT_WORDS = 12; // số từ giữ lại trước / sau chỗ đổi trong đoạn sửa
// Hai đoạn bị thay cùng chỗ được coi là "sửa" (thay vì bỏ + thêm) khi giống nhau ít nhất mức này
const MODIFY_SIMILARITY = 0.45;

export interface DiffChange {
  kind: "added" | "removed" | "modified" | "moved";
  section: string;
  before?: string;
  after?: string;
  rendered: string; // markdown một dòng
  weight: number; // độ lớn thay đổi (số ký tự đổi), để chọn thay đổi quan trọng cho AI
}

export interface DiffResult {
  fileA: string;
  fileB: string;
  paragraphsA: number;
  paragraphsB: number;
  // Tỉ lệ đoạn giống y nguyên (trên bản dài hơn): thấp nghĩa là hai tài liệu khác nhau phần lớn,
  // có thể không phải hai phiên bản của cùng một tài liệu
  similarity: number;
  changes: DiffChange[];
  counts: Record<DiffChange["kind"], number>;
  bySection: Record<string, number>;
}

// ---------------- Tách đoạn ----------------

// Dòng bắt đầu một ý mới: đánh số, chữ cái, số La Mã, gạch đầu dòng, mã thay đổi (MaV-1, MiV-2)…
// Số phải có dấu chấm / ngoặc ("4.", "4)", "3.1"): dòng bị ngắt giữa câu có thể bắt đầu bằng con số ("4 tại khoản…")
const STARTS_ITEM =
  /^(?:\d+[.)]\s|\d+(?:\.\d+)+[.)]?\s|[A-ZĐ][.)]\s|[IVXLC]+[.)]\s|[a-zđ][.)]\s|\(\w{1,3}\)\s|[-•+*–]\s|Ma?V-?\d|Mi?V-?\d|Điều\s+\d|Chương\s+[IVXLC\d]|#)/u;
// Dòng gạch / chấm trang trí trong văn bản hành chính
const DECORATION = /[_.…·\-–=]{4,}/g;
const ENDS_SENTENCE = /[.:;!?…)]$/;
const PAGE_NUMBER = /^(?:trang\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?$/iu;

/**
 * Tiêu đề mục: dòng ngắn đánh số / La Mã / chữ cái ở đầu, "Chương I", "Điều 1.", hoặc toàn chữ in hoa.
 * Dòng đánh số dài là đoạn văn bị ngắt dòng ("1. Thông tư này quy định chi tiết…"), không phải tiêu đề.
 */
function isSectionHeading(line: string): boolean {
  const text = line.trim();
  if (text.length < 3 || text.length > 120) return false;
  if (/^#{1,6}\s/.test(text)) return true;
  if (/^(?:Chương\s+[IVXLC\d]+|Điều\s+\d+[a-zđ]?\.)/u.test(text) && text.length <= 90) return true;
  if (/^(?:[IVXLC]+|[A-ZĐ]|\d+(?:\.\d+)*)[.)]?\s+\S/u.test(text) && text.length <= 60 && !/[.;,:]$/.test(text)) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 6 && letters === letters.toUpperCase();
}

interface Paragraph {
  text: string; // để hiển thị
  key: string; // để so sánh (chuẩn hóa)
  section: string;
}

const normalizeKey = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

/** Ghép các dòng bị ngắt thành đoạn; bỏ số trang và các dòng lặp ở mọi trang (đầu / chân trang). */
function toParagraphs(rawText: string): Paragraph[] {
  const lines = rawText
    .replace(/^\[Tài liệu:[^\]]*\]\s*/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(DECORATION, " ").replace(/\s+/g, " ").trim());

  // Dòng xuất hiện rất nhiều lần (đầu trang, chân trang) không phải nội dung
  const freq = new Map<string, number>();
  for (const l of lines) if (l) freq.set(l, (freq.get(l) ?? 0) + 1);
  const repeated = (l: string) => l.length < 80 && (freq.get(l) ?? 0) >= 5;

  const paragraphs: Paragraph[] = [];
  let current = "";
  let section = "";
  const flush = () => {
    const text = current.trim();
    if (text) paragraphs.push({ text, key: normalizeKey(text), section });
    current = "";
  };

  for (const line of lines) {
    if (!line) {
      // dòng trống: hết đoạn nếu câu trước đã trọn
      if (ENDS_SENTENCE.test(current)) flush();
      continue;
    }
    if (PAGE_NUMBER.test(line) || repeated(line)) continue;
    // Dòng bảng (bảng trong file Word đọc ra dạng | ô | ô |): mỗi hàng là một đơn vị so sánh riêng
    if (line.startsWith("|")) {
      flush();
      if (!/^\|[\s:|-]+\|?$/.test(line)) paragraphs.push({ text: line, key: normalizeKey(line), section });
      continue;
    }
    if (isSectionHeading(line)) {
      flush();
      section = line.slice(0, 100);
      paragraphs.push({ text: line, key: normalizeKey(line), section });
      continue;
    }
    if (current && (STARTS_ITEM.test(line) || ENDS_SENTENCE.test(current))) flush();
    current = current ? `${current} ${line}` : line;
  }
  flush();
  return paragraphs;
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

/** Đoạn bị sửa: chỉ giữ phần quanh chỗ đổi, chữ bỏ gạch ngang, chữ thêm in đậm. */
function renderModification(before: string, after: string): { rendered: string; weight: number } {
  const parts = diffWords(before, after);
  let weight = 0;
  const pieces: string[] = [];
  parts.forEach((p, i) => {
    if (p.added || p.removed) {
      weight += p.value.trim().length;
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
  return { rendered: clip(pieces.filter(Boolean).join(" "), ITEM_CHARS * 2), weight };
}

function diffParagraphs(a: Paragraph[], b: Paragraph[]): { changes: DiffChange[]; unchanged: number } {
  const hunks = diffArrays(a.map((p) => p.key), b.map((p) => p.key));
  const changes: DiffChange[] = [];
  let ia = 0;
  let ib = 0;
  let unchanged = 0;

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];
    const n = hunk.count ?? hunk.value.length;
    if (!hunk.added && !hunk.removed) {
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
        if (weight > 0) changes.push({ kind: "modified", section: ad.section || r.section, before: r.text, after: ad.text, rendered, weight });
      } else {
        changes.push({ kind: "removed", section: r.section, before: r.text, rendered: `“${escapeMd(clip(r.text))}”`, weight: r.text.length });
      }
    }
    added.forEach((ad, k) => {
      if (usedAdded.has(k)) return;
      changes.push({ kind: "added", section: ad.section, after: ad.text, rendered: `“${escapeMd(clip(ad.text))}”`, weight: ad.text.length });
    });
  }

  // Đoạn bỏ ở chỗ này và xuất hiện y nguyên ở chỗ khác: chỉ là chuyển vị trí
  const addedKeys = new Map<string, DiffChange>();
  for (const c of changes) if (c.kind === "added" && c.after) addedKeys.set(normalizeKey(c.after), c);
  const result: DiffChange[] = [];
  const movedAdded = new Set<DiffChange>();
  for (const c of changes) {
    if (c.kind === "removed" && c.before) {
      const match = addedKeys.get(normalizeKey(c.before));
      if (match && !movedAdded.has(match)) {
        movedAdded.add(match);
        // Giữ ở mục cũ (nơi đoạn bị bỏ đi), ghi rõ chuyển sang mục nào
        const target = match.section && match.section !== c.section ? ` → sang mục **${escapeMd(match.section)}**` : "";
        result.push({ ...c, kind: "moved", after: c.before, rendered: `${c.rendered}${target}`, weight: 1 });
        continue;
      }
    }
    result.push(c);
  }
  return { changes: result.filter((c) => !movedAdded.has(c)), unchanged };
}

// ---------------- Đọc file + kết quả ----------------

async function readFullText(filePath: string): Promise<string> {
  const docs = await readFile(filePath, config.dataDir);
  return docs.map((d) => (d.metadata.sheetName ? `${d.metadata.sheetName}\n${d.text}` : d.text)).join("\n\n");
}

export async function diffDocuments(filePathA: string, filePathB: string): Promise<DiffResult> {
  const [textA, textB] = await Promise.all([readFullText(filePathA), readFullText(filePathB)]);
  const a = toParagraphs(textA);
  const b = toParagraphs(textB);
  const { changes, unchanged } = diffParagraphs(a, b);

  const counts = { added: 0, removed: 0, modified: 0, moved: 0 };
  const bySection: Record<string, number> = {};
  for (const c of changes) {
    counts[c.kind]++;
    const key = c.section || "(phần đầu tài liệu)";
    bySection[key] = (bySection[key] ?? 0) + 1;
  }
  return {
    fileA: path.basename(filePathA),
    fileB: path.basename(filePathB),
    paragraphsA: a.length,
    paragraphsB: b.length,
    similarity: unchanged / Math.max(1, a.length, b.length),
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
  lines.push("", `_A = ${stripExtension(result.fileA)} · B = ${stripExtension(result.fileB)}. Chữ ~~gạch ngang~~ là nội dung bị bỏ, chữ **in đậm** là nội dung mới._`);
  let lastSection: string | null = null;
  for (const c of shown) {
    const section = c.section || "(phần đầu tài liệu)";
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
      loai: KIND_LABEL[c.kind],
      muc: c.section || "(phần đầu tài liệu)",
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
      mucCoNhieuThayDoiNhat: Object.fromEntries(bySection),
      cacThayDoiLonNhat: picked,
    },
    null,
    1
  );
}

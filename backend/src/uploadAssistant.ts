import { config } from "./config.js";
import { fileMatchesCode, fold, parseDocCodes, parseFileCode, sopLabel, type DocCode } from "./docCode.js";
import { diffSummaryForAi, diffTexts, readFullText, renderDiffList, type DiffResult } from "./docDiff.js";
import { getIndexedFiles, isMainDocument } from "./fileCatalog.js";
import { buildDiffIntroPrompt, buildUploadQaPrompt, buildUploadRepoMatchPrompt, type UploadExcerpt } from "./llmService.js";
import { searchSimilar, type IndexedFile } from "./qdrantService.js";
import { searchUpload, uploadChunks, uploadIdleMinutes, uploadSections, type UploadedDoc } from "./uploadStore.js";

/**
 * Câu hỏi kèm file upload:
 *   - so sánh: file với SOP trong kho (bản nháp sửa đổi khác bản hiện hành chỗ nào), hoặc 2 file với nhau;
 *   - đối chiếu với kho: nội dung file đã có / trùng với SOP nào;
 *   - còn lại: hỏi về nội dung file (đoạn nào nói về ..., tóm tắt ...).
 */

export interface UploadReply {
  prompt: string;
  maxTokens: number;
  list: { markdown: string; fallbackIntro: string } | null;
  fixedText?: string;
  sources: { fileName: string; category: string; score: number }[];
  log: Record<string, unknown>; // chỉ số liệu, không có nội dung file
}

const UPLOAD_CATEGORY = "Tải lên";
// File ngắn hơn mức này thì đưa nguyên file vào prompt; dài hơn thì chỉ lấy các đoạn giống câu hỏi nhất
const WHOLE_FILE_MAX_CHARS = 10000;
const QA_EXCERPTS = 8;
const QA_MAX_TOKENS = 2048;
const DIFF_MAX_TOKENS = 1500;
// Đối chiếu với kho: số đoạn của file đem đi tìm, số SOP và số cặp đoạn đưa vào prompt
const MATCH_MAX_CHUNKS = 40;
const MATCH_TOP_FILES = 5;
const MATCH_PAIRS_PER_FILE = 3;
const MATCH_EXCERPT_CHARS = 400;

const WORD_START = "(?<![a-z0-9])";
const WORD_END = "(?![a-z0-9])";
const words = (alternation: string) => new RegExp(`${WORD_START}(?:${alternation})${WORD_END}`);

// Chạy trên câu đã fold(): chữ thường, không dấu
const FILE_WORDS = words("file|tep|tai lieu nay|van ban nay|ban nay|dinh kem|upload|tai len|ban nhap|draft|attached?");
const COMPARE_WORDS = words(
  "so sanh|doi chieu|khac (?:nhau|gi|cho nao|o dau|biet|the nao)|khac voi|diem khac|thay doi|sua doi|sua (?:gi|nhung gi|cho nao)|diem moi|them (?:gi|nhung gi)|bo (?:gi|nhung gi)|compare|diff|differences?|changes?"
);
const REPO_MATCH_WORDS = words(
  "trung|da co trong|co trong kho|giong (?:sop|tai lieu|quy trinh) nao|(?:sop|tai lieu|quy trinh) nao (?:da )?(?:co|noi|quy dinh|trung|giong)|lien quan (?:den|toi) (?:sop|tai lieu|quy trinh) nao"
);

// Hỏi tóm tắt / tổng quan cả file (không có chủ đề cụ thể để tìm đoạn giống)
const SUMMARY_WORDS = words(
  "tom tat|tom luoc|tong quan|noi dung chinh|y chinh|cac y chinh|noi dung (?:file|tai lieu|van ban)|noi ve (?:gi|cai gi|van de gi)|gioi thieu|summary|summari[sz]e|overview|main points"
);

/** Câu hỏi nhắc rõ tới file đã upload ("file này", "bản nháp", "tài liệu đính kèm"...). */
export function refersToFile(query: string): boolean {
  return FILE_WORDS.test(fold(query));
}

export function expiredUploadText(): string {
  return `File bạn tải lên đã hết hạn (không dùng quá ${uploadIdleMinutes} phút, hoặc server vừa khởi động lại) nên tôi không còn nội dung để trả lời. Bạn tải lại file rồi hỏi lại nhé.`;
}

const uploadSources = (docs: UploadedDoc[]) => docs.map((d) => ({ fileName: d.fileName, category: UPLOAD_CATEGORY, score: 1 }));

export async function uploadReplyFor(query: string, docs: UploadedDoc[]): Promise<UploadReply> {
  const text = fold(query);
  if (COMPARE_WORDS.test(text) && !REPO_MATCH_WORDS.test(text)) return compareReply(query, docs);
  if (REPO_MATCH_WORDS.test(text)) return repoMatchReply(docs[0]);
  return qaReply(query, docs);
}

// ---------- So sánh ----------

function diffReply(result: DiffResult, sources: UploadReply["sources"], what: string): UploadReply {
  return {
    prompt: buildDiffIntroPrompt(diffSummaryForAi(result, config.overlapPromptBudgetChars)),
    maxTokens: DIFF_MAX_TOKENS,
    list: {
      markdown: renderDiffList(result),
      fallbackIntro:
        result.changes.length > 0
          ? `So sánh ${what}: tìm thấy **${result.changes.length}** thay đổi.`
          : `${what}: nội dung giống nhau, không tìm thấy khác biệt.`,
    },
    sources,
    log: { mode: "compare", changes: result.changes.length, counts: result.counts },
  };
}

/** Mã SOP để so: mã nêu trong câu hỏi, không có thì lấy từ tên file, rồi từ phần đầu nội dung file. */
function targetCode(query: string, doc: UploadedDoc): DocCode | null {
  const fromQuery = parseDocCodes(query)[0];
  if (fromQuery) return fromQuery;
  // Chỉ tin mã trong tên file khi có phòng ban ("FRM-QA-SOP-GEN-0005..."), không phải số bất kỳ ("DIFF-9001")
  if (doc.code?.department) {
    return { department: doc.code.department, series: doc.code.series, number: doc.code.number, sub: doc.code.sub, typeCode: null, span: [0, 0] };
  }
  return parseDocCodes(doc.text.slice(0, 3000))[0] ?? null;
}

/** File trong kho để so: đúng mã (cả biểu mẫu / phụ lục nếu mã có F/A), ưu tiên cùng định dạng với file tải lên. */
function repoFileFor(code: DocCode, upload: UploadedDoc, files: IndexedFile[]): IndexedFile | null {
  const sameDoc = files.filter((f) => {
    const fc = parseFileCode(f.fileName);
    if (!fc || !fileMatchesCode(fc, f.category, code)) return false;
    if (!code.sub) return isMainDocument(f.fileName);
    return fc.sub?.kind === code.sub.kind && Number(fc.sub.number) === Number(code.sub.number);
  });
  const ext = (name: string) => name.toLowerCase().split(".").pop();
  return sameDoc.find((f) => ext(f.fileName) === ext(upload.fileName)) ?? sameDoc[0] ?? null;
}

async function compareReply(query: string, docs: UploadedDoc[]): Promise<UploadReply> {
  // Hai file cùng tải lên: file thứ nhất là bản A, file thứ hai là bản B
  if (docs.length >= 2) {
    const [a, b] = docs;
    const result = diffTexts(a.text, a.fileName, b.text, b.fileName);
    return diffReply(result, uploadSources([a, b]), `**${a.fileName}** (A) và **${b.fileName}** (B)`);
  }

  const upload = docs[0];
  const code = targetCode(query, upload);
  if (!code) {
    return {
      prompt: "",
      maxTokens: 0,
      list: null,
      fixedText: `Tôi chưa biết so file **${upload.fileName}** với SOP nào trong kho. Bạn ghi rõ mã giúp tôi, ví dụ "so sánh file này với sop qa 5", hoặc tải lên thêm file thứ hai để so hai file với nhau.`,
      sources: uploadSources(docs),
      log: { mode: "compare", target: null },
    };
  }

  let repoFiles: IndexedFile[];
  try {
    repoFiles = await getIndexedFiles();
  } catch (err) {
    console.warn("Không đọc được danh mục kho để so sánh:", (err as Error).message);
    return {
      prompt: "",
      maxTokens: 0,
      list: null,
      fixedText: "Hiện không đọc được danh mục kho tài liệu nên chưa so được với SOP trong kho. Bạn thử lại sau, hoặc tải lên cả hai bản để so trực tiếp.",
      sources: uploadSources(docs),
      log: { mode: "compare", target: sopLabel(code), catalogError: true },
    };
  }
  const repoFile = repoFileFor(code, upload, repoFiles);
  if (!repoFile) {
    return {
      prompt: "",
      maxTokens: 0,
      list: null,
      fixedText: `Kho tài liệu chưa có ${sopLabel(code)} để so với file **${upload.fileName}**. Bạn kiểm tra lại mã, hoặc tải lên bản cần so cùng lúc.`,
      sources: uploadSources(docs),
      log: { mode: "compare", target: sopLabel(code), found: false },
    };
  }

  // Bản trong kho là A (hiện hành), file tải lên là B (bản mới / bản nháp)
  const result = diffTexts(await readFullText(repoFile.filePath), repoFile.fileName, upload.text, upload.fileName);
  return diffReply(
    result,
    [{ fileName: repoFile.fileName, category: repoFile.category, score: 1 }, ...uploadSources(docs)],
    `**${repoFile.fileName}** (A, bản trong kho) và **${upload.fileName}** (B, file tải lên)`
  );
}

// ---------- Đối chiếu với kho ----------

async function repoMatchReply(doc: UploadedDoc): Promise<UploadReply> {
  const chunks = (await uploadChunks(doc)).slice(0, MATCH_MAX_CHUNKS);
  // Mỗi đoạn của file → đoạn giống nhất trong kho (chỉ đọc Qdrant)
  const best = await Promise.all(
    chunks.map(async (chunk) => ({ chunk, match: (await searchSimilar(chunk.vector, 1))[0] }))
  );
  const byFile = new Map<string, { fileName: string; category: string; pairs: typeof best }>();
  for (const pair of best) {
    if (!pair.match) continue;
    const entry = byFile.get(pair.match.filePath) ?? { fileName: pair.match.fileName, category: pair.match.category, pairs: [] };
    entry.pairs.push(pair);
    byFile.set(pair.match.filePath, entry);
  }
  const top = [...byFile.values()]
    .sort((a, b) => b.pairs.length - a.pairs.length || b.pairs[0].match!.score - a.pairs[0].match!.score)
    .slice(0, MATCH_TOP_FILES);

  const cut = (s: string) => (s.length > MATCH_EXCERPT_CHARS ? `${s.slice(0, MATCH_EXCERPT_CHARS)}…` : s);
  const pairsText = top
    .map((f, i) => {
      const pairs = [...f.pairs].sort((a, b) => b.match!.score - a.match!.score).slice(0, MATCH_PAIRS_PER_FILE);
      return [
        `### ${i + 1}. ${f.fileName} (phòng ${f.category}) - ${f.pairs.length}/${chunks.length} đoạn của file giống SOP này nhất`,
        ...pairs.map(
          (p) =>
            `- File tải lên${p.chunk.section ? ` (mục ${p.chunk.section})` : ""}: "${cut(p.chunk.text)}"\n  SOP${p.match!.section ? ` (mục ${p.match!.section})` : ""}: "${cut(p.match!.text)}"`
        ),
      ].join("\n");
    })
    .join("\n\n");

  return {
    prompt: buildUploadRepoMatchPrompt(doc.fileName, pairsText || "(không tìm được đoạn nào)"),
    maxTokens: QA_MAX_TOKENS,
    list: null,
    sources: [...uploadSources([doc]), ...top.map((f) => ({ fileName: f.fileName, category: f.category, score: 1 }))],
    log: { mode: "repo_match", chunks: chunks.length, topFiles: top.map((f) => [f.fileName, f.pairs.length]) },
  };
}

// ---------- Hỏi về nội dung file ----------

/**
 * Câu tóm tắt / tổng quan file dài: không có chủ đề để so nên lấy đoạn theo độ giống câu hỏi gần như ngẫu nhiên.
 * Thay vào đó lấy đoạn đầu mỗi mục (khung của file), thiếu thì bổ sung đoạn rải đều; giữ thứ tự trong file.
 */
function spreadIndices(sections: string[], count: number): number[] {
  const starts = sections.map((s, i) => i).filter((i) => i === 0 || sections[i] !== sections[i - 1]);
  const evenly = (pool: number[], n: number) =>
    n >= pool.length ? pool : Array.from({ length: n }, (_, k) => pool[Math.floor((k * pool.length) / n)]);
  const picked = new Set(evenly(starts, count));
  const rest = sections.map((_, i) => i).filter((i) => !picked.has(i));
  for (const i of evenly(rest, count - picked.size)) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

const MAX_OUTLINE_LINES = 60;

async function qaReply(query: string, docs: UploadedDoc[]): Promise<UploadReply> {
  const totalChars = docs.reduce((sum, d) => sum + d.text.length, 0);
  const wholeFile = totalChars <= WHOLE_FILE_MAX_CHARS;
  let excerpts: UploadExcerpt[];
  if (wholeFile) {
    excerpts = docs.map((d) => ({ fileName: d.fileName, section: "", text: d.text }));
  } else if (SUMMARY_WORDS.test(fold(query))) {
    const perDoc = Math.max(3, Math.floor(QA_EXCERPTS / docs.length));
    const outline: string[] = [];
    excerpts = docs.flatMap((d) => {
      const pieces = uploadSections(d);
      const sections = pieces.map((p) => p.section);
      const headings = sections.filter((s, i) => s && s !== sections[i - 1]);
      outline.push(...(docs.length > 1 ? [`${d.fileName}:`] : []), ...headings.map((h) => `- ${h}`));
      return spreadIndices(sections, perDoc).map((i) => ({ fileName: d.fileName, section: pieces[i].section, text: pieces[i].text }));
    });
    return {
      prompt: buildUploadQaPrompt(excerpts, "spread", outline.slice(0, MAX_OUTLINE_LINES).join("\n")),
      maxTokens: QA_MAX_TOKENS,
      list: null,
      sources: uploadSources(docs),
      log: { mode: "summary_spread", excerpts: excerpts.length, outlineLines: outline.length },
    };
  } else {
    const perDoc = Math.max(3, Math.ceil(QA_EXCERPTS / docs.length));
    const found = await Promise.all(docs.map(async (d) => (await searchUpload(d, query, perDoc)).map((c) => ({ d, c }))));
    excerpts = found
      .flat()
      .sort((x, y) => y.c.score - x.c.score)
      .slice(0, QA_EXCERPTS)
      .map(({ d, c }) => ({ fileName: d.fileName, section: c.section, text: c.text }));
  }
  return {
    prompt: buildUploadQaPrompt(excerpts, wholeFile ? "whole" : "relevant"),
    maxTokens: QA_MAX_TOKENS,
    list: null,
    sources: uploadSources(docs),
    log: { mode: "qa", wholeFile, excerpts: excerpts.length },
  };
}

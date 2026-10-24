/**
 * Chuẩn hoá mã tài liệu: mọi cách viết của cùng một mã về một dạng duy nhất.
 *
 * Người dùng viết rất khác nhau: "sop qa 13", "sopqa13", "SOP-QA-0013", "qa sop 13", "sop 13 của qa",
 * "FRM/IT/SOP-GEN/0013-F01". Tên file thì dùng "-" hoặc "." thay cho "/" (tên file không được có "/"):
 * "FRM-QA-SOP-GEN-0005-F17-02 SELF INSPECTION CHECKLIST.docx", "FRM.QA.SOP-GEN.0005-A03-01 ...".
 * Cả hai phía đều đưa về {phòng, nhóm, số 4 chữ số, biểu mẫu / phụ lục} rồi so sánh.
 */

// Như stripExtension trong fileCatalog.ts (không import để tránh vòng phụ thuộc)
const stripExtension = (fileName: string) => fileName.replace(/\.(docx?|pdf|xlsx?|txt|md)$/i, "");

export interface DocCode {
  department: string | null; // "QA"; null nếu không nêu
  series: string | null; // nhóm sau "SOP-": "GEN", "CAL"; null nếu không nêu
  number: string; // luôn 4 chữ số: "13" → "0013"
  sub: { kind: "form" | "appendix"; number: string } | null; // -F02 → form "02"
  // Loại tài liệu khác SOP, khi mã ghi rõ: "SPE-FCT" (FRM/QC/SPE-FCT/0008), "L" (FRM/PD/L/0001), "APQR". SOP → null
  typeCode: string | null;
  span: [number, number]; // vị trí trong chuỗi đã fold() (để bỏ phần mã khi tìm phòng ban nhắc riêng)
}

/** Chữ thường, bỏ dấu tiếng Việt ("Quy trình" → "quy trinh"): người dùng hay gõ không dấu. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/** Mã phòng ban có thể gặp trong mã tài liệu. */
export const DEPARTMENT_CODES = ["qa", "qc", "pd", "wh", "me", "it", "hr", "ra", "fd", "ad", "ds", "pu", "ts", "prd"];

const SEP = "[\\s./_-]*";
// Số tài liệu Docuzen: các phần phải có dấu ngăn cách, để "APQR" không bị cắt thành "APQ" + "R"
const SEP1 = "[\\s./_-]+";
const B = "(?<![a-z0-9])"; // đầu từ
const DEPT = `(${DEPARTMENT_CODES.join("|")})(?![a-z])`;
const SOP = "(?:sop|quy trinh|qt)";
const NUM = "(\\d{1,4})(?!\\d)";
// Ký hiệu biểu mẫu / phụ lục dính liền sau số: "0013-F02", "13 f2", "0005.A03"
const SUB = `(?:${SEP}([fa])(\\d{1,3})(?!\\d))?`;
// Nhóm SOP ("SOP-GEN 0005"): 3 chữ, trừ vài từ thường gặp đứng sau "sop"
const SERIES = "(?!cua|cho|nao|moi|gom|the|nay|kia)([a-z]{3})(?![a-z])";

interface Pattern {
  re: RegExp;
  pick: (m: RegExpExecArray) => Omit<DocCode, "span">;
}

const sub = (kind?: string, n?: string) =>
  kind && n ? { kind: kind === "f" ? ("form" as const) : ("appendix" as const), number: n.padStart(2, "0") } : null;
const pad = (n: string) => n.padStart(4, "0");
const upper = (s?: string) => (s ? s.toUpperCase() : null);
// Mã tài liệu của phòng PD ghi "PRD" (FRM.PRD.SOP-MFG.0005): coi là một
const dept = (s?: string) => (s === "prd" ? "PD" : upper(s));

// Thứ tự = ưu tiên khi hai cách đọc chồng lên nhau (mã đầy đủ trước)
const PATTERNS: Pattern[] = [
  // FRM/IT/SOP-GEN/0013-F01, FRM.QA.SOP-GEN.0005-A03-01, frm qa sop 13
  {
    re: new RegExp(`${B}frm${SEP}([a-z]{2,4})${SEP}sop(?:${SEP}([a-z]{2,4}))?${SEP}${NUM}${SUB}`, "g"),
    pick: (m) => ({ department: dept(m[1]), series: upper(m[2]), number: pad(m[3]), sub: sub(m[4], m[5]), typeCode: null }),
  },
  // Số tài liệu Docuzen loại khác SOP: FRM/QC/SPE-FCT/0008, FRM/QA/EQP-PQP/0008/F01, FRM/QC/RQP/0006/F02, FRM/PD/L/0001
  {
    re: new RegExp(`${B}frm${SEP1}([a-z]{2,7})${SEP1}(?!sop(?![a-z]))([a-z]{1,6}(?:[._-][a-z]{2,4})?)${SEP1}${NUM}${SUB}`, "g"),
    pick: (m) => {
      const isDepartment = DEPARTMENT_CODES.includes(m[1]);
      return {
        department: isDepartment ? dept(m[1]) : null,
        series: null,
        number: pad(m[3]),
        sub: sub(m[4], m[5]),
        typeCode: (isDepartment ? m[2] : `${m[1]}-${m[2]}`).replace(/[._]/g, "-").toUpperCase(),
      };
    },
  },
  // Loại tài liệu ghi kèm năm, không có phòng: FRM/APQR/2026/0024/A03
  {
    re: new RegExp(`${B}frm${SEP1}([a-z]{2,6})${SEP1}(?:19|20)\\d{2}${SEP1}${NUM}${SUB}`, "g"),
    pick: (m) => ({ department: null, series: null, number: pad(m[2]), sub: sub(m[3], m[4]), typeCode: m[1].toUpperCase() }),
  },
  // list pd 1, list PD 0001
  {
    re: new RegExp(`${B}list${SEP}${DEPT}${SEP}${NUM}`, "g"),
    pick: (m) => ({ department: dept(m[1]), series: null, number: pad(m[2]), sub: null, typeCode: "L" }),
  },
  // qa sop 13, QA-SOP-0013
  {
    re: new RegExp(`${B}${DEPT}${SEP}${SOP}${SEP}${NUM}${SUB}`, "g"),
    pick: (m) => ({ department: dept(m[1]), series: null, number: pad(m[2]), sub: sub(m[3], m[4]), typeCode: null }),
  },
  // sop qa 13, sopqa13, SOP-QA-0013, quy trình QA 0005
  {
    re: new RegExp(`${B}${SOP}${SEP}${DEPT}${SEP}${NUM}${SUB}`, "g"),
    pick: (m) => ({ department: dept(m[1]), series: null, number: pad(m[2]), sub: sub(m[3], m[4]), typeCode: null }),
  },
  // sop 13, SOP-GEN 0005 QA, sop 13 của qa, SOP 1012 IT, sop 13 phòng qa
  {
    re: new RegExp(
      `${B}${SOP}(?:${SEP}${SERIES})?${SEP}${NUM}${SUB}(?:\\s+(?:cua\\s+)?(?:phong\\s+|ben\\s+|bo phan\\s+)?${DEPT})?`,
      "g"
    ),
    pick: (m) => ({ department: dept(m[5]), series: upper(m[1]), number: pad(m[2]), sub: sub(m[3], m[4]), typeCode: null }),
  },
];

/**
 * "ds sop" = danh sách, "sl sop" = số lượng, "f" đứng riêng cạnh "sop"/mã = biểu mẫu.
 * Trả về câu đã fold() và thay các chữ viết tắt.
 */
export function expandAbbreviations(query: string): string {
  const TYPE_AFTER = "(?=\\s+(?:cac\\s+|nhung\\s+)?(?:sop|quy trinh|qt|bieu mau|form|phu luc|tai lieu|f)(?![a-z0-9]))";
  return fold(query.normalize("NFC"))
    .replace(new RegExp(`${B}ds${TYPE_AFTER}`, "g"), "danh sach")
    .replace(new RegExp(`${B}sl(?![a-z0-9])`, "g"), "so luong")
    // "f sop qa 13", "f sopqa13", "f qa sop 13", "f của FRM/..."
    .replace(new RegExp(`(?<![a-z0-9./-])f(?=\\s+(?:cua\\s+)?(?:(?:${DEPARTMENT_CODES.join("|")})${SEP})?(?:sop|quy trinh|qt|frm))`, "g"), "bieu mau")
    .replace(/(?<=\d\s+)f(?![a-z0-9./-])/g, "bieu mau");
}

/** Các mã tài liệu trong câu hỏi, theo thứ tự xuất hiện (không trùng). */
export function parseDocCodes(query: string): DocCode[] {
  const text = expandAbbreviations(query);
  const found: DocCode[] = [];
  for (const { re, pick } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (found.some((c) => span[0] < c.span[1] && c.span[0] < span[1])) continue;
      found.push({ ...pick(m), span });
    }
  }
  const unique = new Map<string, DocCode>();
  for (const code of found.sort((a, b) => a.span[0] - b.span[0])) {
    const key = codeKey(code);
    if (!unique.has(key)) unique.set(key, code);
  }
  return [...unique.values()];
}

/** Câu hỏi đã fold(), bỏ phần mã tài liệu: để tìm phòng ban được nhắc RIÊNG ("biểu mẫu sop IT 13 của phòng QA"). */
export function textWithoutCodes(query: string, codes: DocCode[]): string {
  let text = expandAbbreviations(query);
  for (const { span } of [...codes].sort((a, b) => b.span[0] - a.span[0])) {
    text = `${text.slice(0, span[0])} ${text.slice(span[1])}`;
  }
  return text;
}

export const codeKey = (c: Pick<DocCode, "department" | "series" | "number" | "sub"> & { typeCode?: string | null }) =>
  [c.typeCode ?? "", c.department ?? "", c.series ?? "", c.number, c.sub ? `${c.sub.kind[0]}${c.sub.number}` : ""].join("|");

/** "SOP QA 0013", "SOP QA GEN 0013"; loại khác: "SPE-FCT QC 0008", "List PD 0001", "APQR 0024" */
export function sopLabel(c: Pick<DocCode, "department" | "series" | "number"> & { typeCode?: string | null }): string {
  const type = c.typeCode ? (c.typeCode === "L" ? "List" : c.typeCode) : "SOP";
  return [type, c.department, c.typeCode ? null : c.series, c.number].filter(Boolean).join(" ");
}

export interface FileCode {
  department: string | null;
  series: string | null;
  number: string;
  sub: DocCode["sub"];
  code: string; // phần mã trong tên file như đang viết: "FRM-QA-SOP-GEN-0005-F17-02"
  title: string; // phần tên sau mã: "SELF INSPECTION CHECKLIST"
}

const fileCodeCache = new Map<string, FileCode | null>();

/**
 * Đọc mã trong tên file. Phần mã = cụm không có khoảng trắng chứa số tài liệu (3-4 chữ số):
 * "FRM.QA.SOP-GEN.0005-F11-03 SELF INSPECTION CHECKLIST.docx" → QA / GEN / 0005 / F11.
 * Số sau ký hiệu F/A, hoặc ngay sau số tài liệu ("0005-03"), là số phiên bản trong tên file: bỏ qua.
 */
export function parseFileCode(fileName: string): FileCode | null {
  const cached = fileCodeCache.get(fileName);
  if (cached !== undefined) return cached;

  const name = stripExtension(fileName).normalize("NFC").trim();
  const segments = name.split(/\s+/);
  const at = segments.findIndex((s) => /(?<!\d)\d{3,4}(?!\d)/.test(s));
  let result: FileCode | null = null;
  if (at >= 0) {
    const tokens = fold(segments[at]).match(/[a-z]+|\d+/g) ?? [];
    const numberAt = tokens.findIndex((t) => /^\d{3,4}$/.test(t));
    const before = tokens.slice(0, numberAt);
    const frm = before.indexOf("frm");
    const sopAt = before.indexOf("sop");
    const department =
      frm >= 0 && /^[a-z]{2,4}$/.test(before[frm + 1] ?? "") && before[frm + 1] !== "sop"
        ? before[frm + 1]
        : (before.find((t) => DEPARTMENT_CODES.includes(t)) ?? null);
    const series = sopAt >= 0 && /^[a-z]{2,4}$/.test(before[sopAt + 1] ?? "") ? before[sopAt + 1] : null;
    const [mark, subNumber] = [tokens[numberAt + 1], tokens[numberAt + 2]];
    result = {
      department: dept(department ?? undefined),
      series: upper(series ?? undefined),
      number: tokens[numberAt],
      sub: /^[fa]$/.test(mark ?? "") && /^\d{1,3}$/.test(subNumber ?? "") ? sub(mark, subNumber) : null,
      code: segments.slice(0, at + 1).join(" "),
      title: segments.slice(at + 1).join(" ").replace(/^[-–:\s]+/, ""),
    };
  }
  fileCodeCache.set(fileName, result);
  return result;
}

/**
 * File có thuộc mã người dùng hỏi không. Phòng ban: lấy trong mã tên file, tên file không có thì lấy thư mục.
 * Không so ký hiệu F/A: hỏi "sop qa 13" thì mọi biểu mẫu, phụ lục của SOP đó đều thuộc.
 */
export function fileMatchesCode(fileCode: FileCode, category: string, code: DocCode): boolean {
  if (fileCode.number !== code.number) return false;
  if (code.series && fileCode.series && fileCode.series !== code.series) return false;
  // Mã loại khác SOP ("FRM/QC/SPE-FCT/0008"): phần mã trong tên file phải có đúng loại đó
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (code.typeCode && !compact(fileCode.code).includes(compact(code.typeCode))) return false;
  // Mã SOP ("sop qa 13") không khớp tài liệu loại khác cùng số (vd EQP-PQP 0013)
  if (!code.typeCode && fileCode.series === null && /frm/i.test(fileCode.code) && !/sop/i.test(fileCode.code)) return false;
  if (!code.department) return true;
  const fileDepartment = fileCode.department ?? category.toUpperCase();
  return fileDepartment === code.department;
}

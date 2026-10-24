import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";
import { getQualzenPool } from "./qualzenDb.js";
import type { DocuzenMeta, IndexedFile } from "./qdrantService.js";
import { parseFileCode } from "./docCode.js";

/**
 * Danh mục tài liệu chính thức từ Docuzen (schema DMS trong database QualZen): mỗi tài liệu lấy đúng
 * phiên bản đang hiệu lực (DocVersion.Status = 'A'). Dùng cho đếm / liệt kê / tra mã / tra ngược /
 * phiên bản / ngày hiệu lực thay cho đoán từ tên file. Khảo sát cấu trúc: npm run docuzen:explore.
 *
 * Trả về dạng IndexedFile (kèm `docuzen`) để dùng chung code đếm / liệt kê với danh mục theo tên file.
 * Phiên bản: Status A = hiệu lực, I = bản cũ / đã thu hồi, P = đang soạn / duyệt, R = chưa rõ (không lấy).
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
export const DOCUZEN_PATH_PREFIX = "docuzen://";

// Mã loại trong DMS.AizantIT_DocumentType → nhóm. SOP = mọi loại "SOP-..." (GEN, OPC, CAL, PPM, GTP, MIC, CHP)
function groupOf(typeId: number, typeCode: string): DocuzenMeta["group"] {
  if (typeId === 1) return "form"; // Formats
  if (typeId === 2) return "appendix"; // Annexures
  if (/^SOP-/i.test(typeCode)) return "sop";
  if (typeCode.toUpperCase() === "L") return "list";
  return "other";
}

/**
 * Số tài liệu → số thứ tự + ký hiệu biểu mẫu / phụ lục:
 * "FRM/QA/SOP-GEN/0005" → 0005; "FRM/QC/RQP/0006/F02" → 0006 + F02; "FRM/APQR/2026/0024/A03" → 0024 + A03 (bỏ năm).
 */
export function parseDocuzenNumber(number: string): { serial: string | null; sub: DocuzenMeta["sub"] } {
  const parts = number.trim().split(/[/\\]/).filter(Boolean);
  let sub: DocuzenMeta["sub"] = null;
  const last = parts[parts.length - 1] ?? "";
  const subMatch = last.match(/^([FA])[-_.]?(\d{1,3})$/i);
  if (subMatch) {
    sub = { kind: subMatch[1].toUpperCase() === "F" ? "form" : "appendix", number: subMatch[2].padStart(2, "0") };
    parts.pop();
  }
  const serial = [...parts].reverse().find((p) => /^\d{3,4}$/.test(p)) ?? null;
  return { serial: serial ? serial.padStart(4, "0") : null, sub };
}

const isoDate = (value: unknown) => (value instanceof Date && !isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null);

/**
 * Tên hiển thị dạng tên file ("FRM-QA-SOP-GEN-0005-10 SELF INSPECTION"): các phần đọc mã từ tên file
 * (tra theo mã, so sánh...) dùng được ngay. "/" trong tên không hợp lệ cho tên file nên đổi thành "-".
 */
export function docuzenFileName(meta: Pick<DocuzenMeta, "number" | "version" | "title">): string {
  const code = meta.number.trim().replace(/[/\\]+/g, "-");
  const title = meta.title.replace(/[/\\]+/g, "-").replace(/\s+/g, " ").trim();
  return `${code}-${String(meta.version).padStart(2, "0")}${title ? ` ${title}` : ""}`;
}

export interface DocuzenRow {
  DocumentID: number;
  DocumentNumber: string;
  DeptCode: string | null;
  DocumentTypeID: number | null;
  TypeCode: string | null;
  LinkedDocumentID: number | null;
  VersionID: number;
  VersionNumber: number;
  EffectiveDate: Date | null;
  ExpirationDate: Date | null;
  Title: string | null;
}

/** Dòng truy vấn → IndexedFile kèm thông tin Docuzen (tách riêng để thử nghiệm không cần database). */
export function docuzenRowsToFiles(rows: DocuzenRow[]): IndexedFile[] {
  // Phòng hờ dữ liệu có 2 phiên bản cùng 'A': giữ số phiên bản lớn nhất
  const latest = new Map<number, DocuzenRow>();
  for (const r of rows) {
    const current = latest.get(r.DocumentID);
    if (!current || r.VersionNumber > current.VersionNumber) latest.set(r.DocumentID, r);
  }
  return [...latest.values()].map((r) => {
    const typeCode = (r.TypeCode ?? "").trim() || "?";
    const meta: DocuzenMeta = {
      documentId: r.DocumentID,
      number: r.DocumentNumber.trim(),
      title: (r.Title ?? "").trim(),
      typeCode,
      group: groupOf(r.DocumentTypeID ?? 0, typeCode),
      ...parseDocuzenNumber(r.DocumentNumber),
      parentId: r.LinkedDocumentID ?? null,
      versionId: r.VersionID,
      version: r.VersionNumber,
      effectiveDate: isoDate(r.EffectiveDate),
      expirationDate: isoDate(r.ExpirationDate),
    };
    return {
      fileName: docuzenFileName(meta),
      // Cố định theo tài liệu (không theo phiên bản): bản mới thay chỗ bản cũ trong Qdrant
      filePath: `${DOCUZEN_PATH_PREFIX}${r.DocumentID}`,
      category: (r.DeptCode ?? "").trim() || "?",
      docuzen: meta,
    };
  });
}

const CATALOG_QUERY = `
  SELECT m.DocumentID, m.DocumentNumber, d.DeptCode, m.DocumentTypeID, t.DocumentType AS TypeCode, m.LinkedDocumentID,
         v.VersionID, v.VersionNumber, v.EffectiveDate, v.ExpirationDate, vt.Title
  FROM DMS.AizantIT_DocumentMaster m
  JOIN DMS.AizantIT_DocVersion v ON v.DocumentID = m.DocumentID AND v.Status = 'A'
  LEFT JOIN DMS.AizantIT_DocVersionTitle vt ON vt.DocTitleID = v.DocTitleID
  LEFT JOIN UMS.AizantIT_DepartmentMaster d ON d.DeptID = m.DeptID
  LEFT JOIN DMS.AizantIT_DocumentType t ON t.DocumentTypeID = m.DocumentTypeID`;

// File của các phiên bản đang hiệu lực (mỗi phiên bản thường có 1 .docx gốc + 1-2 .pdf)
const LOCATION_QUERY = `
  SELECT l.DocVID, l.FilePath, l.RoleID
  FROM DMS.AizantIT_DocumentLocation l
  JOIN DMS.AizantIT_DocVersion v ON v.VersionID = l.DocVID AND v.Status = 'A'
  WHERE l.isTemp = 0 AND l.FilePath IS NOT NULL`;

interface LocationRow {
  DocVID: number;
  FilePath: string;
  RoleID: number | null;
}

/**
 * File nên đọc của một phiên bản: .docx trước (chữ chính xác, giữ bảng / đề mục, không cần OCR), rồi .pdf
 * (RoleID 11 trước, 30 sau), rồi .xlsx. Định dạng bot không đọc được (.doc, .rtf...) → null.
 */
export function pickSourceFile(rows: { FilePath: string; RoleID: number | null }[]): string | null {
  const rank = (r: { FilePath: string; RoleID: number | null }) => {
    const ext = path.extname(r.FilePath.replace(/\\/g, "/")).toLowerCase();
    const base = { ".docx": 0, ".pdf": 10, ".xlsx": 20, ".xls": 20 }[ext];
    return base === undefined ? Infinity : base + (r.RoleID === 11 ? 0 : 1);
  };
  const best = [...rows].sort((a, b) => rank(a) - rank(b))[0];
  return best && rank(best) !== Infinity ? best.FilePath : null;
}

export interface DocuzenCatalog {
  files: IndexedFile[];
  sourceByDocumentId: Map<number, string | null>; // FilePath (như lưu trong database) của file nên đọc
}

/** Đọc danh mục + file nguồn từ database, không qua cache (dùng cho script index). */
export async function loadDocuzenCatalog(): Promise<DocuzenCatalog> {
  const pool = await getQualzenPool();
  const [catalog, locations] = await Promise.all([pool.request().query(CATALOG_QUERY), pool.request().query(LOCATION_QUERY)]);
  const files = docuzenRowsToFiles(catalog.recordset as DocuzenRow[]);
  const byVersion = new Map<number, LocationRow[]>();
  for (const row of locations.recordset as LocationRow[]) {
    byVersion.set(row.DocVID, [...(byVersion.get(row.DocVID) ?? []), row]);
  }
  const sourceByDocumentId = new Map<number, string | null>();
  for (const f of files) {
    sourceByDocumentId.set(f.docuzen!.documentId, pickSourceFile(byVersion.get(f.docuzen!.versionId) ?? []));
  }
  return { files, sourceByDocumentId };
}

let cache: { catalog: DocuzenCatalog; loadedAt: number } | null = null;
let loading: Promise<DocuzenCatalog> | null = null;

async function cachedCatalog(): Promise<DocuzenCatalog> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.catalog;
  loading ??= loadDocuzenCatalog()
    .then((catalog) => {
      cache = { catalog, loadedAt: Date.now() };
      return catalog;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Danh mục tài liệu đang hiệu lực. Lỗi (mất kết nối database...) → throw; caller tự quay về danh mục theo tên file. */
export async function getDocuzenFiles(): Promise<IndexedFile[]> {
  return (await cachedCatalog()).files;
}

/** FilePath trong database → URL trên file server: "\" → "/", mã hoá từng phần (dấu cách, chữ có dấu...). */
export function docuzenFileUrl(filePath: string): string {
  const relative = filePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return config.docuzenFileBaseUrl.replace(/\/?$/, "/") + relative.split("/").map(encodeURIComponent).join("/");
}

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** Tải một file từ file server Docuzen về destPath. File server trả trang HTML (lỗi / đăng nhập) → throw. */
export async function downloadDocuzenFile(filePath: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(docuzenFileUrl(filePath), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (/text\/html/i.test(res.headers.get("content-type") ?? "")) throw new Error("file server trả về trang HTML, không phải file");
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new Error(`file quá lớn (${Math.round(length / 1024 / 1024)} MB)`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, buffer);
  } catch (err) {
    throw new Error(`Không tải được ${filePath}: ${(err as Error).name === "AbortError" ? "quá thời gian" : (err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** File nguồn hiện hành của một tài liệu (theo danh mục đã cache). */
export async function currentSourceOf(documentId: number): Promise<{ file: IndexedFile; sourcePath: string } | null> {
  const catalog = await cachedCatalog();
  const file = catalog.files.find((f) => f.docuzen?.documentId === documentId);
  const sourcePath = catalog.sourceByDocumentId.get(documentId);
  return file && sourcePath ? { file, sourcePath } : null;
}

/** "docuzen://123" → 123; đường dẫn khác → null. */
export function docuzenDocumentId(filePath: string): number | null {
  const m = filePath.match(/^docuzen:\/\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export const docuzenEnabled = () => config.docuzenEnabled;

const compactCode = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Số tài liệu Docuzen dạng rút gọn ("frmqasopgen0005f17") để so với mã trong tên file. */
export function docuzenNumberKeys(files: IndexedFile[]): Set<string> {
  return new Set(files.filter((f) => f.docuzen).map((f) => compactCode(f.docuzen!.number)));
}

/**
 * Tên file có phải một tài liệu Docuzen không: mã trong tên file trùng số tài liệu, phần còn lại chỉ là số
 * phiên bản. "FRM-QA-SOP-GEN-0005-03 SELF INSPECTION.docx" ↔ FRM/QA/SOP-GEN/0005;
 * "FRM.QA.SOP-GEN.0005-F17-02 ..." ↔ FRM/QA/SOP-GEN/0005/F17 (không phải SOP mẹ FRM/QA/SOP-GEN/0005).
 */
export function isOnDocuzen(fileName: string, keys: Set<string>): boolean {
  const code = parseFileCode(fileName);
  if (!code) return false;
  const key = compactCode(code.code);
  // Bỏ dần các chữ số cuối (số phiên bản) tới khi gặp đúng một số tài liệu Docuzen
  for (let end = key.length; end >= 8; end--) {
    if (!/^\d*$/.test(key.slice(end))) return false;
    if (keys.has(key.slice(0, end))) return true;
  }
  return false;
}

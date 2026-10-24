import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import type sql from "mssql";
import { connectQualzen, qualzenSettingsFromEnv } from "./qualzenDb.js";

/**
 * Công cụ khảo sát phần quản lý tài liệu (Docuzen / DMS) trong database QualZen (chạy tay, không thuộc server):
 *   npm run docuzen:explore
 * Chỉ chạy SELECT. Mục tiêu: hiểu đủ để lấy MỌI tài liệu của mọi phòng ban (SOP, biểu mẫu, list...):
 *   - DeptID / DocumentTypeID / DocumentStatus nghĩa là gì (bảng tra cứu + phân bố giá trị);
 *   - mỗi tài liệu có bao nhiêu phiên bản, phiên bản nào đang hiệu lực;
 *   - FilePath lưu dạng gì, tải được qua http://10.1.11.35/fs/{FilePath} không, có phải đăng nhập không.
 *
 * Bảng chính (theo code SOP IT đang chạy): DMS.AizantIT_DocumentMaster, AizantIT_DocVersion,
 * AizantIT_DocVersionTitle, AizantIT_DocumentLocation (key DocVID).
 *
 * Báo cáo CÓ dữ liệu thật (mã, tên tài liệu, đường dẫn) nên nằm trong .cache/ (gitignored).
 * Chạy với --no-samples để bỏ dòng mẫu và đường dẫn cụ thể (vẫn giữ thống kê).
 * Thử tải file: chỉ đọc vài KB đầu, không lưu ra đĩa. Đổi địa chỉ file server: DOCUZEN_FILE_BASE_URL.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const OUTPUT_PATH = path.resolve(__dirname, "../.cache/docuzen-explore.md");
const FILE_BASE_URL = process.env.DOCUZEN_FILE_BASE_URL || "http://10.1.11.35/fs/";
const SAMPLE_ROWS = 5;
const MAX_CELL_CHARS = 200;
const FETCH_TEST_FILES = 4;
const FETCH_BYTES = 4096;
const FETCH_TIMEOUT_MS = 10000;
const includeSamples = !process.argv.includes("--no-samples");

const CORE_TABLES = ["AizantIT_DocumentMaster", "AizantIT_DocVersion", "AizantIT_DocVersionTitle", "AizantIT_DocumentLocation"];

const quote = (name: string) => `[${name.replace(/]/g, "]]")}]`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  const text = String(value).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) + "…" : text;
}

function toMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_(không có dòng nào)_\n";
  const columns = Object.keys(rows[0]);
  return (
    [
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${columns.map((c) => formatCell(row[c])).join(" | ")} |`),
    ].join("\n") + "\n"
  );
}

/** FilePath trong DB → URL tải file. Đã là URL thì giữ nguyên; không thì ghép sau FILE_BASE_URL. */
function fileUrlOf(filePath: string): string {
  const raw = filePath.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      return encodeURI(decodeURI(raw)); // đã mã hoá sẵn thì không mã hoá lần nữa
    } catch {
      return encodeURI(raw); // có "%" lẻ không giải mã được
    }
  }
  const relative = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^fs\//i, "");
  return FILE_BASE_URL.replace(/\/?$/, "/") + relative.split("/").map(encodeURIComponent).join("/");
}

/** Đoán loại file từ vài byte đầu: để biết server trả file thật hay trang đăng nhập / báo lỗi. */
function sniff(bytes: Buffer, contentType: string): string {
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "PDF";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "ZIP (docx / xlsx)";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return "Office cũ (doc / xls)";
  const head = bytes.subarray(0, 300).toString("utf8").toLowerCase();
  if (/html/.test(contentType) || /<html|<!doctype/.test(head)) {
    return /login|đăng nhập|password|signin|sign in/.test(head) ? "HTML - có vẻ là TRANG ĐĂNG NHẬP" : "HTML (không phải file tài liệu)";
  }
  return `không rõ (${contentType || "không có content-type"})`;
}

async function testFetch(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${FETCH_BYTES - 1}` }, signal: controller.signal, redirect: "manual" });
    const reader = res.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (reader && size < FETCH_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    await reader?.cancel().catch(() => {});
    const contentType = res.headers.get("content-type") ?? "";
    return {
      HTTP: res.status,
      Redirect: res.headers.get("location") ?? "",
      ContentType: contentType,
      ContentLength: res.headers.get("content-length") ?? "",
      ContentRange: res.headers.get("content-range") ?? "",
      DocVaoLa: res.status < 300 ? sniff(Buffer.concat(chunks), contentType) : "",
    };
  } catch (err) {
    return { HTTP: "lỗi", DocVaoLa: (err as Error).name === "AbortError" ? `quá ${FETCH_TIMEOUT_MS / 1000}s` : (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function explore() {
  const settings = qualzenSettingsFromEnv();
  if (!settings) {
    throw new Error("Thiếu cấu hình. Docuzen dùng chung database với QualZen: cần QUALZEN_DB_SERVER, QUALZEN_DB_NAME, QUALZEN_DB_USER, QUALZEN_DB_PASSWORD");
  }

  console.log(`🔎 Khảo sát Docuzen: ${settings.server}:${settings.port} / ${settings.database} (user: ${settings.user})`);
  const pool: sql.ConnectionPool = await connectQualzen(settings);

  const out: string[] = [
    `# Khảo sát Docuzen (quản lý tài liệu) trong database QualZen`,
    ``,
    `- Server: ${settings.server} / ${settings.database}`,
    `- Thời điểm: ${new Date().toISOString()}`,
    `- File server: ${FILE_BASE_URL}`,
    `- Dòng mẫu: ${includeSamples ? `có (${SAMPLE_ROWS} dòng)` : "không"}`,
    ``,
  ];
  let errors = 0;
  const query = async (q: string) => (await pool.request().query(q)).recordset as Record<string, unknown>[];
  // Mỗi mục chạy độc lập: bảng / cột không có thì ghi lỗi rồi đi tiếp
  const section = async (title: string, q: string) => {
    out.push(`### ${title}`, "");
    try {
      out.push(toMarkdownTable(await query(q)));
    } catch (err) {
      errors++;
      out.push(`_Lỗi: ${(err as Error).message}_`, "");
      console.warn(`   ⚠️  ${title}: ${(err as Error).message}`);
    }
  };

  // ---- 1. Các bảng của phần tài liệu ----
  console.log("   1. Danh sách bảng");
  out.push(`## 1. Các bảng của phần tài liệu (schema DMS và bảng tên AizantIT_Doc...)`, "");
  await section(
    "Bảng + số dòng",
    `SELECT s.name AS SchemaName, t.name AS TableName, SUM(p.rows) AS SoDong
     FROM sys.tables t
     JOIN sys.schemas s ON t.schema_id = s.schema_id
     JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE s.name = 'DMS' OR t.name LIKE 'AizantIT[_]Doc%'
     GROUP BY s.name, t.name
     ORDER BY s.name, t.name`
  );

  // Schema của 4 bảng chính (code SOP IT chỉ ghi schema của DocumentMaster)
  const schemaOf: Record<string, string> = {};
  try {
    const rows = await query(
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN (${CORE_TABLES.map(literal).join(", ")})`
    );
    for (const r of rows) {
      const name = String(r.TABLE_NAME);
      // Trùng tên ở nhiều schema: ưu tiên DMS
      if (!schemaOf[name] || r.TABLE_SCHEMA === "DMS") schemaOf[name] = String(r.TABLE_SCHEMA);
    }
  } catch (err) {
    errors++;
    out.push(`_Lỗi khi tìm schema của bảng chính: ${(err as Error).message}_`, "");
  }
  const missing = CORE_TABLES.filter((t) => !schemaOf[t]);
  if (missing.length > 0) out.push(`_Không tìm thấy bảng: ${missing.join(", ")}_`, "");
  const T = (name: string) => `${quote(schemaOf[name] ?? "DMS")}.${quote(name)}`;
  const [MASTER, VERSION, TITLE, LOCATION] = CORE_TABLES.map(T);

  // ---- 2. Cột của 4 bảng chính ----
  console.log("   2. Cột của bảng chính");
  out.push(`## 2. Cột của 4 bảng chính`, "");
  for (const name of CORE_TABLES) {
    await section(
      `${schemaOf[name] ?? "?"}.${name}`,
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS MaxLength, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ${literal(schemaOf[name] ?? "DMS")} AND TABLE_NAME = ${literal(name)}
       ORDER BY ORDINAL_POSITION`
    );
  }

  // ---- 3. Bảng tra cứu nhỏ: loại tài liệu, trạng thái, phòng ban ----
  console.log("   3. Bảng tra cứu");
  out.push(`## 3. Bảng tra cứu (loại tài liệu, trạng thái, phòng ban): toàn bộ nội dung`, "");
  try {
    const small = await query(`
      SELECT TOP 25 s.name AS SchemaName, t.name AS TableName, SUM(p.rows) AS SoDong
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE (
          (s.name = 'DMS' AND (t.name LIKE '%Type%' OR t.name LIKE '%Status%' OR t.name LIKE '%Master%' OR t.name LIKE '%Categ%'))
          OR ((t.name LIKE '%Department%' OR t.name LIKE '%Dept%') AND s.name IN ('UMS', 'dbo', 'DMS'))
        )
        AND t.name NOT LIKE '%History%' AND t.name NOT LIKE '%Bkp%' AND t.name NOT LIKE '%Backup%'
        AND t.name NOT LIKE '%Log%' AND t.name NOT LIKE '%Map%'
        AND t.name NOT IN (${CORE_TABLES.map(literal).join(", ")})
      GROUP BY s.name, t.name
      HAVING SUM(p.rows) BETWEEN 1 AND 300
      ORDER BY s.name, t.name`);
    out.push(toMarkdownTable(small));
    for (const row of small) {
      await section(`${row.SchemaName}.${row.TableName}`, `SELECT TOP 300 * FROM ${quote(String(row.SchemaName))}.${quote(String(row.TableName))} ORDER BY 1`);
    }
  } catch (err) {
    errors++;
    out.push(`_Lỗi khi tìm bảng tra cứu: ${(err as Error).message}_`, "");
  }

  // ---- 4. Phân bố: phòng ban, loại, trạng thái, số phiên bản ----
  console.log("   4. Phân bố giá trị");
  out.push(`## 4. Phân bố giá trị`, "");
  await section("Số tài liệu theo DeptID × DocumentTypeID", `SELECT DeptID, DocumentTypeID, COUNT(*) AS SoTaiLieu FROM ${MASTER} GROUP BY DeptID, DocumentTypeID ORDER BY DeptID, DocumentTypeID`);
  await section("Số phiên bản theo DocumentStatus", `SELECT DocumentStatus, COUNT(*) AS SoPhienBan FROM ${VERSION} GROUP BY DocumentStatus ORDER BY SoPhienBan DESC`);
  await section(
    "Trạng thái của phiên bản MỚI NHẤT mỗi tài liệu (theo DocVID lớn nhất)",
    `SELECT v.DocumentStatus, COUNT(*) AS SoTaiLieu
     FROM ${VERSION} v
     JOIN (SELECT DocumentID, MAX(DocVID) AS DocVID FROM ${VERSION} GROUP BY DocumentID) last ON last.DocVID = v.DocVID
     GROUP BY v.DocumentStatus ORDER BY SoTaiLieu DESC`
  );
  await section(
    "Số phiên bản mỗi tài liệu",
    `SELECT SoPhienBan, COUNT(*) AS SoTaiLieu FROM (SELECT DocumentID, COUNT(*) AS SoPhienBan FROM ${VERSION} GROUP BY DocumentID) x GROUP BY SoPhienBan ORDER BY SoPhienBan`
  );
  await section(
    "Tài liệu có > 1 phiên bản cùng trạng thái (để biết có cần lọc thêm theo ngày hiệu lực)",
    `SELECT TOP 20 DocumentID, DocumentStatus, COUNT(*) AS SoPhienBan FROM ${VERSION} GROUP BY DocumentID, DocumentStatus HAVING COUNT(*) > 1 ORDER BY SoPhienBan DESC`
  );
  await section(
    "Phiên bản thiếu tiêu đề / thiếu đường dẫn file",
    `SELECT
       (SELECT COUNT(*) FROM ${VERSION}) AS TongPhienBan,
       (SELECT COUNT(*) FROM ${VERSION} v WHERE NOT EXISTS (SELECT 1 FROM ${TITLE} t WHERE t.DocVID = v.DocVID)) AS KhongCoTieuDe,
       (SELECT COUNT(*) FROM ${VERSION} v WHERE NOT EXISTS (SELECT 1 FROM ${LOCATION} l WHERE l.DocVID = v.DocVID)) AS KhongCoFile,
       (SELECT COUNT(*) FROM (SELECT DocVID FROM ${LOCATION} GROUP BY DocVID HAVING COUNT(*) > 1) x) AS PhienBanCoNhieuFile`
  );

  // ---- 5. Dòng mẫu (nối 4 bảng như code SOP IT, nhưng mọi phòng ban / loại) ----
  if (includeSamples) {
    console.log("   5. Dòng mẫu");
    out.push(`## 5. Dòng mẫu: ${SAMPLE_ROWS} phiên bản sửa gần nhất (mọi phòng ban, mọi loại)`, "");
    await section(
      "Nối 4 bảng",
      `SELECT TOP ${SAMPLE_ROWS} m.DocumentID, m.DocumentNo, m.DeptID, m.DocumentTypeID, v.DocVID, v.VersionNo, v.DocumentStatus,
              v.EffectiveDate, v.ExpirationDate, v.LastmodifiedDate, t.Title, l.FilePath
       FROM ${MASTER} m
       JOIN ${VERSION} v ON v.DocumentID = m.DocumentID
       LEFT JOIN ${TITLE} t ON t.DocVID = v.DocVID
       LEFT JOIN ${LOCATION} l ON l.DocVID = v.DocVID
       ORDER BY v.LastmodifiedDate DESC`
    );
    for (const name of CORE_TABLES) {
      await section(`${name}: ${SAMPLE_ROWS} dòng (mọi cột)`, `SELECT TOP ${SAMPLE_ROWS} * FROM ${T(name)} ORDER BY 1 DESC`);
    }
  }

  // ---- 6. Dạng đường dẫn file + thử tải ----
  console.log("   6. Đường dẫn file");
  out.push(`## 6. Đường dẫn file (FilePath)`, "");
  try {
    const paths = (await query(`SELECT TOP 50000 FilePath FROM ${LOCATION} WHERE FilePath IS NOT NULL`)).map((r) => String(r.FilePath));
    const count = (re: RegExp) => paths.filter((p) => re.test(p)).length;
    const extensions: Record<string, number> = {};
    for (const p of paths) {
      const ext = (p.match(/\.([a-z0-9]{1,5})(?:[?#].*)?$/i)?.[1] ?? "(không có đuôi)").toLowerCase();
      extensions[ext] = (extensions[ext] ?? 0) + 1;
    }
    out.push(
      toMarkdownTable([
        {
          TongDuongDan: paths.length,
          BatDauHttp: count(/^https?:\/\//i),
          BatDauFs: count(/^\/?fs\//i),
          CoDauGachNguoc: count(/\\/),
          DuongDanTuyetDoiWindows: count(/^[a-z]:\\|^\\\\/i),
          CoKhoangTrang: count(/\s/),
          CoChuCoDau: count(/[^\x00-\x7f]/),
        },
      ]),
      "Theo đuôi file:",
      "",
      toMarkdownTable(Object.entries(extensions).sort((a, b) => b[1] - a[1]).map(([DuoiFile, SoFile]) => ({ DuoiFile, SoFile }))),
      ""
    );

    // Thử tải vài file mới nhất (mỗi đuôi một file nếu được)
    const latest = await query(
      `SELECT TOP 200 l.FilePath FROM ${LOCATION} l JOIN ${VERSION} v ON v.DocVID = l.DocVID WHERE l.FilePath IS NOT NULL ORDER BY v.LastmodifiedDate DESC`
    );
    const picked: string[] = [];
    const seenExt = new Set<string>();
    for (const r of latest) {
      const p = String(r.FilePath);
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      if (picked.length < FETCH_TEST_FILES && !seenExt.has(ext)) {
        picked.push(p);
        seenExt.add(ext);
      }
    }
    for (const r of latest) if (picked.length < FETCH_TEST_FILES && !picked.includes(String(r.FilePath))) picked.push(String(r.FilePath));

    out.push(`### Thử tải ${picked.length} file (chỉ đọc ${FETCH_BYTES} byte đầu, không lưu)`, "");
    const results: Record<string, unknown>[] = [];
    for (const p of picked) {
      const url = fileUrlOf(p);
      console.log(`      thử tải ${includeSamples ? url : "(ẩn đường dẫn)"}`);
      results.push({ ...(includeSamples ? { FilePath: p, Url: url } : { DuoiFile: p.split(".").pop() }), ...(await testFetch(url)) });
    }
    out.push(toMarkdownTable(results));
  } catch (err) {
    errors++;
    out.push(`_Lỗi: ${(err as Error).message}_`, "");
    console.warn(`   ⚠️  Đường dẫn file: ${(err as Error).message}`);
  }

  await pool.close();
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, out.join("\n"), "utf-8");

  console.log(`\n✅ Đã ghi báo cáo: ${OUTPUT_PATH}`);
  if (errors > 0) console.log(`   ⚠️  ${errors} mục bị lỗi (xem trong báo cáo)`);
}

explore().catch((err) => {
  console.error("❌ Khảo sát thất bại:", (err as Error).message || err);
  process.exit(1);
});

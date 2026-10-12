import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import type sql from "mssql";
import { connectQualzen, qualzenSettingsFromEnv } from "./qualzenDb.js";

/**
 * Công cụ khảo sát database QualZen (chạy tay, không thuộc server):
 *   npm run qualzen:explore
 * Chỉ chạy SELECT. Ghi 1 file báo cáo gồm: danh sách cột, nội dung bảng tra cứu,
 * phân bố trạng thái và vài dòng mẫu của các bảng chính - đủ để viết truy vấn cho AI.
 *
 * Báo cáo CÓ dữ liệu thật (mô tả phiếu, tên người) nên nằm trong .cache/ (gitignored).
 * Chạy với --no-samples để bỏ phần dòng mẫu.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const OUTPUT_PATH = path.resolve(__dirname, "../.cache/qualzen-explore.md");
const SAMPLE_ROWS = 3;
const MAX_CELL_CHARS = 200;
const includeSamples = !process.argv.includes("--no-samples");

type Table = [schema: string, name: string];

// Bảng chính + lịch sử của từng module: lấy danh sách cột và vài dòng mẫu
const MAIN_TABLES: Table[] = [
  ["QualZen_ActionPlan", "ActionPlanMaster"],
  ["QualZen_ActionPlan", "ActionPlanHistory"],
  ["QualZen_ActionPlan", "Actionplan_Stage"],
  ["Qzen_AAPL", "ChangeControlMaster"],
  ["Qzen_AAPL", "ChangeControlHistory"],
  ["Qzen_AAPL", "CCN_PostChangeReview"],
  ["Qzen_AAPL", "CCN_ProposedChange"],
  ["QMS", "AizantIT_CAPAMaster"],
  ["QMS", "AizantIT_Capa_History"],
  ["QMS", "AizantIT_CAPA_ActionPlan"],
  ["QMS", "AizantIT_CapaOtherSourceEvents"],
  ["QMS", "AizantIT_IncidentMaster"],
  ["QMS", "AizantIT_IncidentHistory"],
  ["QMS", "AizantIT_Incident_Review"],
  ["QMS_LIR", "LabIncidentMaster"],
  ["QMS_LIR", "LabIncidentHistory"],
];

// Bảng tra cứu nhỏ (trạng thái, loại, phân loại): lấy toàn bộ nội dung
const LOOKUP_TABLES: Table[] = [
  ["QualZen_ActionPlan", "ActionPlanHistoryStatus"],
  ["QualZen_ActionPlan", "ActionPlanWorkFlow"],
  ["QualZen_ActionPlan", "TypeOfTestMaster"],
  ["Qzen_AAPL", "CCN_ObjectStatus"],
  ["Qzen_AAPL", "CCNChangeTypeMaster"],
  ["Qzen_AAPL", "CCN_TypeOfChange"],
  ["Qzen_AAPL", "CCN_ItemMaster"],
  ["Qzen_AAPL", "CCN_RiskAssessment_Status"],
  ["QualZen_CCN", "CCN_ImpactAssessmentStage"],
  ["QualZen_CCN", "CCN_AttachmentStage"],
  ["QMS", "AizantIT_Tbl_CAPACategorization"],
  ["QMS", "Category_of_Deviation"],
  ["QMS", "AizantIT_Incident_ImpactMaster"],
  ["QMS", "AizantIT_Incident_ReviewMaster"],
  ["QMS", "AizantIT_Incident_EffectedMaster"],
  ["QMS", "AizantIT_Incident_EffectStatusMaster"],
  ["QMS_LIR", "LabIncidentStatuses"],
  ["QMS_LIR", "LabIncident_HistoryStatus"],
  ["QMS_LIR", "AizantIT_LIR_CFTDepartmentStatus"],
  ["OOS", "CAPAActionStatus"],
];

// Cột phân loại/trạng thái: đếm số dòng theo từng giá trị để hiểu ý nghĩa
const DISTRIBUTIONS: [Table, string[]][] = [
  [
    ["QualZen_ActionPlan", "ActionPlanMaster"],
    ["CurrentStatus", "NextStatus", "QualityEvent", "BasedOn", "IsTemp", "IsCancelled", "IsImplemented", "RoleID", "ActionType_ID", "ActionPlanDeptID"],
  ],
  [["QualZen_ActionPlan", "ActionPlanHistory"], ["ActionPlanHistoryStatusID", "ActionRole"]],
  [["QualZen_ActionPlan", "Actionplan_Stage"], ["BasedOn", "ActionPlan_StageID"]],
];

const quote = (name: string) => `[${name.replace(/]/g, "]]")}]`;
const fullName = ([schema, name]: Table) => `${quote(schema)}.${quote(name)}`;

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
  const lines = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((c) => formatCell(row[c])).join(" | ")} |`),
  ];
  return lines.join("\n") + "\n";
}

async function explore() {
  const settings = qualzenSettingsFromEnv();
  if (!settings) {
    throw new Error(
      "Thiếu cấu hình. Thêm vào backend/.env: QUALZEN_DB_SERVER, QUALZEN_DB_NAME, QUALZEN_DB_USER, QUALZEN_DB_PASSWORD"
    );
  }

  console.log(`🔎 Khảo sát QualZen: ${settings.server}:${settings.port} / ${settings.database} (user: ${settings.user})`);
  const pool: sql.ConnectionPool = await connectQualzen(settings);

  const out: string[] = [
    `# Khảo sát database QualZen`,
    ``,
    `- Server: ${settings.server} / ${settings.database}`,
    `- Thời điểm: ${new Date().toISOString()}`,
    `- Dòng mẫu: ${includeSamples ? `có (${SAMPLE_ROWS} dòng mới nhất mỗi bảng)` : "không"}`,
    ``,
  ];
  let errors = 0;

  // Mỗi mục chạy độc lập: bảng không tồn tại / không có quyền thì ghi lỗi rồi đi tiếp
  const section = async (title: string, query: string) => {
    out.push(`### ${title}`, "");
    try {
      const result = await pool.request().query(query);
      out.push(toMarkdownTable(result.recordset as Record<string, unknown>[]));
    } catch (err) {
      errors++;
      out.push(`_Lỗi: ${(err as Error).message}_`, "");
      console.warn(`   ⚠️  ${title}: ${(err as Error).message}`);
    }
  };

  const columnsQuery = ([schema, name]: Table) => `
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS MaxLength, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}' AND TABLE_NAME = '${name.replace(/'/g, "''")}'
    ORDER BY ORDINAL_POSITION`;

  out.push(`## 1. Bảng chính: cột${includeSamples ? " và dòng mẫu" : ""}`, "");
  for (const table of MAIN_TABLES) {
    console.log(`   ${table.join(".")}`);
    await section(`${table.join(".")} - cột`, columnsQuery(table));
    if (includeSamples) {
      await section(
        `${table.join(".")} - ${SAMPLE_ROWS} dòng mới nhất`,
        `SELECT TOP ${SAMPLE_ROWS} * FROM ${fullName(table)} ORDER BY 1 DESC`
      );
    }
  }

  out.push(`## 2. Bảng tra cứu: toàn bộ nội dung`, "");
  for (const table of LOOKUP_TABLES) {
    console.log(`   ${table.join(".")}`);
    await section(table.join("."), `SELECT TOP 200 * FROM ${fullName(table)} ORDER BY 1`);
  }

  out.push(`## 3. Phân bố giá trị của các cột trạng thái / phân loại`, "");
  for (const [table, columns] of DISTRIBUTIONS) {
    for (const column of columns) {
      await section(
        `${table.join(".")}.${column}`,
        `SELECT ${quote(column)} AS GiaTri, COUNT(*) AS SoDong FROM ${fullName(table)} GROUP BY ${quote(column)} ORDER BY SoDong DESC`
      );
    }
  }

  out.push(`## 4. View người dùng`, "");
  await section("LIMS.vw_UserDetails - cột", columnsQuery(["LIMS", "vw_UserDetails"]));
  await section("LIMS.vw_UserDetails - số dòng", `SELECT COUNT(*) AS SoDong FROM [LIMS].[vw_UserDetails]`);

  out.push(`## 5. Bảng phòng ban / vai trò / chức danh (để đổi ID thành tên)`, "");
  await section(
    "Các bảng có tên chứa Department / Dept / Role / Designation",
    `SELECT s.name AS SchemaName, t.name AS TableName, SUM(p.rows) AS SoDong
     FROM sys.tables t
     JOIN sys.schemas s ON t.schema_id = s.schema_id
     JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE s.name IN ('UMS', 'dbo', 'LIMS', 'QMS')
       AND (t.name LIKE '%Department%' OR t.name LIKE '%Dept%' OR t.name LIKE '%Role%' OR t.name LIKE '%Designation%')
       AND t.name NOT LIKE '%History%' AND t.name NOT LIKE '%Bkp%' AND t.name NOT LIKE '%Backup%'
     GROUP BY s.name, t.name
     ORDER BY s.name, t.name`
  );
  // Bảng danh mục nhỏ thì in luôn nội dung
  try {
    const small = await pool.request().query(`
      SELECT TOP 12 s.name AS SchemaName, t.name AS TableName
      FROM sys.tables t
      JOIN sys.schemas s ON t.schema_id = s.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE s.name IN ('UMS', 'dbo', 'LIMS')
        AND (t.name LIKE '%Department%' OR t.name LIKE '%Dept%' OR t.name LIKE '%Role%' OR t.name LIKE '%Designation%')
        AND t.name NOT LIKE '%History%' AND t.name NOT LIKE '%Bkp%' AND t.name NOT LIKE '%Backup%'
        AND t.name NOT LIKE '%Map%' AND t.name NOT LIKE '%Log%'
      GROUP BY s.name, t.name
      HAVING SUM(p.rows) BETWEEN 1 AND 300
      ORDER BY LEN(t.name)`);
    for (const row of small.recordset) {
      await section(
        `${row.SchemaName}.${row.TableName}`,
        `SELECT TOP 100 * FROM ${fullName([row.SchemaName, row.TableName])} ORDER BY 1`
      );
    }
  } catch (err) {
    errors++;
    out.push(`_Lỗi khi tìm bảng danh mục: ${(err as Error).message}_`, "");
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

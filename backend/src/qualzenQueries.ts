import sql from "mssql";

/**
 * Các truy vấn CỐ ĐỊNH (chỉ SELECT, có tham số) trên database QualZen.
 * AI không tự viết SQL: nó chỉ chọn truy vấn và điền tham số (xem qualzenAssistant.ts).
 *
 * Ghi chú về dữ liệu (theo khảo sát prod_fremed, 10/2026):
 * - Ngày giờ lưu theo UTC → so sánh "quá hạn" bằng GETUTCDATE(), hiển thị theo giờ Việt Nam.
 * - ActionPlanMaster.CurrentStatus dùng mã của ActionPlanWorkFlow.StatusNum (10 = Closed),
 *   KHÔNG phải mã của ActionPlanHistoryStatus (bảng đó là mã của từng dòng lịch sử).
 * - ActionPlanMaster.BasedOn: 2 = CCN (BasedID → ChangeControlMaster.CCN_ID),
 *   5 = CAPA (BasedID → AizantIT_CAPAMaster.CAPAID).
 * - Phiếu nháp: IsTemp = 1, số phiếu là "N/A".
 */

export const DEPT_CODES = ["QA", "QC", "PD", "WH", "ME", "IT", "HR", "RA", "FD", "AD", "DS", "PU", "TS"];

const AI_STATUS_CLOSED = 10;
const AI_PENDING_RESPONSIBLE = [3, 5, 8]; // chờ người phụ trách thực hiện / sửa lại sau khi bị trả về
const AI_PENDING_HOD = [4];
const AI_PENDING_QA = [6, 7];
const AI_BASED_ON_CCN = 2;
const AI_BASED_ON_CAPA = 5;

const VN_OFFSET_HOURS = 7;
const LIST_TEXT_CHARS = 300;

/** Số phiếu tối đa mỗi lần liệt kê, và khi người dùng yêu cầu "liệt kê hết". */
export const DEFAULT_LIST_LIMIT = 20;
export const FULL_LIST_LIMIT = 100;
/** Liệt kê hết thì mỗi phiếu chỉ giữ nội dung ngắn, để câu trả lời không quá dài. */
export const COMPACT_TEXT_CHARS = 110;

export type DateField = "created" | "target" | "closed";
const DETAIL_TEXT_CHARS = 1500;

// ============== Tiện ích ==============

const vnDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Ngày giờ UTC trong DB → "dd/mm/yyyy hh:mm" giờ Việt Nam. */
export function formatDate(value: unknown): string | null {
  if (!(value instanceof Date) || isNaN(value.getTime())) return null;
  return vnDateTime.format(value).replace(",", "");
}

function clip(value: unknown, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

// Tên người trong DB không dấu → bỏ dấu ở từ khóa tìm kiếm
function stripDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// FullName trong DB có dạng "NV00250 - CAM  BUI" (thừa khoảng trắng)
const personName = (value: unknown): string | null => clip(value, 200);

/**
 * Biểu thức SQL bỏ hết dấu phân cách và đổi thành chữ hoa, để mã tài liệu khớp bất kể cách viết:
 * "FRM/IT/SOP-GEN/0016", "FRM.IT.SOP-GEN.0016", "FRM-IT-SOP-GEN 0016" đều thành "FRMITSOPGEN0016".
 */
// Gồm cả các ký tự "trông giống" mà Word hay tự chèn: gạch nối U+2010/2011, gạch dài U+2013/2014
const SQUASHED_CHARS = ["'/'", "'.'", "'-'", "'_'", "' '", "CHAR(160)", "NCHAR(8208)", "NCHAR(8209)", "NCHAR(8211)", "NCHAR(8212)"];
const sqlSquash = (column: string) =>
  `UPPER(${SQUASHED_CHARS.reduce((expr, ch) => `REPLACE(${expr}, ${ch}, '')`, `ISNULL(${column}, '')`)})`;

const likePattern = (text: string) => `%${text.replace(/[%_[]/g, (ch) => `[${ch}]`)}%`;

// ============== Khớp mã phiếu ==============

/**
 * Người dùng hay gõ tắt mã phiếu: "AI 1139", "PCC IT 009", "CAPA QC 2026 136".
 * - Mã đầy đủ (có từ 3 dấu "/") → so khớp chính xác.
 * - Gõ tắt → khớp theo số thứ tự cuối mã (không phụ thuộc số 0 đứng đầu), kèm mã phòng / năm nếu có.
 */
export interface CodeFilter {
  exact?: string;
  seq?: number;
  dept?: string;
  year?: number;
}

export function parseCodeFragment(raw: string | null | undefined): CodeFilter | null {
  const text = (raw || "").trim().toUpperCase();
  if (!text) return null;
  if ((text.match(/\//g) || []).length >= 3) return { exact: text.replace(/\s+/g, "") };

  const filter: CodeFilter = {};
  for (const token of text.match(/[A-Z]+|\d+/g) || []) {
    if (/^20\d\d$/.test(token)) filter.year = parseInt(token, 10);
    else if (/^\d+$/.test(token)) filter.seq = parseInt(token, 10);
    else if (DEPT_CODES.includes(token)) filter.dept = token;
  }
  return filter.seq !== undefined ? filter : null;
}

/** Cấp tên tham số (@p1, @p2...) cho 1 request. */
class Params {
  private counter = 0;
  constructor(private request: sql.Request) {}

  add(type: unknown, value: unknown): string {
    const name = `p${++this.counter}`;
    this.request.input(name, type as any, value);
    return `@${name}`;
  }
}

function codeConditions(params: Params, column: string, filter: CodeFilter): string[] {
  if (filter.exact) return [`${column} = ${params.add(sql.NVarChar, filter.exact)}`];

  const conditions: string[] = [];
  if (filter.seq !== undefined) {
    // Số thứ tự = phần sau dấu "/" cuối cùng
    conditions.push(
      `TRY_CAST(RIGHT(${column}, CHARINDEX('/', REVERSE(${column}) + '/') - 1) AS int) = ${params.add(sql.Int, filter.seq)}`
    );
  }
  if (filter.dept) conditions.push(`${column} LIKE ${params.add(sql.NVarChar, `%/${filter.dept}/%`)}`);
  if (filter.year) conditions.push(`${column} LIKE ${params.add(sql.NVarChar, `%/${filter.year}/%`)}`);
  return conditions;
}

/** Gom điều kiện WHERE + tham số cho 1 truy vấn. */
class Where {
  private conditions: string[] = [];
  readonly params: Params;

  constructor(request: sql.Request) {
    this.params = new Params(request);
  }

  add(condition: string) {
    this.conditions.push(condition);
  }

  param(type: unknown, value: unknown): string {
    return this.params.add(type, value);
  }

  code(column: string, filter: CodeFilter | null) {
    if (filter) this.conditions.push(...codeConditions(this.params, column, filter));
  }

  /**
   * Nội dung (một trong các cột) có nhắc tới tài liệu. `patterns` là các mẫu LIKE trên chuỗi đã bỏ dấu
   * phân cách (vd "%FRMITSOPGEN0016%"); khớp một mẫu bất kỳ ở một cột bất kỳ là đủ.
   */
  mentionsDocument(columns: string[], patterns?: string[] | null) {
    if (!patterns || patterns.length === 0) return;
    const alternatives: string[] = [];
    for (const pattern of patterns.slice(0, 12)) {
      const param = this.param(sql.NVarChar, pattern);
      for (const column of columns) alternatives.push(`${sqlSquash(column)} LIKE ${param}`);
    }
    this.add(`(${alternatives.join(" OR ")})`);
  }

  /** Khoảng ngày theo lịch Việt Nam ("YYYY-MM-DD") trên cột lưu UTC. */
  dateRange(column: string, from?: string | null, to?: string | null) {
    const isDate = (s?: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (isDate(from)) {
      this.add(`${column} >= DATEADD(hour, -${VN_OFFSET_HOURS}, ${this.param(sql.DateTime, new Date(`${from}T00:00:00Z`))})`);
    }
    if (isDate(to)) {
      this.add(`${column} < DATEADD(hour, ${24 - VN_OFFSET_HOURS}, ${this.param(sql.DateTime, new Date(`${to}T00:00:00Z`))})`);
    }
  }

  toString(): string {
    return this.conditions.length > 0 ? `WHERE ${this.conditions.join("\n  AND ")}` : "";
  }
}

/** "72" / "72,58" (EmpID) → tên. */
async function resolveEmployeeNames(pool: sql.ConnectionPool, raw: unknown): Promise<string[]> {
  const ids = Array.from(new Set((String(raw ?? "").match(/\d+/g) || []).map(Number))).filter((n) => n > 0);
  if (ids.length === 0) return [];
  const request = pool.request();
  const params = ids.slice(0, 20).map((id, i) => {
    request.input(`e${i}`, sql.Int, id);
    return `@e${i}`;
  });
  const result = await request.query(
    `SELECT FullName FROM LIMS.vw_UserDetails WHERE EmpID IN (${params.join(", ")}) ORDER BY FullName`
  );
  return result.recordset.map((r: any) => personName(r.FullName) as string);
}

// ============== ACTION ITEM ==============

export type ActionItemStatus =
  | "open"
  | "closed"
  | "overdue"
  | "pending_responsible"
  | "pending_hod"
  | "pending_qa"
  | "draft";

export interface ActionItemFilters {
  number?: string | null; // mã action item (đầy đủ hoặc gõ tắt)
  sourceType?: "CCN" | "CAPA" | null;
  sourceNumber?: string | null; // mã CCN / CAPA gốc
  department?: string | null; // mã phòng: IT, QC...
  status?: ActionItemStatus | null;
  person?: string | null; // tên người phụ trách
  keyword?: string | null; // từ khóa trong nội dung
  relatedDocPatterns?: string[] | null; // nội dung có nhắc tới các mã tài liệu này
  createdFrom?: string | null; // YYYY-MM-DD
  createdTo?: string | null;
  // Khoảng ngày ở trên áp vào: ngày tạo (mặc định), hạn hoàn thành, hoặc ngày đóng
  dateField?: DateField | null;
}

const ACTION_ITEM_DATE_COLUMNS: Record<DateField, string> = {
  created: "a.CreatedDate",
  target: "a.TargetDate",
  closed: "a.ClosureDate",
};

const ACTION_ITEM_FROM = `
FROM QualZen_ActionPlan.ActionPlanMaster a
LEFT JOIN UMS.AizantIT_DepartmentMaster d ON d.DeptID = a.ActionPlanDeptID
LEFT JOIN Qzen_AAPL.ChangeControlMaster c ON a.BasedOn = ${AI_BASED_ON_CCN} AND c.CCN_ID = a.BasedID
LEFT JOIN QMS.AizantIT_CAPAMaster p ON a.BasedOn = ${AI_BASED_ON_CAPA} AND p.CAPAID = a.BasedID
LEFT JOIN LIMS.vw_UserDetails rp ON rp.EmpID = a.ResponsiblePerson
LEFT JOIN LIMS.vw_UserDetails hod ON hod.EmpID = a.DeptHOD
LEFT JOIN LIMS.vw_UserDetails qa ON qa.EmpID = a.QA`;

const ACTION_ITEM_COLUMNS = `
  a.ActionPlanMasterID, a.ActionPlanNumber, a.ActionPlanDescription, a.IsTemp,
  d.DepartmentName, d.DeptCode,
  a.CreatedDate, a.TargetDate, a.ClosureDate, a.CurrentStatus,
  (SELECT TOP 1 w.Description FROM QualZen_ActionPlan.ActionPlanWorkFlow w WHERE w.StatusNum = a.CurrentStatus) AS StatusName,
  a.QualityEvent, COALESCE(c.CCN_No, p.CAPA_Number) AS SourceNumber,
  rp.FullName AS ResponsiblePersonName, hod.FullName AS HODName, qa.FullName AS QAName,
  CASE WHEN a.CurrentStatus <> ${AI_STATUS_CLOSED} AND a.TargetDate < GETUTCDATE() THEN 1 ELSE 0 END AS IsOverdue`;

function actionItemWhere(request: sql.Request, f: ActionItemFilters): Where {
  const where = new Where(request);
  const numberFilter = parseCodeFragment(f.number);
  where.code("a.ActionPlanNumber", numberFilter);

  // Phiếu nháp chỉ hiện khi hỏi đích danh
  if (f.status === "draft") where.add("a.IsTemp = 1");
  else where.add("a.IsTemp = 0");

  const inList = (values: number[]) => `a.CurrentStatus IN (${values.join(", ")})`;
  switch (f.status) {
    case "open":
      where.add(`a.CurrentStatus <> ${AI_STATUS_CLOSED}`);
      break;
    case "closed":
      where.add(`a.CurrentStatus = ${AI_STATUS_CLOSED}`);
      break;
    case "overdue":
      where.add(`a.CurrentStatus <> ${AI_STATUS_CLOSED} AND a.TargetDate < GETUTCDATE()`);
      break;
    case "pending_responsible":
      where.add(inList(AI_PENDING_RESPONSIBLE));
      break;
    case "pending_hod":
      where.add(inList(AI_PENDING_HOD));
      break;
    case "pending_qa":
      where.add(inList(AI_PENDING_QA));
      break;
  }

  if (f.sourceType === "CCN") where.add(`a.BasedOn = ${AI_BASED_ON_CCN}`);
  if (f.sourceType === "CAPA") where.add(`a.BasedOn = ${AI_BASED_ON_CAPA}`);

  const sourceFilter = parseCodeFragment(f.sourceNumber);
  if (sourceFilter) {
    // Mã gốc có thể là CCN hoặc CAPA: nếu không nói rõ loại thì thử cả hai
    const alternatives: string[] = [];
    if (f.sourceType !== "CAPA") alternatives.push(codeConditions(where.params, "c.CCN_No", sourceFilter).join(" AND "));
    if (f.sourceType !== "CCN") alternatives.push(codeConditions(where.params, "p.CAPA_Number", sourceFilter).join(" AND "));
    where.add(`(${alternatives.map((alt) => `(${alt})`).join(" OR ")})`);
  }

  if (f.department && DEPT_CODES.includes(f.department.toUpperCase())) {
    where.add(`d.DeptCode = ${where.param(sql.NVarChar, f.department.toUpperCase())}`);
  }
  if (f.person?.trim()) {
    where.add(
      `rp.FullName COLLATE Latin1_General_100_CI_AI LIKE ${where.param(sql.NVarChar, likePattern(stripDiacritics(f.person.trim())))}`
    );
  }
  if (f.keyword?.trim()) {
    where.add(`a.ActionPlanDescription LIKE ${where.param(sql.NVarChar, likePattern(f.keyword.trim()))}`);
  }
  where.mentionsDocument(["a.ActionPlanDescription"], f.relatedDocPatterns);
  where.dateRange(ACTION_ITEM_DATE_COLUMNS[f.dateField ?? "created"], f.createdFrom, f.createdTo);
  return where;
}

function pendingWith(row: any, nextActionNames: string[]): string | null {
  if (row.IsTemp) return "Chưa phát hành (phiếu nháp, chờ sự kiện gốc được duyệt)";
  if (row.CurrentStatus === AI_STATUS_CLOSED) return null;
  if (nextActionNames.length > 0) return nextActionNames.join(", ");
  if (AI_PENDING_RESPONSIBLE.includes(row.CurrentStatus)) return personName(row.ResponsiblePersonName);
  if (AI_PENDING_HOD.includes(row.CurrentStatus)) return personName(row.HODName);
  if (AI_PENDING_QA.includes(row.CurrentStatus)) return personName(row.QAName);
  return null;
}

// Vai trò của người đang giữ phiếu, suy từ trạng thái
function pendingStep(status: number): string | null {
  if (AI_PENDING_RESPONSIBLE.includes(status)) return "Người phụ trách thực hiện / nộp bằng chứng";
  if (AI_PENDING_HOD.includes(status)) return "Trưởng bộ phận (HOD) review";
  if (AI_PENDING_QA.includes(status)) return "QA phê duyệt đóng";
  if (status === AI_STATUS_CLOSED) return "Đã đóng";
  return null;
}

function mapActionItem(row: any, textChars: number) {
  return {
    maActionItem: row.IsTemp ? "(nháp, chưa có số)" : row.ActionPlanNumber,
    noiDung: clip(row.ActionPlanDescription, textChars),
    phongBan: row.DepartmentName ? `${row.DepartmentName} (${row.DeptCode})` : null,
    thuocSuKien: row.SourceNumber ? `${row.QualityEvent} ${row.SourceNumber}` : row.QualityEvent,
    trangThai: row.StatusName || `Mã trạng thái ${row.CurrentStatus}`,
    buocHienTai: pendingStep(row.CurrentStatus),
    quaHan: !!row.IsOverdue,
    ngayTao: formatDate(row.CreatedDate),
    hanHoanThanh: formatDate(row.TargetDate),
    ngayDong: formatDate(row.ClosureDate),
    nguoiPhuTrach: personName(row.ResponsiblePersonName),
    truongBoPhan: personName(row.HODName),
    qa: personName(row.QAName),
  };
}

export async function searchActionItems(
  pool: sql.ConnectionPool,
  filters: ActionItemFilters,
  limit = DEFAULT_LIST_LIMIT,
  textChars = LIST_TEXT_CHARS
) {
  const countRequest = pool.request();
  const countWhere = actionItemWhere(countRequest, filters);
  const summary = (
    await countRequest.query(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN a.CurrentStatus = ${AI_STATUS_CLOSED} THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN a.CurrentStatus <> ${AI_STATUS_CLOSED} THEN 1 ELSE 0 END) AS openCount,
        SUM(CASE WHEN a.CurrentStatus <> ${AI_STATUS_CLOSED} AND a.TargetDate < GETUTCDATE() THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN a.CurrentStatus IN (${AI_PENDING_RESPONSIBLE.join(", ")}) THEN 1 ELSE 0 END) AS pendingResponsible,
        SUM(CASE WHEN a.CurrentStatus IN (${AI_PENDING_HOD.join(", ")}) THEN 1 ELSE 0 END) AS pendingHod,
        SUM(CASE WHEN a.CurrentStatus IN (${AI_PENDING_QA.join(", ")}) THEN 1 ELSE 0 END) AS pendingQa,
        SUM(CASE WHEN a.CurrentStatus <> ${AI_STATUS_CLOSED} AND a.TargetDate IS NULL THEN 1 ELSE 0 END) AS openNoTarget
      ${ACTION_ITEM_FROM}
      ${countWhere}`)
  ).recordset[0];

  const listRequest = pool.request();
  const listWhere = actionItemWhere(listRequest, filters);
  listRequest.input("limit", sql.Int, limit);
  // Phiếu đang mở lên trước: quá hạn lâu nhất / hạn gần nhất đứng đầu, phiếu chưa có hạn xếp sau; rồi tới phiếu đã đóng
  const rows = (
    await listRequest.query(`
      SELECT TOP (@limit) ${ACTION_ITEM_COLUMNS}
      ${ACTION_ITEM_FROM}
      ${listWhere}
      ORDER BY CASE WHEN a.CurrentStatus = ${AI_STATUS_CLOSED} THEN 1 ELSE 0 END,
        CASE WHEN a.CurrentStatus <> ${AI_STATUS_CLOSED} AND a.TargetDate IS NULL THEN 1 ELSE 0 END,
        CASE WHEN a.CurrentStatus = ${AI_STATUS_CLOSED} THEN NULL ELSE a.TargetDate END ASC,
        a.CreatedDate DESC`)
  ).recordset;

  return {
    tongSo: summary.total as number,
    thongKe: {
      dangMo: summary.openCount ?? 0,
      daDong: summary.closed ?? 0,
      quaHan: summary.overdue ?? 0,
      choNguoiPhuTrach: summary.pendingResponsible ?? 0,
      choHodReview: summary.pendingHod ?? 0,
      choQaDuyet: summary.pendingQa ?? 0,
      dangMoChuaCoHan: summary.openNoTarget ?? 0,
    },
    soDongHienThi: rows.length,
    danhSach: rows.map((row: any) => mapActionItem(row, textChars)),
    _rows: rows,
  };
}

/** Chi tiết 1 action item: thông tin + toàn bộ lịch sử xử lý + đang chờ ai. */
export async function getActionItemDetail(pool: sql.ConnectionPool, row: any) {
  const history = (
    await pool.request().input("id", sql.Int, row.ActionPlanMasterID).query(`
      SELECT h.ActionDate, h.ActionPlanHistoryStatusID, s.StatusDescription, e.FullName AS ActionByName,
        r.RoleName, h.NextActionBy, h.Remarks
      FROM QualZen_ActionPlan.ActionPlanHistory h
      LEFT JOIN QualZen_ActionPlan.ActionPlanHistoryStatus s ON s.ActionPlanHistoryStatusID = h.ActionPlanHistoryStatusID
      LEFT JOIN LIMS.vw_UserDetails e ON e.EmpID = h.ActionBy
      LEFT JOIN UMS.AizantIT_Roles r ON r.RoleID = h.ActionRole
      WHERE h.ActionPlanMasterID = @id
      ORDER BY h.ActionDate ASC, h.ActionPlanHistoryID ASC`)
  ).recordset;

  const last = history[history.length - 1];
  const nextNames = last ? await resolveEmployeeNames(pool, last.NextActionBy) : [];

  return {
    ...mapActionItem(row, DETAIL_TEXT_CHARS),
    dangChoAi: pendingWith(row, nextNames),
    lichSuXuLy: history.map((h: any) => ({
      thoiGian: formatDate(h.ActionDate),
      hanhDong: h.StatusDescription || null,
      nguoiThucHien: h.ActionByName ? `${personName(h.ActionByName)}${h.RoleName ? ` (${h.RoleName})` : ""}` : null,
      ghiChu: clip(h.Remarks, LIST_TEXT_CHARS),
    })),
  };
}

// ============== CCN (Change Control) ==============

export interface CcnFilters {
  number?: string | null;
  relatedDocPatterns?: string[] | null; // đề xuất thay đổi có nhắc tới các mã tài liệu này
  department?: string | null;
  person?: string | null; // người khởi tạo
  keyword?: string | null;
  createdFrom?: string | null;
  createdTo?: string | null;
}

const CCN_FROM = `
FROM Qzen_AAPL.ChangeControlMaster c
LEFT JOIN UMS.AizantIT_DepartmentMaster d ON d.DeptID = c.DeptID
LEFT JOIN Qzen_AAPL.CCN_ObjectStatus s ON s.StatusID = c.CurrentStatus
LEFT JOIN LIMS.vw_UserDetails ini ON ini.EmpID = c.Initiator_EmpID
LEFT JOIN LIMS.vw_UserDetails hod ON hod.EmpID = c.HOD_EmpID
LEFT JOIN LIMS.vw_UserDetails qa ON qa.EmpID = c.QA_EmpID
LEFT JOIN LIMS.vw_UserDetails hqa ON hqa.EmpID = c.HeadQA_EmpID`;

// Các ô nội dung của CCN nơi người soạn ghi tài liệu bị thay đổi
const CCN_TEXT_COLUMNS = [
  "c.ProposedChanges",
  "c.ExistingProcedure",
  "c.DocumentProposedChange",
  "c.ShortChangeDescription",
  "c.ReasonforproposedChange",
];

function ccnWhere(request: sql.Request, f: CcnFilters): Where {
  const where = new Where(request);
  where.code("c.CCN_No", parseCodeFragment(f.number));
  if (f.department && DEPT_CODES.includes(f.department.toUpperCase())) {
    where.add(`d.DeptCode = ${where.param(sql.NVarChar, f.department.toUpperCase())}`);
  }
  if (f.person?.trim()) {
    where.add(
      `ini.FullName COLLATE Latin1_General_100_CI_AI LIKE ${where.param(sql.NVarChar, likePattern(stripDiacritics(f.person.trim())))}`
    );
  }
  if (f.keyword?.trim()) {
    const p = where.param(sql.NVarChar, likePattern(f.keyword.trim()));
    where.add(`(c.ProposedChanges LIKE ${p} OR c.ShortChangeDescription LIKE ${p} OR c.ExistingProcedure LIKE ${p})`);
  }
  where.mentionsDocument(CCN_TEXT_COLUMNS, f.relatedDocPatterns);
  where.dateRange("c.CCN_Date", f.createdFrom, f.createdTo);
  return where;
}

function mapCcn(row: any, textChars: number) {
  return {
    maCCN: row.CCN_No,
    phongBan: row.DepartmentName ? `${row.DepartmentName} (${row.DeptCode})` : null,
    trangThai: row.StatusName || `Mã trạng thái ${row.CurrentStatus}`,
    ngayTao: formatDate(row.CCN_Date),
    hanHoanThanh: formatDate(row.TargetDate),
    thayDoiDeXuat: clip(row.ProposedChanges, textChars),
    lyDo: clip(row.ReasonforproposedChange, textChars),
    hienTrang: clip(row.ShortChangeDescription, textChars),
    quyTrinhHienTai: clip(row.ExistingProcedure, textChars),
    taiLieuThayDoi: clip(row.DocumentProposedChange, textChars),
    nguoiKhoiTao: personName(row.InitiatorName),
    truongBoPhan: personName(row.HODName),
    qa: personName(row.QAName),
    headQA: personName(row.HeadQAName),
    soActionItem: row.ActionItemCount,
    soActionItemChuaDong: row.OpenActionItemCount,
  };
}

export async function searchCcns(
  pool: sql.ConnectionPool,
  filters: CcnFilters,
  limit = DEFAULT_LIST_LIMIT,
  textChars = LIST_TEXT_CHARS
) {
  const countRequest = pool.request();
  const total = (await countRequest.query(`SELECT COUNT(*) AS total ${CCN_FROM} ${ccnWhere(countRequest, filters)}`))
    .recordset[0].total as number;

  const listRequest = pool.request();
  const where = ccnWhere(listRequest, filters);
  listRequest.input("limit", sql.Int, limit);
  const rows = (
    await listRequest.query(`
      SELECT TOP (@limit) c.CCN_ID, c.CCN_No, c.CCN_Date, c.TargetDate, c.CurrentStatus, s.StatusName,
        c.ProposedChanges, c.ReasonforproposedChange, c.ShortChangeDescription, c.ExistingProcedure, c.DocumentProposedChange,
        d.DepartmentName, d.DeptCode,
        ini.FullName AS InitiatorName, hod.FullName AS HODName, qa.FullName AS QAName, hqa.FullName AS HeadQAName,
        (SELECT COUNT(*) FROM QualZen_ActionPlan.ActionPlanMaster a
          WHERE a.BasedOn = ${AI_BASED_ON_CCN} AND a.BasedID = c.CCN_ID AND a.IsTemp = 0) AS ActionItemCount,
        (SELECT COUNT(*) FROM QualZen_ActionPlan.ActionPlanMaster a
          WHERE a.BasedOn = ${AI_BASED_ON_CCN} AND a.BasedID = c.CCN_ID AND a.IsTemp = 0
            AND a.CurrentStatus <> ${AI_STATUS_CLOSED}) AS OpenActionItemCount
      ${CCN_FROM}
      ${where}
      ORDER BY c.CCN_Date DESC`)
  ).recordset;

  return { tongSo: total, soDongHienThi: rows.length, danhSach: rows.map((r: any) => mapCcn(r, textChars)), _rows: rows };
}

export async function getCcnDetail(pool: sql.ConnectionPool, row: any) {
  const history = (
    await pool.request().input("id", sql.Int, row.CCN_ID).query(`
      SELECT TOP 8 h.ActionDate, e.FullName AS ActionByName, r.RoleName,
        h.Comments, h.AssignedTo, ar.RoleName AS AssignedRoleName
      FROM Qzen_AAPL.ChangeControlHistory h
      LEFT JOIN LIMS.vw_UserDetails e ON e.EmpID = h.ActionBy
      LEFT JOIN UMS.AizantIT_Roles r ON r.RoleID = h.RoleID
      LEFT JOIN UMS.AizantIT_Roles ar ON ar.RoleID = h.AssignedToRoleID
      WHERE h.CCNID = @id
      ORDER BY h.ActionDate DESC, h.CCNHistoryID DESC`)
  ).recordset;

  const last = history[0];
  const assignedNames = last ? await resolveEmployeeNames(pool, last.AssignedTo) : [];
  const actionItems = await searchActionItems(pool, { sourceType: "CCN", sourceNumber: row.CCN_No }, 30);

  return {
    ...mapCcn(row, DETAIL_TEXT_CHARS),
    dangChoAi:
      assignedNames.length > 0
        ? `${assignedNames.join(", ")}${last.AssignedRoleName ? ` (${last.AssignedRoleName})` : ""}`
        : null,
    lichSuGanNhat: history.reverse().map((h: any) => ({
      thoiGian: formatDate(h.ActionDate),
      nguoiThucHien: h.ActionByName ? `${personName(h.ActionByName)}${h.RoleName ? ` (${h.RoleName})` : ""}` : null,
      ghiChu: clip(h.Comments, LIST_TEXT_CHARS),
    })),
    actionItems: { tongSo: actionItems.tongSo, thongKe: actionItems.thongKe, danhSach: actionItems.danhSach },
  };
}

// ============== CAPA ==============

export interface CapaFilters {
  number?: string | null;
  relatedDocPatterns?: string[] | null;
  sourceEventNumber?: string | null; // mã sự kiện gốc: DR/..., LIR/..., OOS/...
  keyword?: string | null;
  createdFrom?: string | null;
  createdTo?: string | null;
}

const CAPA_FROM = `
FROM QMS.AizantIT_CAPAMaster p
LEFT JOIN QMS.AizantIT_CAPA_ActionPlan ap ON ap.CAPAID = p.CAPAID
LEFT JOIN UMS.AizantIT_DepartmentMaster d ON d.DeptID = ap.Capa_Action_Imp_DeptID
LEFT JOIN LIMS.vw_UserDetails hod ON hod.EmpID = p.HOD_EmpID
LEFT JOIN LIMS.vw_UserDetails qa ON qa.EmpID = p.QA_EmpID
LEFT JOIN LIMS.vw_UserDetails hqa ON hqa.EmpID = p.HeadQA_EmpID
LEFT JOIN LIMS.vw_UserDetails cr ON cr.EmpID = p.CreatedBy`;

function capaWhere(request: sql.Request, f: CapaFilters): Where {
  const where = new Where(request);
  where.add("ISNULL(p.isTemp, 0) = 0");
  where.code("p.CAPA_Number", parseCodeFragment(f.number));
  const source = parseCodeFragment(f.sourceEventNumber);
  if (source?.exact) where.add(`p.QualityEvent_Number = ${where.param(sql.NVarChar, source.exact)}`);
  if (f.keyword?.trim()) {
    const p = where.param(sql.NVarChar, likePattern(f.keyword.trim()));
    where.add(`(ap.RootCause_Details LIKE ${p} OR ap.Capa_ActionDesc LIKE ${p} OR ap.QEorNCorOthers LIKE ${p})`);
  }
  where.mentionsDocument(["ap.RootCause_Details", "ap.Capa_ActionDesc", "ap.QEorNCorOthers"], f.relatedDocPatterns);
  where.dateRange("p.CAPA_Date", f.createdFrom, f.createdTo);
  return where;
}

function mapCapa(row: any, textChars: number) {
  return {
    maCAPA: row.CAPA_Number || "(chưa được cấp số)",
    ngayTao: formatDate(row.CAPA_Date),
    suKienGoc: row.QualityEvent_Number,
    phongBanThucHien: row.DepartmentName ? `${row.DepartmentName} (${row.DeptCode})` : null,
    hanHoanThanh: formatDate(row.ActionPlan_TimeLines),
    moTaSuKien: clip(row.QEorNCorOthers, textChars),
    nguyenNhanGoc: clip(row.RootCause_Details, textChars),
    danhGiaAnhHuong: clip(row.Impact_Risk_Assessment, textChars),
    nguoiTao: personName(row.CreatedByName),
    truongBoPhan: personName(row.HODName),
    qa: personName(row.QAName),
    headQA: personName(row.HeadQAName),
    soActionItem: row.ActionItemCount,
    soActionItemChuaDong: row.OpenActionItemCount,
  };
}

export async function searchCapas(
  pool: sql.ConnectionPool,
  filters: CapaFilters,
  limit = DEFAULT_LIST_LIMIT,
  textChars = LIST_TEXT_CHARS
) {
  const countRequest = pool.request();
  const total = (
    await countRequest.query(`SELECT COUNT(DISTINCT p.CAPAID) AS total ${CAPA_FROM} ${capaWhere(countRequest, filters)}`)
  ).recordset[0].total as number;

  const listRequest = pool.request();
  const where = capaWhere(listRequest, filters);
  listRequest.input("limit", sql.Int, limit);
  const rows = (
    await listRequest.query(`
      SELECT TOP (@limit) p.CAPAID, p.CAPA_Number, p.CAPA_Date, p.QualityEvent_Number,
        ap.ActionPlan_TimeLines, ap.QEorNCorOthers, ap.RootCause_Details, ap.Impact_Risk_Assessment,
        d.DepartmentName, d.DeptCode,
        cr.FullName AS CreatedByName, hod.FullName AS HODName, qa.FullName AS QAName, hqa.FullName AS HeadQAName,
        (SELECT COUNT(*) FROM QualZen_ActionPlan.ActionPlanMaster a
          WHERE a.BasedOn = ${AI_BASED_ON_CAPA} AND a.BasedID = p.CAPAID AND a.IsTemp = 0) AS ActionItemCount,
        (SELECT COUNT(*) FROM QualZen_ActionPlan.ActionPlanMaster a
          WHERE a.BasedOn = ${AI_BASED_ON_CAPA} AND a.BasedID = p.CAPAID AND a.IsTemp = 0
            AND a.CurrentStatus <> ${AI_STATUS_CLOSED}) AS OpenActionItemCount
      ${CAPA_FROM}
      ${where}
      ORDER BY p.CAPA_Date DESC`)
  ).recordset;

  return { tongSo: total, soDongHienThi: rows.length, danhSach: rows.map((r: any) => mapCapa(r, textChars)), _rows: rows };
}

export async function getCapaDetail(pool: sql.ConnectionPool, row: any) {
  const history = (
    await pool.request().input("id", sql.Int, row.CAPAID).query(`
      SELECT TOP 8 h.SignDate, e.FullName AS ActionByName, r.RoleName, h.Comments, h.AssignedTo, ar.RoleName AS AssignedRoleName
      FROM QMS.AizantIT_Capa_History h
      LEFT JOIN LIMS.vw_UserDetails e ON e.EmpID = h.EmpID
      LEFT JOIN UMS.AizantIT_Roles r ON r.RoleID = h.Role
      LEFT JOIN UMS.AizantIT_Roles ar ON ar.RoleID = h.AssignedToRoleID
      WHERE h.CapaID = @id
      ORDER BY h.SignDate DESC, h.UniqueID DESC`)
  ).recordset;

  const last = history[0];
  const assignedNames = last ? await resolveEmployeeNames(pool, last.AssignedTo) : [];
  const actionItems = await searchActionItems(pool, { sourceType: "CAPA", sourceNumber: row.CAPA_Number }, 30);

  return {
    ...mapCapa(row, DETAIL_TEXT_CHARS),
    dangChoAi:
      assignedNames.length > 0
        ? `${assignedNames.join(", ")}${last.AssignedRoleName ? ` (${last.AssignedRoleName})` : ""}`
        : null,
    lichSuGanNhat: history.reverse().map((h: any) => ({
      thoiGian: formatDate(h.SignDate),
      nguoiThucHien: h.ActionByName ? `${personName(h.ActionByName)}${h.RoleName ? ` (${h.RoleName})` : ""}` : null,
      ghiChu: clip(h.Comments, LIST_TEXT_CHARS),
    })),
    actionItems: { tongSo: actionItems.tongSo, thongKe: actionItems.thongKe, danhSach: actionItems.danhSach },
  };
}

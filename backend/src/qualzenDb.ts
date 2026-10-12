import sql from "mssql";

/**
 * Kết nối tới SQL Server của QualZen (CCN, Action Item, Deviation, CAPA, Lab Incident).
 * Chỉ ĐỌC: tài khoản cấu hình ở đây phải là tài khoản chỉ có quyền SELECT - không dùng `sa`.
 */

export interface QualzenSettings {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
}

/** Đọc cấu hình từ biến môi trường. Trả về null nếu chưa cấu hình (tính năng QualZen tắt). */
export function qualzenSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): QualzenSettings | null {
  const { QUALZEN_DB_SERVER, QUALZEN_DB_NAME, QUALZEN_DB_USER, QUALZEN_DB_PASSWORD } = env;
  if (!QUALZEN_DB_SERVER || !QUALZEN_DB_NAME || !QUALZEN_DB_USER || !QUALZEN_DB_PASSWORD) {
    return null;
  }
  return {
    server: QUALZEN_DB_SERVER,
    port: parseInt(env.QUALZEN_DB_PORT || "1433", 10),
    database: QUALZEN_DB_NAME,
    user: QUALZEN_DB_USER,
    password: QUALZEN_DB_PASSWORD,
    encrypt: env.QUALZEN_DB_ENCRYPT === "true",
  };
}

let sharedPool: Promise<sql.ConnectionPool> | null = null;

/** Pool dùng chung của server, kết nối khi có câu hỏi đầu tiên. Lỗi kết nối → lần sau thử lại. */
export function getQualzenPool(): Promise<sql.ConnectionPool> {
  if (!sharedPool) {
    const settings = qualzenSettingsFromEnv();
    if (!settings) return Promise.reject(new Error("QualZen chưa được cấu hình (QUALZEN_DB_*)"));

    sharedPool = connectQualzen(settings).then((pool) => {
      pool.on("error", (err) => {
        console.error("QualZen pool error:", err.message);
        sharedPool = null;
      });
      return pool;
    });
    sharedPool.catch(() => {
      sharedPool = null;
    });
  }
  return sharedPool;
}

export async function connectQualzen(settings: QualzenSettings): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool({
    server: settings.server,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    connectionTimeout: 15000,
    requestTimeout: 30000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: settings.encrypt,
      // SQL Server nội bộ thường dùng chứng chỉ tự ký
      trustServerCertificate: true,
      readOnlyIntent: true,
      appName: "sop-ai-assistant",
    },
  });
  return pool.connect();
}

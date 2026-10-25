import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlDays: number;
  workerId: number;
  heartbeatIntervalMs: number;
  /** Thời gian giữ session sau khi ngắt để resume (spec §4.1). */
  sessionTtlMs: number;
  maxReplayEvents: number;
  migrationsDir: string;
  /** Bỏ trống = suy ra từ request (tiện dev). Production nên đặt tường minh. */
  gatewayPublicUrl: string | null;
  /** Nơi lưu file tải lên (đĩa cục bộ ở G1; đổi sang R2/S3 thì chỉ thay lớp storage). */
  uploadsDir: string;
  /** Trần kích thước một file — 10MB theo ROADMAP §1.4 (free tier). */
  maxUploadBytes: number;
  /** `SMTP_URL` (vd `smtps://user:pass@smtp.example.com:465`). Bỏ trống = ghi mail ra log (dev). */
  smtpUrl: string | null;
  /** Địa chỉ gửi, hiện trong From của mail xác thực. */
  mailFrom: string;
  /** Gốc của web app — dùng để dựng link trong mail. */
  publicWebUrl: string;
  /** Hạn của link xác thực email. */
  emailVerificationTtlHours: number;
  /** Khoảng cách tối thiểu giữa hai lần gửi lại cho cùng một tài khoản. */
  emailVerificationResendCooldownSec: number;
  /**
   * Trả token xác thực thẳng trong response (dev/test) để xác thực được khi
   * chưa có SMTP. Production mặc định TẮT — bật sẽ cho phép chiếm tài khoản.
   */
  emailVerificationEcho: boolean;
  /**
   * Ai được xem hàng đợi báo cáo vi phạm (`/admin/reports`).
   *
   * `ADMIN_USER_IDS` = danh sách snowflake, `ADMIN_USERNAMES` = danh sách
   * username, phân tách bằng dấu phẩy. Để trống = **không ai** là admin (an
   * toàn mặc định: quên cấu hình thì đóng, không mở nhầm).
   */
  adminUserIds: string[];
  adminUsernames: string[];
  logger: boolean;
}

/** Tách danh sách phân tách bằng dấu phẩy, bỏ khoảng trắng và phần tử rỗng. */
function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const DEFAULT_DEV_DATABASE_URL = "postgres://umaru:umaru@127.0.0.1:55432/umaru";
const DEV_JWT_SECRET = "umaru-dev-insecure-secret";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === "production";
  const jwtSecret = env.JWT_SECRET ?? DEV_JWT_SECRET;
  if (isProduction && jwtSecret === DEV_JWT_SECRET) {
    throw new Error("JWT_SECRET bắt buộc phải đặt trong production");
  }

  const workerId = Number(env.SNOWFLAKE_WORKER_ID ?? "0");
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) {
    throw new Error("SNOWFLAKE_WORKER_ID phải là số nguyên trong [0, 1023]");
  }

  return {
    port: Number(env.PORT ?? "4000"),
    host: env.HOST ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL,
    jwtSecret,
    accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? "900"),
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? "30"),
    workerId,
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? "41250"),
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? String(5 * 60 * 1000)),
    maxReplayEvents: Number(env.MAX_REPLAY_EVENTS ?? "2000"),
    migrationsDir:
      env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../../db/migrations/", import.meta.url)),
    gatewayPublicUrl: env.GATEWAY_PUBLIC_URL ?? null,
    uploadsDir:
      env.UPLOADS_DIR ?? fileURLToPath(new URL("../.data/uploads/", import.meta.url)),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? String(10 * 1024 * 1024)),
    smtpUrl: env.SMTP_URL ?? null,
    mailFrom: env.MAIL_FROM ?? "Umaru <no-reply@umaru.local>",
    publicWebUrl: env.PUBLIC_WEB_URL ?? "http://localhost:5173",
    emailVerificationTtlHours: Number(env.EMAIL_VERIFICATION_TTL_HOURS ?? "24"),
    emailVerificationResendCooldownSec: Number(
      env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC ?? "60",
    ),
    adminUserIds: splitList(env.ADMIN_USER_IDS),
    adminUsernames: splitList(env.ADMIN_USERNAMES).map((name) => name.toLowerCase()),
    emailVerificationEcho: env.EMAIL_VERIFICATION_ECHO
      ? env.EMAIL_VERIFICATION_ECHO !== "0"
      : !isProduction,
    logger: env.NODE_ENV !== "test" && env.LOG_LEVEL !== "silent",
  };
}

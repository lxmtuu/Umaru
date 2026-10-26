import path from "node:path";
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
  /** Nén frame gateway (`permessage-deflate`); tắt bằng `GATEWAY_COMPRESS=off`. */
  gatewayCompress: boolean;
  /** Frame nhỏ hơn mức này (byte) không nén — nén frame 80 byte là lỗ. */
  gatewayCompressThreshold: number;
  maxReplayEvents: number;
  migrationsDir: string;
  /** Bỏ trống = suy ra từ request (tiện dev). Production nên đặt tường minh. */
  gatewayPublicUrl: string | null;
  /** Nơi lưu file tải lên (đĩa cục bộ ở G1; đổi sang R2/S3 thì chỉ thay lớp storage). */
  uploadsDir: string;
  /** Trần kích thước một file — 10MB theo ROADMAP §1.4 (free tier). */
  maxUploadBytes: number;
  /** Thư mục riêng cho avatar (mặc định `<uploadsDir>/avatars`). */
  avatarsDir: string;
  /** Trần kích thước ảnh đại diện — nhỏ hơn tệp đính kèm vì đây là ảnh hiển thị. */
  maxAvatarBytes: number;
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
  /**
   * Gửi mail báo cho admin khi có báo cáo vi phạm mới (`REPORT_NOTIFY_EMAIL`,
   * mặc định bật; đặt `off`/`false`/`0` để tắt). Không cấu hình admin thì
   * không gửi cho ai.
   */
  reportNotifyEmail: boolean;
  /** Giãn cách tối thiểu giữa hai mail báo cáo (giây), chống dội hộp thư. */
  reportNotifyCooldownSec: number;
  /**
   * Bật rate limit theo spec §7 (`RATE_LIMITS`, mặc định **bật**).
   *
   * Tắt được cho test/bench, nhưng production phải để bật: đây là hàng rào duy
   * nhất chống spam tin nhắn và flood frame qua gateway.
   */
  rateLimitsEnabled: boolean;
  /** Số tin một người gửi được vào **một kênh** trong 5 giây (spec §7: 5). */
  rateLimitMessagesPerUser: number;
  /** Số tin **cả kênh** nhận được trong 1 phút (spec §7: 30). */
  rateLimitMessagesPerChannel: number;
  /** Số frame client → server mỗi phút trên một socket (spec §7: 120). */
  rateLimitGatewayFramesPerMinute: number;
  /** Số session đồng thời của một user (spec §7: 5, vượt thì đóng session cũ nhất). */
  rateLimitSessionsPerUser: number;
  /** Số lần join/leave/mute kênh thoại mỗi 10 giây của một user. */
  rateLimitVoiceMutations: number;
  /**
   * Số lần **đăng nhập sai** mỗi 15 phút cho một IP, và cho một email.
   *
   * Hai bộ đếm độc lập vì hai kiểu tấn công khác nhau: một IP thử nhiều email
   * (dò tài khoản) và nhiều IP thử một email (dò mật khẩu). Chỉ giới hạn theo
   * email thì kẻ tấn công đổi email mỗi lần; chỉ theo IP thì botnet đi qua.
   *
   * Riêng băm mật khẩu (argon2id) đã đủ đắt để một luồng request vô hạn thành
   * DoS CPU, nên đây cũng là hàng rào tài nguyên chứ không chỉ bảo mật.
   */
  rateLimitAuthPerIp: number;
  rateLimitAuthPerEmail: number;
  /**
   * Tin `X-Forwarded-For`/`X-Forwarded-Proto` từ proxy đứng trước (mặc định
   * **tắt**).
   *
   * Bật khi chạy sau nginx/Caddy/ALB. Tắt thì `request.ip` là IP của proxy nên
   * rate limit theo IP gộp cả thế giới vào một bộ đếm — người dùng thật bị chặn
   * oan. Bật mà **không** có proxy thì client tự khai IP của mình → vô hiệu hoá
   * rate limit. Vì vậy đây là cấu hình tường minh, không phải "tự đoán".
   */
  trustProxy: boolean;
  /**
   * LiveKit (SFU cho âm thanh kênh thoại). `null` = **chưa cấu hình** →
   * `GET /channels/:id/voice/token` trả 503 và client chỉ hiện trạng thái
   * (vẫn join/leave phòng được, chỉ không có tiếng). Không có giá trị mặc định
   * nào cho secret: thiếu là tắt hẳn, không phải "chạy với key rỗng".
   */
  livekit: { url: string; apiKey: string; apiSecret: string } | null;
  /** Hạn của token phòng thoại (giây) — client xin token mới trước khi hết hạn. */
  livekitTokenTtlSec: number;
  /**
   * Web Push (VAPID) — thông báo khi **đã đóng tab**. `null` = chưa cấu hình:
   * `POST /push/subscriptions` trả 503 và không có push nào được gửi. Client
   * không được coi đó là lỗi của mình (khác hẳn "quyền thông báo bị chặn").
   */
  push: { publicKey: string; privateKey: string; subject: string } | null;
  /** Giãn cách tối thiểu giữa hai push cho cùng một người (giây), chống dội. */
  pushCooldownSec: number;
  /**
   * Nơi lưu tệp đính kèm + avatar. `null` = đĩa cục bộ (`UPLOADS_DIR`).
   *
   * Bật bằng `STORAGE_DRIVER=s3` + đủ `S3_BUCKET`, `S3_ENDPOINT`,
   * `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Thiếu một biến là **ném lỗi
   * lúc khởi động** thay vì lặng lẽ ghi ra đĩa: chạy nửa cấu hình thì tệp của
   * người dùng nằm ở nơi không ai ngờ và biến mất ở lần deploy sau.
   */
  storage: S3Config | null;
  logger: boolean;
}

/** Cấu hình object storage tương thích S3 (Cloudflare R2, S3, MinIO…). */
export interface S3Config {
  bucket: string;
  /** Gốc endpoint, vd `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /** `auto` cho R2; `us-east-1` cho S3/MinIO mặc định. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Tiền tố chung cho mọi khoá, vd `umaru`. Rỗng = đặt ở gốc bucket. */
  prefix: string;
}

/** `off`/`false`/`0`/`no` = tắt; bỏ trống = bật (mặc định an toàn cho tính năng báo cáo). */
function isOff(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
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

/**
 * Ba biến `LIVEKIT_*` phải có **đủ cả ba**; thiếu một cái là tắt tính năng âm
 * thanh. Cố tình không đoán/không dùng default: nửa cấu hình sẽ sinh token
 * không dùng được và lỗi hiện ra ở client như "phòng hỏng" chứ không phải
 * "server thiếu cấu hình".
 */
function readLiveKit(env: NodeJS.ProcessEnv): Config["livekit"] {
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

/**
 * Ba biến VAPID. Khoá công khai/riêng tư phải có **đủ cả hai**; subject lấy mặc
 * định nhưng production nên đặt thành `mailto:` của mình — dịch vụ push dùng nó
 * để liên hệ khi bạn gửi rác.
 */
function readPush(env: NodeJS.ProcessEnv): Config["push"] {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:admin@example.com";
  return { publicKey, privateKey, subject };
}

/**
 * Đọc cấu hình object storage.
 *
 * Ba trạng thái, cố ý **không** có trạng thái thứ tư:
 *   - `STORAGE_DRIVER` trống/`local` → `null` (đĩa cục bộ).
 *   - `STORAGE_DRIVER=s3` + đủ biến → cấu hình dùng được.
 *   - `STORAGE_DRIVER=s3` thiếu biến → **ném lỗi**. Không đoán, không lùi về
 *     đĩa cục bộ: lùi im lặng nghĩa là tệp đi vào volume của container và mất
 *     sau lần deploy kế tiếp, còn người vận hành thì tưởng đã bật object storage.
 *   - `STORAGE_DRIVER` lạ → ném lỗi (gõ sai `S3` hay `r2` là chuyện thường).
 */
function readStorage(env: NodeJS.ProcessEnv): S3Config | null {
  const driver = (env.STORAGE_DRIVER ?? "local").trim().toLowerCase();
  if (driver === "" || driver === "local" || driver === "disk") return null;
  if (driver !== "s3") {
    throw new Error(
      `STORAGE_DRIVER="${env.STORAGE_DRIVER}" không hợp lệ — chỉ nhận "local" hoặc "s3"`,
    );
  }

  const bucket = env.S3_BUCKET?.trim();
  const endpoint = env.S3_ENDPOINT?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  const missing = [
    bucket === undefined || bucket.length === 0 ? "S3_BUCKET" : null,
    endpoint === undefined || endpoint.length === 0 ? "S3_ENDPOINT" : null,
    accessKeyId === undefined || accessKeyId.length === 0 ? "S3_ACCESS_KEY_ID" : null,
    secretAccessKey === undefined || secretAccessKey.length === 0
      ? "S3_SECRET_ACCESS_KEY"
      : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=s3 nhưng thiếu ${missing.join(", ")} — ` +
        "đặt đủ biến hoặc bỏ STORAGE_DRIVER để dùng đĩa cục bộ",
    );
  }

  return {
    bucket: bucket ?? "",
    endpoint: endpoint ?? "",
    region: env.S3_REGION?.trim() || "auto",
    accessKeyId: accessKeyId ?? "",
    secretAccessKey: secretAccessKey ?? "",
    prefix: (env.S3_PREFIX ?? "umaru").trim().replace(/^\/+|\/+$/g, ""),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === "production";
  const jwtSecret = env.JWT_SECRET ?? DEV_JWT_SECRET;
  if (isProduction && jwtSecret === DEV_JWT_SECRET) {
    throw new Error("JWT_SECRET bắt buộc phải đặt trong production");
  }

  const defaultUploadsDir =
    env.UPLOADS_DIR ?? fileURLToPath(new URL("../.data/uploads/", import.meta.url));

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
    // Bật mặc định: nén là trong suốt với client (trình duyệt nào cũng hỗ trợ)
    // và chỉ có lợi; `off` để dành cho lúc cần soi frame bằng tay hoặc debug.
    gatewayCompress: !isOff(env.GATEWAY_COMPRESS),
    gatewayCompressThreshold: readPositiveInt(
      env.GATEWAY_COMPRESS_THRESHOLD,
      1024,
      0,
      1_048_576,
    ),
    maxReplayEvents: Number(env.MAX_REPLAY_EVENTS ?? "2000"),
    migrationsDir:
      env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../../db/migrations/", import.meta.url)),
    gatewayPublicUrl: env.GATEWAY_PUBLIC_URL ?? null,
    uploadsDir: defaultUploadsDir,
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? String(10 * 1024 * 1024)),
    // Mặc định nằm trong thư mục uploads (đổi UPLOADS_DIR là avatar đi theo,
    // test cũng tự dùng thư mục tạm thay vì ghi vào repo).
    avatarsDir: env.AVATARS_DIR ?? path.join(defaultUploadsDir, "avatars"),
    maxAvatarBytes: Number(env.MAX_AVATAR_BYTES ?? String(5 * 1024 * 1024)),
    smtpUrl: env.SMTP_URL ?? null,
    mailFrom: env.MAIL_FROM ?? "Umaru <no-reply@umaru.local>",
    publicWebUrl: env.PUBLIC_WEB_URL ?? "http://localhost:5173",
    emailVerificationTtlHours: Number(env.EMAIL_VERIFICATION_TTL_HOURS ?? "24"),
    emailVerificationResendCooldownSec: Number(
      env.EMAIL_VERIFICATION_RESEND_COOLDOWN_SEC ?? "60",
    ),
    adminUserIds: splitList(env.ADMIN_USER_IDS),
    adminUsernames: splitList(env.ADMIN_USERNAMES).map((name) => name.toLowerCase()),
    reportNotifyEmail: !isOff(env.REPORT_NOTIFY_EMAIL),
    reportNotifyCooldownSec: readPositiveInt(env.REPORT_NOTIFY_COOLDOWN_SEC, 300, 0, 86_400),
    rateLimitsEnabled: !isOff(env.RATE_LIMITS),
    rateLimitMessagesPerUser: readPositiveInt(env.RATE_LIMIT_MESSAGES_PER_USER, 5, 1, 1_000),
    rateLimitMessagesPerChannel: readPositiveInt(
      env.RATE_LIMIT_MESSAGES_PER_CHANNEL,
      30,
      1,
      100_000,
    ),
    rateLimitGatewayFramesPerMinute: readPositiveInt(
      env.RATE_LIMIT_GATEWAY_FRAMES_PER_MINUTE,
      120,
      10,
      100_000,
    ),
    rateLimitSessionsPerUser: readPositiveInt(env.RATE_LIMIT_SESSIONS_PER_USER, 5, 1, 100),
    rateLimitVoiceMutations: readPositiveInt(env.RATE_LIMIT_VOICE_MUTATIONS, 10, 1, 1_000),
    rateLimitAuthPerIp: readPositiveInt(env.RATE_LIMIT_AUTH_PER_IP, 20, 1, 10_000),
    rateLimitAuthPerEmail: readPositiveInt(env.RATE_LIMIT_AUTH_PER_EMAIL, 10, 1, 10_000),
    // Chỉ bật khi có proxy thật; xem ghi chú ở interface.
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    livekit: readLiveKit(env),
    livekitTokenTtlSec: readPositiveInt(env.LIVEKIT_TOKEN_TTL_SEC, 3600, 60, 86_400),
    push: readPush(env),
    pushCooldownSec: readPositiveInt(env.PUSH_COOLDOWN_SEC, 10, 0, 3600),
    storage: readStorage(env),
    emailVerificationEcho: env.EMAIL_VERIFICATION_ECHO
      ? env.EMAIL_VERIFICATION_ECHO !== "0"
      : !isProduction,
    logger: env.NODE_ENV !== "test" && env.LOG_LEVEL !== "silent",
  };
}

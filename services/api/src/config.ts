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
  logger: boolean;
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
    logger: env.NODE_ENV !== "test" && env.LOG_LEVEL !== "silent",
  };
}

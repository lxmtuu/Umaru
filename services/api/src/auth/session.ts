import { createSnowflake, type Snowflake } from "@umaru/protocol";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { TokenService } from "./tokens.js";

/**
 * Cấp cặp token cho một phiên mới.
 *
 * Tách khỏi route vì có **hai** đường vào (mật khẩu và OAuth) và chúng phải cấp
 * token giống hệt nhau: cùng TTL, cùng `user_sessions` (nhờ vậy đăng xuất từ xa,
 * giới hạn 5 session/user và `refresh` xoay vòng dùng chung), cùng hình dạng
 * response để client chỉ có một đường lưu token.
 */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export async function issueSessionTokens(
  deps: { pool: Pool; config: Config; tokens: TokenService },
  userId: string,
  userAgent: string | null,
): Promise<IssuedTokens> {
  const { pool, config, tokens } = deps;
  const accessToken = await tokens.signAccessToken(userId as Snowflake);
  const refresh = tokens.createRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, refresh_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [createSnowflake(config.workerId), userId, refresh.hash, userAgent?.slice(0, 255) ?? null, expiresAt],
  );
  return {
    accessToken,
    refreshToken: refresh.token,
    tokenType: "Bearer",
    expiresIn: tokens.accessTokenTtlSec,
  };
}

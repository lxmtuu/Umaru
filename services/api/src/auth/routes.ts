import { LEGAL_VERSION, createSnowflake, type Snowflake } from "@umaru/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { mapUser, type UserRow } from "../mappers.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import {
  HttpError,
  badRequest,
  conflict,
  readString,
  tooManyRequests,
  unauthorized,
} from "../http.js";
import type { Mailer } from "../mail.js";
import { checkSecondFactor } from "./secondFactor.js";
import { hashVerificationToken, issueVerificationToken } from "./verification.js";
import { createAuthGuard, requireUserId } from "./guard.js";
import { hashPassword, verifyPassword } from "./password.js";
import { BucketStore, rateLimitedBody } from "../rateLimit.js";
import type { TokenService } from "./tokens.js";

export interface AuthDeps {
  pool: Pool;
  tokens: TokenService;
  config: Config;
  mailer: Mailer;
}

const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { pool, tokens, config, mailer } = deps;

  /**
   * Chống dò mật khẩu. Đếm theo **hai khoá**: IP và email.
   *
   * Chỉ đếm lần **thất bại** — người dùng đăng nhập đúng 50 lần một ngày không
   * được coi là tấn công, còn kẻ dò mật khẩu thì mọi lần thử đều sai. Bộ đếm
   * xoá khi đăng nhập thành công (đổi lại là mật khẩu đúng thì không còn gì để
   * dò nữa).
   */
  // Cửa sổ 15 phút: đủ dài để dò mật khẩu không có lợi, đủ ngắn để người gõ
  // nhầm vài lần vẫn đăng nhập lại được trong cùng buổi.
  const AUTH_WINDOW_MS = 15 * 60 * 1000;
  const authByIp = new BucketStore(config.rateLimitAuthPerIp, AUTH_WINDOW_MS);
  const authByEmail = new BucketStore(config.rateLimitAuthPerEmail, AUTH_WINDOW_MS);

  /**
   * Trả về số giây phải chờ khi bị chặn, `null` khi được đi tiếp. Cố ý **không**
   * ném `HttpError`: mọi rate limit khác của API trả body `RATE_LIMITED` kèm
   * `retry_after` (client hiện được "thử lại sau N giây"), nếu chỗ này ném thì
   * body khác hình dạng và client phải có nhánh riêng.
   */
  function authAttemptBlocked(
    request: FastifyRequest,
    email: string | null,
  ): { retryAfter: number; message: string } | null {
    if (!config.rateLimitsEnabled) return null;
    // `request.ip` là IP thật chỉ khi `TRUST_PROXY` khớp với hạ tầng; sai cấu
    // hình thì hoặc chặn oan cả proxy, hoặc client tự khai IP — cả hai đều tệ,
    // nên ghi rõ trong DEPLOY.md thay vì đoán.
    const byIp = authByIp.take(request.ip);
    if (byIp !== null) {
      return {
        retryAfter: byIp,
        message: `Quá nhiều lần đăng nhập từ địa chỉ này, thử lại sau ${byIp} giây`,
      };
    }
    if (email !== null) {
      const byEmail = authByEmail.take(`login:${email}`);
      if (byEmail !== null) {
        return {
          retryAfter: byEmail,
          message: `Tài khoản này vừa có quá nhiều lần đăng nhập sai, thử lại sau ${byEmail} giây`,
        };
      }
    }
    return null;
  }

  const issueTokens = async (userId: string, request: FastifyRequest) => {
    const accessToken = await tokens.signAccessToken(userId as Snowflake);
    const refresh = tokens.createRefreshToken();
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);
    await pool.query(
      `INSERT INTO user_sessions (id, user_id, refresh_hash, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        createSnowflake(config.workerId),
        userId,
        refresh.hash,
        request.headers["user-agent"]?.slice(0, 255) ?? null,
        expiresAt,
      ],
    );
    return {
      accessToken,
      refreshToken: refresh.token,
      tokenType: "Bearer" as const,
      expiresIn: tokens.accessTokenTtlSec,
    };
  };

  app.post("/auth/register", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const username = readString(body, "username", { min: 2, max: 32 }).toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw badRequest("Username chỉ gồm a-z, 0-9, dấu chấm, gạch dưới, gạch ngang");
    }
    const displayName = readString(body, "displayName", { min: 1, max: 32 });
    const email = readString(body, "email", { max: 254 }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw badRequest("Email không hợp lệ");
    const password = readString(body, "password", { min: 8, max: 200, trim: false });
    // Bắt buộc đồng ý điều khoản: client đã tick, server ghi mốc + phiên bản.
    if (body?.["acceptedTerms"] !== true) {
      throw badRequest("Cần đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản");
    }

    const id = createSnowflake(config.workerId);
    const passwordHash = await hashPassword(password);
    try {
      await pool.query(
        `INSERT INTO users (id, username, display_name, email, password_hash,
                            terms_accepted_at, terms_version)
         VALUES ($1, $2, $3, $4, $5, now(), $6)`,
        [id, username, displayName, email, passwordHash, LEGAL_VERSION],
      );
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === "users_username_key") throw conflict("Username đã được dùng");
      if (constraint === "users_email_key") throw conflict("Email đã được dùng");
      throw error;
    }

    const user = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
    const created = user.rows[0];
    if (created === undefined) throw new Error("Không đọc được user vừa tạo");
    const verification = await issueVerificationToken(
      {
        pool,
        config,
        mailer,
        nextId: () => createSnowflake(config.workerId),
        log: (line) => app.log.warn(line),
      },
      { id, email: created.email, displayName: created.display_name },
    );

    const tokensPayload = await issueTokens(id, request);
    return reply.code(201).send({
      user: mapUser(created),
      ...tokensPayload,
      emailVerificationSent: true,
      // Chỉ có ở dev/test (EMAIL_VERIFICATION_ECHO) — xem config.ts.
      ...(verification === null ? {} : { devVerificationToken: verification }),
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = readString(body, "email", { max: 254 }).toLowerCase();
    const password = readString(body, "password", { min: 1, max: 200, trim: false });

    // Kiểm **trước** khi băm: argon2id cố tình đắt, nên một vòng lặp thử mật
    // khẩu không chỉ là dò bảo mật mà còn là đốt CPU của server.
    const blocked = authAttemptBlocked(request, email);
    if (blocked !== null) {
      return reply.code(429).send(rateLimitedBody(blocked.retryAfter, blocked.message));
    }

    const result = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    const valid = user === undefined ? false : await verifyPassword(user.password_hash, password);
    if (user === undefined || !valid) {
      throw unauthorized("Email hoặc mật khẩu không đúng");
    }
    // Mật khẩu đúng → hết lý do để giữ bộ đếm (người dùng vừa gõ đúng).
    authByEmail.clear(`login:${email}`);

    /**
     * Xác thực hai lớp. Mật khẩu đúng **chưa** đủ để cấp token khi user đã bật.
     *
     * Không có mã → 401 `TOTP_REQUIRED` (mã riêng, không phải `UNAUTHORIZED`) để
     * client biết cần hỏi thêm mã chứ không phải báo "sai mật khẩu" — hai tình
     * huống này người dùng phải thấy khác nhau. Có mã nhưng sai → 401
     * `INVALID_TOTP` và **vẫn** tính vào bộ đếm dò của email.
     */
    const second = await checkSecondFactor(pool, user.id, {
      code: typeof body?.totpCode === "string" ? body.totpCode : undefined,
      recoveryCode: typeof body?.recoveryCode === "string" ? body.recoveryCode : undefined,
    });
    if (!second.ok) {
      if (second.reason === "required") {
        throw new HttpError(401, "TOTP_REQUIRED", "Tài khoản này có xác thực hai lớp — nhập mã 6 số");
      }
      throw new HttpError(401, "INVALID_TOTP", "Mã xác thực hai lớp không đúng hoặc đã dùng");
    }

    const tokensPayload = await issueTokens(user.id, request);
    return reply.send({
      user: mapUser(user),
      ...tokensPayload,
      // Cho client biết lần đăng nhập này đã tiêu một mã khôi phục — người dùng
      // cần biết mã đó không dùng lại được nữa.
      ...(second.method === "recovery" ? { usedRecoveryCode: true } : {}),
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const refreshToken = readString(body, "refreshToken", { min: 16, max: 200, trim: false });
    const hash = tokens.hashRefreshToken(refreshToken);

    // Rotation: dùng một lần — UPDATE ... RETURNING vừa thu hồi vừa xác nhận atomic.
    const consumed = await pool.query<{ user_id: string }>(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hash],
    );
    const session = consumed.rows[0];
    if (session === undefined) throw unauthorized("Refresh token không hợp lệ hoặc đã hết hạn");

    const user = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [session.user_id]);
    if (user.rows[0] === undefined) throw unauthorized("Tài khoản không tồn tại");
    const tokensPayload = await issueTokens(session.user_id, request);
    return reply.send({ user: mapUser(user.rows[0]), ...tokensPayload });
  });

  const guard = createAuthGuard(tokens);

  /**
   * Xác thực email bằng token trong link.
   *
   * Không cần đăng nhập: token nằm trong hộp thư nên tự nó là bằng chứng.
   * Hai lần bấm song song: `UPDATE ... WHERE used_at IS NULL` chỉ một bên thắng.
   */
  app.post("/auth/verify-email", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const token = readString(body, "token", { min: 16, max: 200, trim: true });

    const consumed = await pool.query<{ user_id: string }>(
      `UPDATE email_verification_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [hashVerificationToken(token)],
    );
    const row = consumed.rows[0];
    if (row === undefined) {
      throw badRequest("Link xác thực không hợp lệ, đã dùng hoặc đã hết hạn");
    }

    const updated = await pool.query<UserRow>(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()),
                        updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [row.user_id],
    );
    const user = updated.rows[0];
    if (user === undefined) throw badRequest("Tài khoản không tồn tại");
    return reply.send({ user: mapUser(user) });
  });

  /** Gửi lại mail xác thực (có cooldown để không biến endpoint thành máy spam). */
  app.post("/auth/verify-email/resend", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
    const user = result.rows[0];
    if (user === undefined) throw unauthorized("Tài khoản không tồn tại");
    if (user.email_verified_at !== null) {
      throw conflict("Email đã được xác thực");
    }

    const latest = await pool.query<{ wait: number }>(
      `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
                created_at + ($2 * INTERVAL '1 second') - now()
              ))))::int AS wait
         FROM email_verification_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, config.emailVerificationResendCooldownSec],
    );
    const wait = latest.rows[0]?.wait ?? 0;
    if (wait > 0) {
      throw tooManyRequests(`Vui lòng đợi ${wait} giây rồi thử gửi lại`);
    }

    const verification = await issueVerificationToken(
      {
        pool,
        config,
        mailer,
        nextId: () => createSnowflake(config.workerId),
        log: (line) => app.log.warn(line),
      },
      { id: user.id, email: user.email, displayName: user.display_name },
    );

    return reply.code(202).send({
      sent: true,
      ...(verification === null ? {} : { devVerificationToken: verification }),
    });
  });

  app.post("/auth/logout", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = request.body as Record<string, unknown> | undefined;
    const refreshToken = readString(body, "refreshToken", { min: 16, max: 200, trim: false });
    await pool.query(
      `UPDATE user_sessions SET revoked_at = now()
        WHERE refresh_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [tokens.hashRefreshToken(refreshToken), userId],
    );
    return reply.code(204).send();
  });

  app.get("/users/@me", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
    const user = result.rows[0];
    if (user === undefined) throw unauthorized("Tài khoản không tồn tại");
    return reply.send(mapUser(user, "online"));
  });
}

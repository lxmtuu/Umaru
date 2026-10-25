import { createSnowflake, type Snowflake } from "@umaru/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { mapUser, type UserRow } from "../mappers.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { badRequest, conflict, readString, unauthorized } from "../http.js";
import { createAuthGuard, requireUserId } from "./guard.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { TokenService } from "./tokens.js";

export interface AuthDeps {
  pool: Pool;
  tokens: TokenService;
  config: Config;
}

const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { pool, tokens, config } = deps;

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

    const id = createSnowflake(config.workerId);
    const passwordHash = await hashPassword(password);
    try {
      await pool.query(
        `INSERT INTO users (id, username, display_name, email, password_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, username, displayName, email, passwordHash],
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
    const tokensPayload = await issueTokens(id, request);
    return reply.code(201).send({ user: mapUser(created), ...tokensPayload });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const email = readString(body, "email", { max: 254 }).toLowerCase();
    const password = readString(body, "password", { min: 1, max: 200, trim: false });

    const result = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    const valid = user === undefined ? false : await verifyPassword(user.password_hash, password);
    if (user === undefined || !valid) {
      throw unauthorized("Email hoặc mật khẩu không đúng");
    }
    const tokensPayload = await issueTokens(user.id, request);
    return reply.send({ user: mapUser(user), ...tokensPayload });
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

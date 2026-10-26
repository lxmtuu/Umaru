import { createHash } from "node:crypto";
import { LEGAL_VERSION, createSnowflake } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { HttpError, badRequest, notFound, readString } from "../http.js";
import { mapUser, type UserRow } from "../mappers.js";
import type { TokenService } from "../auth/tokens.js";
import { issueSessionTokens } from "../auth/session.js";
import { checkSecondFactor } from "../auth/secondFactor.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForProfile,
  isOAuthProvider,
  providerLabel,
  type OAuthProfile,
  type OAuthProviderId,
} from "./providers.js";

/**
 * Đăng nhập bằng OAuth2 (Google, GitHub).
 *
 * Luồng có **bốn** chặng, và mỗi chặng tồn tại vì một lý do bảo mật:
 *
 *  1. `GET /auth/oauth/:provider/start` — SPA xin URL. Server sinh `state` ngẫu
 *     nhiên, lưu DB (single-use, TTL 10 phút) rồi trả URL để SPA tự chuyển trang.
 *  2. Người dùng đồng ý ở provider → provider redirect về
 *     `GET /auth/oauth/:provider/callback?code&state`.
 *  3. Callback **không** trả token. Nó đổi `code`, tìm/tạo user, rồi redirect về
 *     SPA với một **mã dùng một lần**. Token không bao giờ nằm trong URL: URL đi
 *     vào log proxy, lịch sử trình duyệt và header `Referer`.
 *  4. SPA gọi `POST /auth/oauth/exchange` để đổi mã lấy token — đúng lúc đó 2FA
 *     mới được kiểm, nên OAuth **không** là đường vòng qua 2FA.
 */
export interface OAuthDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  /** Bơm fetch giả trong test; mặc định `globalThis.fetch`. */
  fetch?: typeof fetch;
}

const STATE_TTL_DEFAULT_SEC = 600;
const LOGIN_CODE_TTL_DEFAULT_SEC = 120;
/** Số lần nhập sai 2FA cho phép trên **một** mã đăng nhập trước khi tiêu huỷ. */
export const MAX_LOGIN_CODE_ATTEMPTS = 5;

/** Mã hoá ngẫu nhiên an toàn (state, mã đăng nhập). */
function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function hashLoginCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function configuredClient(
  config: Config,
  provider: OAuthProviderId,
): { clientId: string; clientSecret: string } | null {
  return provider === "google" ? config.oauth.google : config.oauth.github;
}

/** Chỉ nhận đường dẫn nội bộ — `//evil.com` và `https://evil.com` là open redirect. */
function safeRedirectPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.length > 512) return null;
  return raw;
}

function withQuery(url: string, params: Record<string, string>): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(params).toString()}`;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthDeps): void {
  const { pool, config, tokens } = deps;
  const httpFetch = deps.fetch ?? globalThis.fetch;
  const stateTtlSec = config.oauth.stateTtlSec ?? STATE_TTL_DEFAULT_SEC;
  const loginCodeTtlSec = config.oauth.loginCodeTtlSec ?? LOGIN_CODE_TTL_DEFAULT_SEC;

  const redirectUriFor = (provider: OAuthProviderId): string =>
    `${config.oauth.callbackBase}/auth/oauth/${provider}/callback`;

  /** Provider đã cấu hình chưa; chưa thì 404 (không có trạng thái "nửa bật"). */
  function requireClient(provider: string) {
    if (!isOAuthProvider(provider)) throw notFound("Nhà cung cấp không hỗ trợ");
    const client = configuredClient(config, provider);
    if (client === null) {
      throw notFound(`Đăng nhập bằng ${providerLabel(provider)} chưa được bật trên server này`);
    }
    return client;
  }

  app.get("/auth/oauth/providers", async (_request, reply) => {
    // Chỉ tên provider — **không** client id, không redirect URI: SPA chỉ cần biết
    // nút nào hiện ra.
    const providers = (["google", "github"] as OAuthProviderId[])
      .filter((provider) => configuredClient(config, provider) !== null)
      .map((provider) => ({ id: provider, label: providerLabel(provider) }));
    return reply.send({ providers });
  });

  app.get<{ Params: { provider: string }; Querystring: Record<string, string> }>(
    "/auth/oauth/:provider/start",
    async (request, reply) => {
      const provider = request.params.provider;
      const client = requireClient(provider);
      if (!isOAuthProvider(provider)) throw notFound("Nhà cung cấp không hỗ trợ");

      // Dọn state hết hạn của các lượt bị bỏ dở (đóng tab, bot dội). Không có
      // cron: mỗi lượt `start` dọn luôn, và index `idx_oauth_states_expiry`
      // (migration 0020) giữ câu này rẻ.
      await pool.query("DELETE FROM oauth_states WHERE expires_at <= now()");

      const acceptedTerms = request.query.acceptedTerms === "1" || request.query.acceptedTerms === "true";
      const redirectPath = safeRedirectPath(request.query.redirect);
      const state = randomToken();
      await pool.query(
        `INSERT INTO oauth_states (state, provider, redirect_path, accepted_terms, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
        [state, provider, redirectPath, acceptedTerms, String(stateTtlSec)],
      );
      return reply.send({
        url: buildAuthorizeUrl(provider, {
          clientId: client.clientId,
          redirectUri: redirectUriFor(provider),
          state,
        }),
      });
    },
  );

  /**
   * Callback của provider. Luôn **redirect** về SPA (không trả JSON): đây là một
   * lượt điều hướng của trình duyệt, người dùng phải thấy app chứ không thấy
   * `{"error":...}`.
   */
  app.get<{ Params: { provider: string }; Querystring: Record<string, string> }>(
    "/auth/oauth/:provider/callback",
    async (request, reply) => {
      const provider = request.params.provider;
      const webUrl = config.publicWebUrl;
      const fail = (reason: string, redirectPath: string | null = null) =>
        reply.redirect(
          withQuery(`${webUrl}${redirectPath ?? "/"}`, { oauth_error: reason }),
          302,
        );

      if (!isOAuthProvider(provider)) return fail("provider");
      const client = configuredClient(config, provider);
      if (client === null) return fail("provider");

      // Người dùng bấm "Huỷ" ở trang đồng ý: provider trả `error=access_denied`.
      if (typeof request.query.error === "string") return fail("access_denied");

      const state = request.query.state;
      if (typeof state !== "string" || state.length === 0) return fail("state");
      // State dùng một lần: DELETE ... RETURNING vừa kiểm vừa tiêu, nên hai tab
      // bấm cùng lúc chỉ một tab thắng.
      const stateRow = await pool.query<{
        provider: string;
        redirect_path: string | null;
        accepted_terms: boolean;
      }>(
        `DELETE FROM oauth_states
          WHERE state = $1 AND expires_at > now()
          RETURNING provider, redirect_path, accepted_terms`,
        [state],
      );
      const stored = stateRow.rows[0];
      if (stored === undefined || stored.provider !== provider) return fail("state");

      const code = request.query.code;
      if (typeof code !== "string" || code.length === 0) return fail("code");

      let profile: OAuthProfile;
      try {
        profile = await exchangeCodeForProfile(provider, {
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          redirectUri: redirectUriFor(provider),
          fetch: httpFetch,
        }, code);
      } catch (error) {
        // Log nguyên nhân cho người vận hành, nhưng **không** đưa chi tiết của
        // provider ra URL (có thể chứa dữ liệu nội bộ).
        app.log.warn({ err: error, provider }, "Đổi mã OAuth thất bại");
        return fail("provider", stored.redirect_path);
      }

      try {
        const user = await resolveUser(pool, config, provider, profile, stored.accepted_terms);
        const loginCode = randomToken();
        await pool.query(
          `INSERT INTO oauth_login_codes (code_hash, user_id, expires_at)
           VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
          [hashLoginCode(loginCode), user.id, String(loginCodeTtlSec)],
        );
        return reply.redirect(
          withQuery(`${webUrl}${stored.redirect_path ?? "/"}`, { oauth_code: loginCode }),
          302,
        );
      } catch (error) {
        if (error instanceof HttpError) return fail(error.code.toLowerCase(), stored.redirect_path);
        app.log.error({ err: error, provider }, "Tạo/liên kết tài khoản OAuth thất bại");
        return fail("account", stored.redirect_path);
      }
    },
  );

  /**
   * Đổi mã đăng nhập lấy token.
   *
   * **2FA nằm ở đây**, không phải ở callback: nếu kiểm ở callback thì phải nhét
   * token vào URL, và OAuth sẽ thành đường vòng qua 2FA chỉ bằng một cú bấm.
   * Thiếu mã 2FA ⇒ 401 `TOTP_REQUIRED` và mã đăng nhập **không** bị tiêu, để
   * client hỏi mã rồi gọi lại.
   */
  app.post("/auth/oauth/exchange", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const code = readString(body, "code", { min: 16, max: 200, trim: true });
    const codeHash = hashLoginCode(code);

    const row = await pool.query<{ user_id: string; attempts: number }>(
      `SELECT user_id, attempts FROM oauth_login_codes
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [codeHash],
    );
    const login = row.rows[0];
    if (login === undefined) {
      throw new HttpError(401, "OAUTH_CODE_INVALID", "Mã đăng nhập không hợp lệ hoặc đã hết hạn");
    }

    const second = await checkSecondFactor(pool, login.user_id, {
      code: typeof body?.totpCode === "string" ? body.totpCode : undefined,
      recoveryCode: typeof body?.recoveryCode === "string" ? body.recoveryCode : undefined,
    });
    if (!second.ok) {
      if (second.reason === "required") {
        throw new HttpError(401, "TOTP_REQUIRED", "Tài khoản này có xác thực hai lớp — nhập mã 6 số");
      }
      // Sai mã: đếm và tiêu mã khi vượt trần. Mã 6 số sống 2 phút là dò được nếu
      // không giới hạn số lần thử trên **cùng một** mã đăng nhập.
      const attempts = login.attempts + 1;
      // Cast tường minh: `$2` vừa gán vào cột `integer` vừa so sánh trong `CASE`
      // nên PostgreSQL suy ra hai kiểu khác nhau và báo "inconsistent types".
      await pool.query(
        `UPDATE oauth_login_codes
            SET attempts = $2::integer,
                used_at = CASE WHEN $2::integer >= $3::integer THEN now() ELSE used_at END
          WHERE code_hash = $1`,
        [codeHash, attempts, MAX_LOGIN_CODE_ATTEMPTS],
      );
      throw new HttpError(401, "INVALID_TOTP", "Mã xác thực hai lớp không đúng hoặc đã dùng");
    }

    // Tiêu mã **sau** khi 2FA đã qua. Hai request song song: chỉ một UPDATE thắng.
    const consumed = await pool.query(
      "UPDATE oauth_login_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL",
      [codeHash],
    );
    if (consumed.rowCount === 0) {
      throw new HttpError(401, "OAUTH_CODE_INVALID", "Mã đăng nhập đã được dùng");
    }

    const user = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [login.user_id]);
    const found = user.rows[0];
    if (found === undefined) throw new HttpError(401, "OAUTH_CODE_INVALID", "Tài khoản không tồn tại");

    const issued = await issueSessionTokens(
      { pool, config, tokens },
      login.user_id,
      request.headers["user-agent"] ?? null,
    );
    return reply.send({
      user: mapUser(found),
      ...issued,
      provider: await providerOf(pool, login.user_id),
      ...(second.method === "recovery" ? { usedRecoveryCode: true } : {}),
    });
  });

  /**
   * Danh sách provider đang liên kết + tài khoản đã có mật khẩu chưa.
   *
   * SPA cần `hasPassword` để biết có nên khoá nút "gỡ" của provider cuối cùng
   * hay không — server vẫn kiểm lại, nhưng hiện nút bấm được rồi báo lỗi là
   * trải nghiệm tệ.
   */
  app.get(
    "/users/@me/oauth",
    { preHandler: createAuthGuard(tokens) },
    async (request, reply) => {
      const userId = requireUserId(request);
      const rows = await pool.query<{ provider: OAuthProviderId; created_at: Date }>(
        "SELECT provider, created_at FROM oauth_accounts WHERE user_id = $1 ORDER BY created_at",
        [userId],
      );
      const password = await pool.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId],
      );
      return reply.send({
        accounts: rows.rows.map((row) => ({
          provider: row.provider,
          label: providerLabel(row.provider),
          linkedAt: row.created_at.toISOString(),
        })),
        hasPassword: (password.rows[0]?.password_hash ?? null) !== null,
      });
    },
  );

  /**
   * Gỡ liên kết một provider khỏi tài khoản đang đăng nhập.
   *
   * Chặn đúng một trường hợp: gỡ **cách đăng nhập cuối cùng** của tài khoản
   * không có mật khẩu — nếu không, người dùng tự khoá mình ra ngoài và cách duy
   * nhất để cứu là sửa DB tay.
   */
  app.delete<{ Params: { provider: string } }>(
    "/users/@me/oauth/:provider",
    { preHandler: createAuthGuard(tokens) },
    async (request, reply) => {
      const provider = request.params.provider;
      if (!isOAuthProvider(provider)) throw notFound("Nhà cung cấp không hỗ trợ");
      const userId = requireUserId(request);

      const linked = await pool.query(
        "SELECT 1 FROM oauth_accounts WHERE user_id = $1 AND provider = $2",
        [userId, provider],
      );
      if ((linked.rowCount ?? 0) === 0) throw notFound("Tài khoản chưa liên kết nhà cung cấp này");

      // Kiểm **trước** khi xoá: hoàn tác sau khi xoá là kiểu sửa lỗi dễ hỏng
      // (lỡ một bước là mất dòng liên kết thật).
      const left = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM oauth_accounts WHERE user_id = $1",
        [userId],
      );
      const password = await pool.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId],
      );
      if (
        Number(left.rows[0]?.count ?? "0") <= 1 &&
        (password.rows[0]?.password_hash ?? null) === null
      ) {
        throw badRequest("Đây là cách đăng nhập duy nhất của tài khoản — đặt mật khẩu trước khi gỡ");
      }

      await pool.query("DELETE FROM oauth_accounts WHERE user_id = $1 AND provider = $2", [
        userId,
        provider,
      ]);
      return reply.code(204).send();
    },
  );
}

/**
 * Tìm user cho hồ sơ OAuth: đã liên kết → dùng; chưa → liên kết theo email **đã
 * xác thực**; chưa có ai → tạo mới.
 *
 * Vì sao chỉ liên kết khi provider nói email đã xác thực: nếu liên kết theo email
 * chưa xác thực thì bất kỳ ai tạo được tài khoản ở provider với email của người
 * khác là chiếm được tài khoản Umaru của người đó. Đây là lỗi kinh điển của
 * "sign in with X"; ở đây chặn ngay ở cửa.
 */
async function resolveUser(
  pool: Pool,
  config: Config,
  provider: OAuthProviderId,
  profile: OAuthProfile,
  acceptedTerms: boolean,
): Promise<{ id: string }> {
  const linked = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2",
    [provider, profile.providerUserId],
  );
  const existingLink = linked.rows[0];
  if (existingLink !== undefined) {
    await pool.query(
      "UPDATE oauth_accounts SET last_login_at = now(), email = COALESCE($3, email) WHERE provider = $1 AND provider_user_id = $2",
      [provider, profile.providerUserId, profile.email],
    );
    return { id: existingLink.user_id };
  }

  if (profile.email !== null && profile.emailVerified) {
    const byEmail = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email = $1",
      [profile.email],
    );
    const existingUser = byEmail.rows[0];
    if (existingUser !== undefined) {
      await pool.query(
        `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, last_login_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
        [provider, profile.providerUserId, existingUser.id, profile.email],
      );
      return { id: existingUser.id };
    }
  } else if (profile.email !== null) {
    // Email **chưa** xác thực nhưng đã có người dùng khác dùng email đó: tạo tài
    // khoản mới sẽ vi phạm unique, và liên kết thì là lỗ hổng chiếm tài khoản.
    const byEmail = await pool.query("SELECT 1 FROM users WHERE email = $1", [profile.email]);
    if ((byEmail.rowCount ?? 0) > 0) {
      throw new HttpError(
        409,
        "OAUTH_EMAIL_TAKEN",
        "Email này đã có tài khoản Umaru — đăng nhập bằng mật khẩu rồi liên kết trong phần cài đặt",
      );
    }
  }

  if (profile.email === null) {
    throw new HttpError(
      400,
      "OAUTH_EMAIL_REQUIRED",
      `${providerLabel(provider)} không chia sẻ email đã xác thực — hãy cấp quyền email rồi thử lại`,
    );
  }
  if (!acceptedTerms) {
    throw new HttpError(
      400,
      "OAUTH_TERMS_REQUIRED",
      "Cần đồng ý Điều khoản sử dụng và Chính sách quyền riêng tư để tạo tài khoản",
    );
  }

  const id = createSnowflake(config.workerId);
  const username = await pickUsername(pool, profile);
  await pool.query(
    `INSERT INTO users (id, username, display_name, email, password_hash,
                        email_verified_at, terms_accepted_at, terms_version)
     VALUES ($1, $2, $3, $4, NULL, $5, now(), $6)`,
    [
      id,
      username,
      profile.displayName.slice(0, 32) || username,
      profile.email,
      // Provider đã xác thực email thì không bắt người dùng bấm link xác thực lần nữa.
      profile.emailVerified ? new Date() : null,
      LEGAL_VERSION,
    ],
  );
  await pool.query(
    "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, last_login_at) VALUES ($1, $2, $3, $4, now())",
    [provider, profile.providerUserId, id, profile.email],
  );
  return { id };
}

/** `@`-mention trong nội dung dùng username này; phải đúng CHECK của bảng `users`. */
const USERNAME_SAFE = /[^a-z0-9._-]/g;

function usernameBase(profile: OAuthProfile): string {
  const fromEmail = profile.email?.split("@")[0] ?? "";
  const candidate = [fromEmail, profile.displayName]
    .map((value) => value.toLowerCase().replace(/\s+/g, ".").replace(USERNAME_SAFE, ""))
    .find((value) => value.length >= 2);
  const base = (candidate ?? "nguoidung").slice(0, 24);
  // Bắt đầu bằng dấu chấm/gạch là hợp lệ theo CHECK nhưng trông như ký tự lạc.
  return base.replace(/^[._-]+/, "") || "nguoidung";
}

/** Tìm username trống; đuôi số ngẫu nhiên để hai người cùng tên không đụng nhau. */
async function pickUsername(pool: Pool, profile: OAuthProfile): Promise<string> {
  const base = usernameBase(profile);
  for (const suffix of ["", String(Math.floor(Math.random() * 9_000) + 1_000), ...Array.from({ length: 6 }, () => String(Math.floor(Math.random() * 90_000) + 10_000))]) {
    const candidate = `${base}${suffix}`.slice(0, 32);
    if (candidate.length < 2) continue;
    const taken = await pool.query("SELECT 1 FROM users WHERE username = $1", [candidate]);
    if ((taken.rowCount ?? 0) === 0) return candidate;
  }
  // Rơi về id ngẫu nhiên: luôn còn đường tạo tài khoản.
  return `user${Math.floor(Math.random() * 1e9)}`.slice(0, 32);
}

/** Provider đã liên kết (cho SPA hiện đúng trạng thái trong phần cài đặt). */
async function providerOf(pool: Pool, userId: string): Promise<OAuthProviderId | null> {
  const result = await pool.query<{ provider: string }>(
    "SELECT provider FROM oauth_accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1",
    [userId],
  );
  const provider = result.rows[0]?.provider;
  return provider !== undefined && isOAuthProvider(provider) ? provider : null;
}

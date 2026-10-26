import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import {
  HttpError,
  badRequest,
  conflict,
  notFound,
  readString,
  tooManyRequests,
  unauthorized,
} from "../http.js";
import { BucketStore, rateLimitedBody } from "../rateLimit.js";
import { requireUserId, createAuthGuard } from "./guard.js";
import { verifyPassword } from "./password.js";
import { loadTotpStatus } from "./secondFactor.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "./totp.js";
import type { TokenService } from "./tokens.js";

/**
 * Bật/tắt xác thực hai lớp (TOTP).
 *
 * Luồng có **hai bước** là cố ý: `setup` chỉ sinh và lưu bí mật ở trạng thái
 * "chưa xác nhận" (`enabled_at IS NULL`). Chỉ khi người dùng nhập đúng mã đầu
 * tiên thì 2FA mới có hiệu lực — nếu không, quét nhầm QR rồi đóng tab là tự
 * khoá mình ra ngoài vì server tưởng đã có 2FA mà điện thoại chẳng có gì.
 *
 * Tắt 2FA **bắt buộc nhập lại mật khẩu**: kẻ chiếm được tab đang đăng nhập
 * không được phép tháo lớp bảo vệ chỉ bằng một cú bấm.
 */
export interface TotpRouteDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
}

export function registerTotpRoutes(app: FastifyInstance, deps: TotpRouteDeps): void {
  const { pool, config } = deps;
  const guard = createAuthGuard(deps.tokens);

  /**
   * Chống dò mã 6 số (chỉ 1 triệu khả năng): 10 lần / 15 phút / user. Đếm theo
   * user chứ không theo IP vì kẻ tấn công đã có mật khẩu đúng, đổi IP dễ.
   */
  const attempts = new BucketStore(10, 15 * 60 * 1000);
  function takeAttempt(userId: string): void {
    if (!config.rateLimitsEnabled) return;
    const retry = attempts.take(`totp:${userId}`);
    if (retry !== null) {
      throw tooManyRequests(`Quá nhiều lần thử mã xác thực, thử lại sau ${retry} giây`);
    }
  }

  app.get("/users/@me/security", { preHandler: guard }, async (request, reply) => {
    const status = await loadTotpStatus(pool, requireUserId(request));
    return reply.send(status);
  });

  app.post("/users/@me/security/totp/setup", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const existing = await pool.query<{ enabled_at: Date | null }>(
      "SELECT enabled_at FROM user_totp WHERE user_id = $1",
      [userId],
    );
    if (existing.rows[0]?.enabled_at !== null && existing.rows[0]?.enabled_at !== undefined) {
      throw conflict("Xác thực hai lớp đã bật — tắt trước nếu muốn đổi thiết bị");
    }

    // Sinh mới mỗi lần gọi: người dùng bấm "thiết lập" lại (đóng tab giữa
    // chừng) thì bí mật cũ phải chết, không để hai bí mật cùng sống.
    const secret = generateTotpSecret();
    await pool.query(
      `INSERT INTO user_totp (user_id, secret, enabled_at, last_step, created_at)
       VALUES ($1, $2, NULL, NULL, now())
       ON CONFLICT (user_id) DO UPDATE
          SET secret = EXCLUDED.secret, enabled_at = NULL, last_step = NULL, created_at = now()`,
      [userId, secret],
    );
    const user = await pool.query<{ username: string }>(
      "SELECT username FROM users WHERE id = $1",
      [userId],
    );
    const account = user.rows[0]?.username ?? "umaru";
    return reply.send({
      secret,
      otpauthUrl: otpauthUrl(secret, account),
      /** Người dùng tự nhập được nếu không quét QR, dạng `ABCD EFGH …`. */
      secretGroups: secret.match(/.{1,4}/gu)?.join(" ") ?? secret,
    });
  });

  app.post("/users/@me/security/totp/enable", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    takeAttempt(userId);
    const body = request.body as Record<string, unknown> | undefined;
    const code = readString(body, "code", { min: 6, max: 12 });

    const row = await pool.query<{ secret: string; enabled_at: Date | null }>(
      "SELECT secret, enabled_at FROM user_totp WHERE user_id = $1",
      [userId],
    );
    const secret = row.rows[0]?.secret;
    if (secret === undefined) throw badRequest("Chưa có thiết lập nào đang chờ — bấm thiết lập lại");
    if (row.rows[0]?.enabled_at !== null && row.rows[0]?.enabled_at !== undefined) {
      throw conflict("Xác thực hai lớp đã bật");
    }
    const check = verifyTotp(secret, code);
    if (!check.ok) throw unauthorized("Mã xác thực không đúng hoặc đã hết hạn");

    const codes = generateRecoveryCodes();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // `last_step` để **trống** dù mã vừa kiểm thuộc bước hiện tại: đó là mã
      // dùng để bật, không phải một lần đăng nhập. Nếu tiêu luôn bước này thì
      // người vừa bật 2FA bị chặn đăng nhập tới 30 giây sau — đúng lúc họ đang
      // muốn kiểm lại rằng mình vẫn vào được.
      await client.query(
        "UPDATE user_totp SET enabled_at = now(), last_step = NULL WHERE user_id = $1",
        [userId],
      );
      // Mã khôi phục cũ (nếu có) phải chết: bật lại là bộ mã mới.
      await client.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [userId]);
      for (const code of codes) {
        await client.query(
          "INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)",
          [userId, hashRecoveryCode(code)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Mã khôi phục chỉ hiện **một lần** — server không lưu bản rõ.
    return reply.send({ recoveryCodes: codes });
  });

  app.post("/users/@me/security/totp/disable", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    takeAttempt(userId);
    const body = request.body as Record<string, unknown> | undefined;
    const password = readString(body, "password", { min: 1, max: 200, trim: false });

    const user = await pool.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [userId],
    );
    const hash = user.rows[0]?.password_hash;
    if (hash === undefined) throw notFound("Tài khoản không tồn tại");
    // Tài khoản OAuth không có mật khẩu: không thể "xác nhận bằng mật khẩu", nên
    // nói rõ thay vì báo sai mật khẩu (không có mật khẩu nào để gõ đúng).
    if (hash === null) {
      throw new HttpError(
        400,
        "PASSWORD_NOT_SET",
        "Tài khoản này đăng nhập bằng Google/GitHub nên không có mật khẩu để xác nhận",
      );
    }
    if (!(await verifyPassword(hash, password))) throw unauthorized("Mật khẩu không đúng");

    await pool.query("DELETE FROM user_totp WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [userId]);
    return reply.code(204).send();
  });

  /**
   * Sinh lại bộ mã khôi phục (đã dùng gần hết / làm mất giấy). Yêu cầu mật khẩu
   * như lúc tắt, và **không** cần mã TOTP: người gọi endpoint này đã đăng nhập
   * được (tức đã qua 2FA) — thêm mã nữa chỉ làm khó người đang cần.
   */
  app.post(
    "/users/@me/security/recovery-codes",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      takeAttempt(userId);
      const status = await loadTotpStatus(pool, userId);
      if (!status.totpEnabled) throw badRequest("Xác thực hai lớp chưa bật");
      const body = request.body as Record<string, unknown> | undefined;
      const password = readString(body, "password", { min: 1, max: 200, trim: false });
      const user = await pool.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId],
      );
      const hash = user.rows[0]?.password_hash;
      if (hash === undefined) throw notFound("Tài khoản không tồn tại");
      if (hash === null) {
        throw new HttpError(
          400,
          "PASSWORD_NOT_SET",
          "Tài khoản này đăng nhập bằng Google/GitHub nên không có mật khẩu để xác nhận",
        );
      }
      if (!(await verifyPassword(hash, password))) throw unauthorized("Mật khẩu không đúng");

      const codes = generateRecoveryCodes();
      await pool.query("DELETE FROM user_recovery_codes WHERE user_id = $1", [userId]);
      for (const code of codes) {
        await pool.query("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [
          userId,
          hashRecoveryCode(code),
        ]);
      }
      return reply.send({ recoveryCodes: codes });
    },
  );
}

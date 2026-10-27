import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { readString, unauthorized } from "../http.js";
import { requireUserId, createAuthGuard } from "./guard.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { TokenService } from "./tokens.js";

/**
 * Đặt / đổi mật khẩu.
 *
 * Có route này vì tài khoản tạo bằng OAuth có `password_hash = NULL`: nếu không
 * cho đặt mật khẩu thì họ không bao giờ gỡ được provider cuối cùng (server chặn
 * tự khoá mình ra ngoài) — tức là bị trói vào Google/GitHub mãi mãi.
 *
 * - **Chưa có mật khẩu** (OAuth-only): chỉ cần mật khẩu mới. Người dùng đã có
 *   phiên hợp lệ, và đường đăng nhập duy nhất của họ là provider vừa dùng.
 * - **Đã có mật khẩu**: bắt buộc `currentPassword` và kiểm đúng — kẻ chiếm được
 *   tab đang mở không được đổi mật khẩu chỉ bằng một cú bấm.
 *
 * Đổi mật khẩu **không** thu hồi các phiên khác ở đây: người dùng có thể đang mở
 * nhiều thiết bị của chính mình, và `user_sessions` đã có API đăng xuất từ xa.
 * Việc cần chặn là chiếm tài khoản, mà cửa đó đã khoá bằng mật khẩu hiện tại.
 */
export interface PasswordRouteDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
}

export function registerPasswordRoutes(app: FastifyInstance, deps: PasswordRouteDeps): void {
  const { pool, tokens } = deps;

  app.post(
    "/users/@me/password",
    { preHandler: createAuthGuard(tokens) },
    async (request, reply) => {
      const userId = requireUserId(request);
      const body = request.body as Record<string, unknown> | undefined;
      const password = readString(body, "password", { min: 8, max: 200, trim: false });

      const existing = await pool.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [userId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw unauthorized("Tài khoản không tồn tại");

      if (row.password_hash !== null) {
        const currentRaw = body?.currentPassword;
        const current = typeof currentRaw === "string" ? currentRaw : "";
        if (current === "" || !(await verifyPassword(row.password_hash, current))) {
          throw unauthorized("Mật khẩu hiện tại không đúng");
        }
      }

      await pool.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [
        userId,
        await hashPassword(password),
      ]);
      return reply.status(204).send();
    },
  );
}

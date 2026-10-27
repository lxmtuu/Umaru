import type { FastifyInstance } from "fastify";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { serviceUnavailable } from "../http.js";
import type { PushSender } from "./sender.js";
import {
  deleteSubscription,
  parsePushEndpoint,
  parsePushSubscription,
  upsertSubscription,
} from "./subscriptions.js";

export interface PushRouteDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  sender: PushSender;
}

/**
 * Web Push. Bốn route, tất cả đều cần đăng nhập:
 *
 * - `GET /push/public-key` — khoá VAPID để trình duyệt tạo subscription.
 * - `POST /push/subscriptions` — đăng ký (idempotent theo endpoint).
 * - `DELETE /push/subscriptions` — huỷ (idempotent; không biết endpoint thì vẫn 204).
 * - `POST /push/test` — gửi thử cho chính mình, để biết push có thật sự tới
 *   trước khi tin vào nó.
 *
 * Chưa cấu hình VAPID → **503** ở mọi route: client phải phân biệt được "server
 * chưa bật" với "trình duyệt chặn quyền", vì cách sửa khác hẳn nhau.
 */
export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDeps): void {
  const { pool, tokens, sender } = deps;
  const guard = createAuthGuard(tokens);

  app.get("/push/public-key", { preHandler: guard }, async (request, reply) => {
    const publicKey = sender.publicKey;
    if (publicKey === null) throw serviceUnavailable("Server chưa cấu hình thông báo đẩy");
    requireUserId(request);
    return reply.send({ publicKey });
  });

  app.post("/push/subscriptions", { preHandler: guard }, async (request, reply) => {
    if (!sender.enabled) throw serviceUnavailable("Server chưa cấu hình thông báo đẩy");
    const userId = requireUserId(request);
    const subscription = parsePushSubscription(request.body);
    await upsertSubscription(pool, userId, subscription);
    return reply.code(204).send();
  });

  app.delete("/push/subscriptions", { preHandler: guard }, async (request, reply) => {
    if (!sender.enabled) throw serviceUnavailable("Server chưa cấu hình thông báo đẩy");
    const userId = requireUserId(request);
    const endpoint = parsePushEndpoint(request.body);
    // Cố ý **không** báo lỗi khi không tìm thấy: client huỷ trên một máy khác
    // vẫn phải thành công, nếu không nó sẽ kẹt ở trạng thái "đang bật" mãi.
    await deleteSubscription(pool, userId, endpoint);
    return reply.code(204).send();
  });

  app.post<{ Body: { channelId?: string } }>(
    "/push/test",
    { preHandler: guard },
    async (request, reply) => {
      if (!sender.enabled) throw serviceUnavailable("Server chưa cấu hình thông báo đẩy");
      const userId = requireUserId(request);
      const channelId =
        typeof request.body?.channelId === "string" ? request.body.channelId : null;
      const result = await sender.sendTest(userId, channelId);
      return reply.send(result);
    },
  );
}

import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { createMailer, type Mailer } from "./mail.js";
import { createTokenService, type TokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Pool } from "./db.js";
import { registerDmRoutes } from "./dms/routes.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { GatewayHub } from "./gateway/hub.js";
import { registerGuildRoutes } from "./guilds/routes.js";
import { badRequest, registerErrorHandler } from "./http.js";
import { registerMessageRoutes } from "./messages/routes.js";
import { registerOverwriteRoutes } from "./overwrites/routes.js";
import { registerReadStateRoutes } from "./read-states/routes.js";
import { registerSearchRoutes } from "./search/routes.js";
import { registerUploadRoutes } from "./uploads/routes.js";
import { MAX_FILES_PER_MESSAGE } from "./uploads/storage.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  /** Thay bằng hộp thư trong bộ nhớ khi test; mặc định suy ra từ `config.smtpUrl`. */
  mailer?: Mailer;
}

export interface BuiltApp {
  app: FastifyInstance;
  hub: GatewayHub;
  tokens: TokenService;
  mailer: Mailer;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config, pool } = deps;
  const app = Fastify({
    logger: config.logger ? { level: "info" } : false,
    bodyLimit: 1024 * 1024,
  });

  await app.register(websocket, {
    options: { maxPayload: 4 * 1024 }, // spec §1: frame ≤ 4 KiB
  });
  // Upload file đi qua multipart; trần cứng đặt ở đây để Fastify chặn trước
  // khi ghi đĩa (route vẫn kiểm lại MIME và số file).
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: MAX_FILES_PER_MESSAGE,
      fields: 10,
      parts: 20,
    },
  });
  registerErrorHandler(app);

  const tokens = createTokenService(config.jwtSecret, config.accessTokenTtlSec);
  // Chưa có SMTP_URL → ghi mail ra log để dev tự bấm link (xem mail.ts).
  const mailer = deps.mailer ?? createMailer(config, (line) => app.log.info(line));
  const hub = new GatewayHub({ pool, config, tokens });

  /**
   * Tham số đường dẫn dạng id (`:channelId`, `:messageId`, `:memberId`...) đi
   * thẳng vào câu SQL `WHERE id = $1` với cột BIGINT. Không kiểm trước thì
   * `GET /channels/abc/messages` làm PostgreSQL ném `22P02` → 500 kèm log lỗi
   * hệ thống, trong khi đúng phải là 400 (client gửi sai). Kiểm một lần ở đây
   * thay vì lặp lại trong từng route.
   */
  app.addHook("preValidation", async (request) => {
    const params = request.params;
    if (typeof params !== "object" || params === null) return;
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (!/Id$/.test(key) || typeof value !== "string") continue;
      if (!/^\d{1,20}$/.test(value)) {
        throw badRequest(`"${key}" phải là snowflake (chuỗi số)`);
      }
    }
  });

  app.get("/health", async () => ({ ok: true, ...hub.getStats() }));

  await app.register(
    async (api) => {
      registerAuthRoutes(api, { pool, tokens, config, mailer });
      registerGuildRoutes(api, { pool, config, tokens, publisher: hub });
      registerMessageRoutes(api, { pool, config, tokens, publisher: hub });
      registerOverwriteRoutes(api, { pool, config, tokens, publisher: hub });
      registerDmRoutes(api, { pool, config, tokens, publisher: hub });
      registerReadStateRoutes(api, { pool, tokens });
      registerSearchRoutes(api, { pool, tokens });
      registerUploadRoutes(api, { pool, config, tokens });
      registerGatewayRoutes(api, hub, tokens, config);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async () => {
    hub.dispose();
  });

  return { app, hub, tokens, mailer };
}

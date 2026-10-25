import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { createTokenService, type TokenService } from "./auth/tokens.js";
import type { Config } from "./config.js";
import type { Pool } from "./db.js";
import { registerDmRoutes } from "./dms/routes.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { GatewayHub } from "./gateway/hub.js";
import { registerGuildRoutes } from "./guilds/routes.js";
import { registerErrorHandler } from "./http.js";
import { registerMessageRoutes } from "./messages/routes.js";
import { registerOverwriteRoutes } from "./overwrites/routes.js";
import { registerReadStateRoutes } from "./read-states/routes.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
}

export interface BuiltApp {
  app: FastifyInstance;
  hub: GatewayHub;
  tokens: TokenService;
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
  registerErrorHandler(app);

  const tokens = createTokenService(config.jwtSecret, config.accessTokenTtlSec);
  const hub = new GatewayHub({ pool, config, tokens });

  app.get("/health", async () => ({ ok: true, ...hub.getStats() }));

  await app.register(
    async (api) => {
      registerAuthRoutes(api, { pool, tokens, config });
      registerGuildRoutes(api, { pool, config, tokens, publisher: hub });
      registerMessageRoutes(api, { pool, config, tokens, publisher: hub });
      registerOverwriteRoutes(api, { pool, config, tokens, publisher: hub });
      registerDmRoutes(api, { pool, config, tokens, publisher: hub });
      registerReadStateRoutes(api, { pool, tokens });
      registerGatewayRoutes(api, hub, tokens, config);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async () => {
    hub.dispose();
  });

  return { app, hub, tokens };
}

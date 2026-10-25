import { GatewayVersion } from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { createAuthGuard } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { GatewayHub } from "./hub.js";

export function registerGatewayRoutes(
  app: FastifyInstance,
  hub: GatewayHub,
  tokens: TokenService,
  config: Config,
): void {
  const guard = createAuthGuard(tokens);

  app.get("/gateway", { preHandler: guard }, async (request, reply) => {
    const url = config.gatewayPublicUrl ?? buildGatewayUrl(request.protocol, request.headers.host);
    return reply.send({ url, version: GatewayVersion });
  });

  app.get("/gateway/ws", { websocket: true }, (socket) => {
    hub.attach(socket);
  });
}

function buildGatewayUrl(protocol: string, host: string | undefined): string {
  const scheme = protocol === "https" ? "wss" : "ws";
  const authority = host ?? "127.0.0.1:4000";
  return `${scheme}://${authority}/api/v1/gateway/ws`;
}

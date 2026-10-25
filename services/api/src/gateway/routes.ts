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
    const url = config.gatewayPublicUrl ?? buildGatewayUrl(request);
    return reply.send({ url, version: GatewayVersion });
  });

  app.get("/gateway/ws", { websocket: true }, (socket) => {
    hub.attach(socket);
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",")[0]?.trim();
}

/**
 * URL gateway mà client nên kết nối.
 *
 * Phải tôn trọng `x-forwarded-proto`/`x-forwarded-host`: khi API nằm sau proxy
 * TLS (preview, Vercel, nginx), `request.protocol` vẫn là `http` nên nếu chỉ dựa
 * vào nó sẽ trả `ws://` — trình duyệt đang mở trang https sẽ **chặn** vì mixed
 * content và gateway im lặng không kết nối được.
 */
export function buildGatewayUrl(request: {
  protocol: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const proto = forwardedProto ?? request.protocol;
  const host = forwardedHost ?? firstHeader(request.headers.host) ?? "127.0.0.1:4000";
  const scheme = proto === "https" || proto === "wss" ? "wss" : "ws";
  return `${scheme}://${host}/api/v1/gateway/ws`;
}

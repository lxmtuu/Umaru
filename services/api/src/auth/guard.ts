import type { Snowflake } from "@umaru/protocol";
import type { FastifyRequest } from "fastify";
import { unauthorized } from "../http.js";
import type { TokenService } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Được set bởi `createAuthGuard`; không bao giờ lấy từ body/query. */
    userId?: Snowflake;
  }
}

export function requireUserId(request: FastifyRequest): Snowflake {
  if (request.userId === undefined) throw unauthorized();
  return request.userId;
}

export function createAuthGuard(tokens: TokenService) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) {
      throw unauthorized("Thiếu access token");
    }
    try {
      const { userId } = await tokens.verifyAccessToken(header.slice("Bearer ".length).trim());
      request.userId = userId;
    } catch {
      throw unauthorized("Access token không hợp lệ hoặc đã hết hạn");
    }
  };
}

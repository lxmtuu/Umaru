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

/**
 * Lấy access token từ request.
 *
 * Ưu tiên `Authorization: Bearer <token>` (chuẩn, SDK/API client dùng).
 * Chấp nhận thêm `x-umaru-token` vì nhiều reverse proxy (Cloudflare Access,
 * gateway nội bộ, một số môi trường sandbox) **bỏ** header `Authorization`
 * trước khi chuyển tiếp — header tuỳ biến thì thường được giữ. Client web gửi
 * cả hai nên không phụ thuộc hạ tầng đứng trước.
 *
 * Tên scheme so sánh không phân biệt hoa/thường theo RFC 7235.
 */
export function readAccessToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const [scheme, ...rest] = header.split(" ");
    if (scheme?.toLowerCase() === "bearer") {
      const token = rest.join(" ").trim();
      if (token.length > 0) return token;
    }
  }
  const alias = request.headers["x-umaru-token"];
  if (typeof alias === "string" && alias.trim().length > 0) return alias.trim();
  return null;
}

export function createAuthGuard(tokens: TokenService) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = readAccessToken(request);
    if (token === null) {
      // Log để phân biệt "client không gửi" với "proxy nuốt header" khi debug
      // lỗi 401 trên môi trường triển khai (URL + header nào có mặt).
      request.log.warn(
        {
          url: request.url,
          hasAuthorization: request.headers.authorization !== undefined,
          hasAlias: request.headers["x-umaru-token"] !== undefined,
          host: request.headers.host,
          origin: request.headers.origin,
        },
        "401: không tìm thấy access token trong request",
      );
      throw unauthorized("Thiếu access token");
    }
    try {
      const { userId } = await tokens.verifyAccessToken(token);
      request.userId = userId;
    } catch {
      throw unauthorized("Access token không hợp lệ hoặc đã hết hạn");
    }
  };
}

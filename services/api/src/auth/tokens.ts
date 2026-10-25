import { createHash, randomBytes } from "node:crypto";
import type { Snowflake } from "@umaru/protocol";
import { SignJWT, jwtVerify } from "jose";

export interface TokenService {
  signAccessToken(userId: Snowflake): Promise<string>;
  verifyAccessToken(token: string): Promise<{ userId: Snowflake }>;
  createRefreshToken(): { token: string; hash: string };
  hashRefreshToken(token: string): string;
  accessTokenTtlSec: number;
}

export function createTokenService(
  secret: string,
  accessTokenTtlSec: number,
): TokenService {
  const key = new TextEncoder().encode(secret);
  const algorithm = "HS256";

  return {
    accessTokenTtlSec,
    async signAccessToken(userId: Snowflake): Promise<string> {
      return new SignJWT({ typ: "access" })
        .setProtectedHeader({ alg: algorithm })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + accessTokenTtlSec)
        .sign(key);
    },

    async verifyAccessToken(token: string): Promise<{ userId: Snowflake }> {
      const { payload } = await jwtVerify(token, key, { algorithms: [algorithm] });
      if (payload.typ !== "access" || typeof payload.sub !== "string" || !/^\d+$/.test(payload.sub)) {
        throw new Error("Access token không hợp lệ");
      }
      return { userId: payload.sub as Snowflake };
    },

    createRefreshToken(): { token: string; hash: string } {
      const token = randomBytes(32).toString("base64url");
      return { token, hash: this.hashRefreshToken(token) };
    },

    hashRefreshToken(token: string): string {
      return createHash("sha256").update(token).digest("hex");
    },
  };
}

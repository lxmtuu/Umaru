import { describe, expect, it } from "vitest";
import { buildGatewayUrl } from "../src/gateway/routes.js";
import { readAccessToken } from "../src/auth/guard.js";
import type { FastifyRequest } from "fastify";

const request = (headers: Record<string, string | string[] | undefined>, protocol = "http") =>
  ({ protocol, headers }) as unknown as FastifyRequest;

describe("readAccessToken", () => {
  it("đọc Bearer chuẩn", () => {
    expect(readAccessToken(request({ authorization: "Bearer abc.def" }))).toBe("abc.def");
  });

  it("chấp nhận scheme không phân biệt hoa/thường (RFC 7235)", () => {
    expect(readAccessToken(request({ authorization: "bearer abc" }))).toBe("abc");
    expect(readAccessToken(request({ authorization: "BEARER abc" }))).toBe("abc");
  });

  it("dùng x-umaru-token khi proxy bỏ header Authorization", () => {
    expect(readAccessToken(request({ "x-umaru-token": "abc" }))).toBe("abc");
  });

  it("không có token nào → null", () => {
    expect(readAccessToken(request({}))).toBeNull();
    expect(readAccessToken(request({ authorization: "Basic abc" }))).toBeNull();
    expect(readAccessToken(request({ authorization: "Bearer   " }))).toBeNull();
    expect(readAccessToken(request({ "x-umaru-token": "  " }))).toBeNull();
  });
});

describe("buildGatewayUrl", () => {
  it("dev thường: ws + host của API", () => {
    expect(buildGatewayUrl(request({ host: "127.0.0.1:4000" }))).toBe(
      "ws://127.0.0.1:4000/api/v1/gateway/ws",
    );
  });

  it("sau proxy TLS: dùng wss + host công khai (x-forwarded-*)", () => {
    expect(
      buildGatewayUrl(
        request({
          host: "127.0.0.1:4000",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "umaru.example.dev",
        }),
      ),
    ).toBe("wss://umaru.example.dev/api/v1/gateway/ws");
  });

  it("x-forwarded-proto có nhiều giá trị (chuỗi proxy) thì lấy cái đầu", () => {
    expect(
      buildGatewayUrl(
        request({ host: "api.dev", "x-forwarded-proto": "https,http" }),
      ),
    ).toBe("wss://api.dev/api/v1/gateway/ws");
  });

  it("không có host vẫn trả URL hợp lệ", () => {
    expect(buildGatewayUrl(request({}))).toBe("ws://127.0.0.1:4000/api/v1/gateway/ws");
  });
});

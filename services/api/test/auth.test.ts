import { LEGAL_VERSION } from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, registerUser, type TestContext } from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe("auth", () => {
  it("đăng ký trả 201, token dùng được cho /users/@me và không lộ email", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "alice",
        displayName: "Alice",
        email: "Alice@Example.com",
        password: "mat-khau-123",
        acceptedTerms: true,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      user: { id: string; username: string; displayName: string; status: string };
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      tokenType: string;
    }>();
    expect(body.user.username).toBe("alice");
    expect(body.user.displayName).toBe("Alice");
    expect(body.user.status).toBe("offline");
    expect(body.expiresIn).toBe(900);
    expect(body.tokenType).toBe("Bearer");
    expect(body.refreshToken.length).toBeGreaterThan(20);

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<Record<string, unknown>>();
    expect(meBody.id).toBe(body.user.id);
    expect(meBody.status).toBe("online");
    expect(meBody.email).toBeUndefined();
    expect(meBody.password_hash).toBeUndefined();
  });

  it("email được lưu lowercase và đăng nhập không phân biệt hoa thường", async () => {
    await registerUser(ctx, "bob");
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "BOB@example.com", password: "mat-khau-123" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json<{ user: { username: string } }>().user.username).toBe("bob");
  });

  it("trùng username / email trả 409", async () => {
    const dupUsername = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "alice",
        displayName: "Alice 2",
        email: "other@example.com",
        password: "mat-khau-123",
        acceptedTerms: true,
      },
    });
    expect(dupUsername.statusCode).toBe(409);

    const dupEmail = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "alice2",
        displayName: "Alice 2",
        email: "alice@example.com",
        password: "mat-khau-123",
        acceptedTerms: true,
      },
    });
    expect(dupEmail.statusCode).toBe(409);
  });

  it("sai mật khẩu trả 401 và không tiết lộ tài khoản có tồn tại hay không", async () => {
    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "bob@example.com", password: "sai-mat-khau" },
    });
    const unknown = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "khong-ton-tai@example.com", password: "sai-mat-khau" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("dữ liệu không hợp lệ bị từ chối 400", async () => {
    const shortPassword = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "carol",
        displayName: "Carol",
        email: "carol@example.com",
        password: "123",
        acceptedTerms: true,
      },
    });
    expect(shortPassword.statusCode).toBe(400);

    const badUsername = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "not valid!",
        displayName: "X",
        email: "x@example.com",
        password: "mat-khau-123",
        acceptedTerms: true,
      },
    });
    expect(badUsername.statusCode).toBe(400);
  });

  it("refresh token xoay vòng: token cũ không dùng lại được", async () => {
    const dave = await registerUser(ctx, "dave");
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: dave.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const refreshed = first.json<{ refreshToken: string; accessToken: string }>();
    expect(refreshed.refreshToken).not.toBe(dave.refreshToken);

    const reuse = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: dave.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: refreshed.refreshToken },
    });
    expect(second.statusCode).toBe(200);
  });

  it("logout thu hồi refresh token", async () => {
    const erin = await registerUser(ctx, "erin");
    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${erin.token}` },
      payload: { refreshToken: erin.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const refresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: erin.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it("thiếu / sai access token trả 401", async () => {
    const noToken = await ctx.app.inject({ method: "GET", url: "/api/v1/users/@me" });
    expect(noToken.statusCode).toBe(401);
    const badToken = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me",
      headers: { authorization: "Bearer khong-phai-jwt" },
    });
    expect(badToken.statusCode).toBe(401);
  });
});

describe("xác thực qua header dự phòng", () => {
  it("chấp nhận x-umaru-token như Bearer (khi proxy bỏ Authorization)", async () => {
    const ctx = await createTestContext();
    try {
      const user = await registerUser(ctx, "alias_user");
      const withAlias = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/users/@me",
        headers: { "x-umaru-token": user.token },
      });
      expect(withAlias.statusCode).toBe(200);
      expect(withAlias.json<{ username: string }>().username).toBe("alias_user");

      const noToken = await ctx.app.inject({ method: "GET", url: "/api/v1/users/@me" });
      expect(noToken.statusCode).toBe(401);
      expect(noToken.json<{ error: { message: string } }>().error.message).toBe(
        "Thiếu access token",
      );
    } finally {
      await ctx.close();
    }
  });

  it("thiếu đồng ý điều khoản → 400 và không tạo tài khoản", async () => {
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "noterms",
        displayName: "No terms",
        email: "noterms@example.com",
        password: "mat-khau-123",
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: { message: string } }>().error.message).toContain("Điều khoản");

    const falsy = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "noterms",
        displayName: "No terms",
        email: "noterms@example.com",
        password: "mat-khau-123",
        acceptedTerms: "true",
      },
    });
    // Chỉ nhận boolean true — chuỗi "true" không đủ để coi là đồng ý.
    expect(falsy.statusCode).toBe(400);

    const stillMissing = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "noterms@example.com", password: "mat-khau-123" },
    });
    expect(stillMissing.statusCode).toBe(401);
  });

  it("đăng ký hợp lệ ghi mốc + phiên bản điều khoản đã đồng ý", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "withterms",
        displayName: "With terms",
        email: "withterms@example.com",
        password: "mat-khau-123",
        acceptedTerms: true,
      },
    });
    expect(response.statusCode).toBe(201);

    const row = await ctx.pool.query<{ terms_version: string | null; terms_accepted_at: Date | null }>(
      "SELECT terms_version, terms_accepted_at FROM users WHERE email = $1",
      ["withterms@example.com"],
    );
    expect(row.rows[0]?.terms_version).toBe(LEGAL_VERSION);
    expect(row.rows[0]?.terms_accepted_at).not.toBeNull();
  });
});

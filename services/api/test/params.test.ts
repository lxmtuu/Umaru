import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, registerUser, type TestContext } from "./helpers.js";

/**
 * Tham số đường dẫn không phải snowflake phải là 400, không phải 500.
 * Trước đây giá trị thô đi vào `WHERE id = $1` (BIGINT) → PostgreSQL ném
 * `22P02` và client nhận "Lỗi hệ thống", log đầy lỗi DB.
 */
describe("kiểm snowflake ở tham số đường dẫn", () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    token = (await registerUser(ctx, "param_checker")).token;
  });

  afterAll(async () => {
    await ctx.close();
  });

  const cases: { method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"; url: string }[] = [
    { method: "GET", url: "/api/v1/channels/abc/messages" },
    { method: "POST", url: "/api/v1/channels/abc/messages" },
    { method: "GET", url: "/api/v1/channels/1.5/messages" },
    { method: "GET", url: "/api/v1/guilds/not-a-snowflake/roles" },
    { method: "GET", url: "/api/v1/guilds/not-a-snowflake/channels" },
    { method: "PATCH", url: "/api/v1/channels/abc" },
    { method: "DELETE", url: "/api/v1/channels/abc" },
    { method: "GET", url: "/api/v1/channels/abc/overwrites" },
    { method: "PUT", url: "/api/v1/channels/abc/overwrites/role/xyz" },
    { method: "PATCH", url: "/api/v1/messages/abc" },
    { method: "DELETE", url: "/api/v1/messages/abc" },
    { method: "POST", url: "/api/v1/channels/abc/read" },
    { method: "POST", url: "/api/v1/channels/abc/typing" },
    { method: "GET", url: "/api/v1/guilds/abc/roles" },
  ];

  it.each(cases)("$method $url → 400 kèm code BAD_REQUEST", async ({ method, url }) => {
    const response = await ctx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("BAD_REQUEST");
  });

  it("id hợp lệ nhưng không tồn tại vẫn là 404 (không đổi hành vi cũ)", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/channels/240000000000000000/messages",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("path param không phải id (invite code) vẫn đi qua bình thường", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/invites/khong-ton-tai",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });

  it("hook chạy trước guard xác thực: id sai là 400, id đúng thiếu token là 401", async () => {
    // Yêu cầu sai định dạng bị chặn ngay ở preValidation — không phụ thuộc token.
    const malformed = await ctx.app.inject({ method: "GET", url: "/api/v1/channels/abc/messages" });
    expect(malformed.statusCode).toBe(400);

    const anonymous = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/channels/240000000000000000/messages",
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

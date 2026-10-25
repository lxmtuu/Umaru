import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVerificationLink, buildVerificationMessage } from "../src/auth/verification.js";
import type { TestContext } from "./helpers.js";
import { createTestContext, registerUser } from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let ctx: TestContext;

beforeAll(async () => {
  // Bật echo token (mặc định cũng bật ở test) để không phải đọc hộp thư thật.
  ctx = await createTestContext({ EMAIL_VERIFICATION_ECHO: "1" });
});

afterAll(async () => {
  await ctx.close();
});

interface RegisterBody {
  user: { id: string; emailVerified: boolean };
  accessToken: string;
  devVerificationToken?: string;
  emailVerificationSent?: boolean;
}

async function register(email: string): Promise<RegisterBody> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      username: email.split("@")[0],
      displayName: "Người thử",
      email,
      password: "mat-khau-123",
      acceptedTerms: true,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<RegisterBody>();
}

const verify = (token: string) =>
  ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify-email", payload: { token } });

describe("xác thực email", () => {
  it("đăng ký: emailVerified=false, gửi mail kèm link chứa token", async () => {
    const email = "mailer-1@example.com";
    const body = await register(email);

    expect(body.user.emailVerified).toBe(false);
    expect(body.emailVerificationSent).toBe(true);
    expect(body.devVerificationToken).toBeTypeOf("string");

    const mail = ctx.mailer.lastTo(email);
    expect(mail).toBeDefined();
    expect(mail!.subject).toContain("Xác thực email");
    expect(mail!.text).toContain(`verifyToken=${body.devVerificationToken!}`);
    expect(mail!.html).toContain("verifyToken=");
  });

  it("xác thực bằng token trong mail → emailVerified=true ở /users/@me", async () => {
    const body = await register("mailer-2@example.com");
    const response = await verify(body.devVerificationToken!);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { emailVerified: boolean } }>().user.emailVerified).toBe(true);

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me",
      headers: auth(body.accessToken),
    });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(true);
  });

  it("token dùng một lần: bấm lại lần hai → 400", async () => {
    const body = await register("mailer-3@example.com");
    expect((await verify(body.devVerificationToken!)).statusCode).toBe(200);
    expect((await verify(body.devVerificationToken!)).statusCode).toBe(400);
  });

  it("token rác hoặc thiếu → 400", async () => {
    expect((await verify("khong-phai-token-that-dau-123456")).statusCode).toBe(400);
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: "a" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("token hết hạn → 400 dù chưa dùng", async () => {
    const body = await register("mailer-5@example.com");
    await ctx.pool.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 second'
        WHERE user_id = $1`,
      [body.user.id],
    );
    expect((await verify(body.devVerificationToken!)).statusCode).toBe(400);
  });

  it("gửi lại: chặn trong thời gian cooldown (429), hết cooldown thì token cũ bị vô hiệu", async () => {
    const body = await register("mailer-6@example.com");

    const early = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/resend",
      headers: auth(body.accessToken),
    });
    expect(early.statusCode).toBe(429);

    // Lùi created_at của token cũ ra ngoài cooldown thay vì chờ 60 giây thật.
    await ctx.pool.query(
      `UPDATE email_verification_tokens SET created_at = now() - interval '5 minutes'
        WHERE user_id = $1`,
      [body.user.id],
    );

    const resent = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/resend",
      headers: auth(body.accessToken),
    });
    expect(resent.statusCode).toBe(202);
    const token = resent.json<{ devVerificationToken?: string }>().devVerificationToken;
    expect(token).toBeTypeOf("string");
    expect(token).not.toBe(body.devVerificationToken);

    // Link cũ trong hộp thư không còn dùng được.
    expect((await verify(body.devVerificationToken!)).statusCode).toBe(400);
    expect((await verify(token!)).statusCode).toBe(200);
  });

  it("đã xác thực rồi thì gửi lại → 409", async () => {
    const body = await register("mailer-7@example.com");
    expect((await verify(body.devVerificationToken!)).statusCode).toBe(200);

    const again = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/resend",
      headers: auth(body.accessToken),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
  });

  it("gửi lại khi chưa đăng nhập → 401", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email/resend",
    });
    expect(response.statusCode).toBe(401);
  });

  it("EMAIL_VERIFICATION_ECHO=0 thì không trả token ra response", async () => {
    const silent = await createTestContext({ EMAIL_VERIFICATION_ECHO: "0" });
    try {
      const response = await silent.app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          username: "khongecho",
          displayName: "Không echo",
          email: "khong-echo@example.com",
          password: "mat-khau-123",
          acceptedTerms: true,
        },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<{ devVerificationToken?: string }>();
      expect(body.devVerificationToken).toBeUndefined();
      // Mail vẫn đi, token vẫn nằm trong link.
      expect(silent.mailer.lastTo("khong-echo@example.com")?.text).toContain("verifyToken=");
    } finally {
      await silent.close();
    }
  });

  it("đăng nhập vẫn được khi chưa xác thực (chỉ nhắc, không khoá tài khoản)", async () => {
    await register("mailer-9@example.com");
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "mailer-9@example.com", password: "mat-khau-123" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json<{ user: { emailVerified: boolean } }>().user.emailVerified).toBe(false);
  });
});

describe("nội dung mail xác thực", () => {
  const config = { publicWebUrl: "https://umaru.example/" } as Parameters<
    typeof buildVerificationLink
  >[0];

  it("link dựng từ PUBLIC_WEB_URL, không bị lặp dấu /", () => {
    expect(buildVerificationLink(config, "abc xyz")).toBe(
      "https://umaru.example/?verifyToken=abc%20xyz",
    );
  });

  it("escape HTML trong tên hiển thị và link", () => {
    const message = buildVerificationMessage({
      to: "a@b.c",
      displayName: '<b>An</b> & "Bo"',
      link: "https://x.test/?a=1&b=2",
      ttlHours: 24,
    });
    expect(message.html).toContain("&lt;b&gt;An&lt;/b&gt; &amp; &quot;Bo&quot;");
    expect(message.html).toContain("a=1&amp;b=2");
    expect(message.text).toContain("24 giờ");
  });
});

describe("registerUser helper (không hồi quy)", () => {
  it("vẫn trả token dùng được cho các test khác", async () => {
    const user = await registerUser(ctx, "helper-check");
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me",
      headers: auth(user.token),
    });
    expect(me.statusCode).toBe(200);
  });
});

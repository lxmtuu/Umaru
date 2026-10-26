import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  auth,
  createTestContext,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Đăng nhập OAuth2 (Google, GitHub).
 *
 * Sandbox/CI không có credential thật, nên phần **HTTP ra ngoài** được thay bằng
 * `fetch` giả; mọi thứ còn lại (state, callback, mã dùng một lần, liên kết theo
 * email đã xác thực, 2FA ở bước đổi mã) là đường code thật.
 *
 * Những chỗ dễ hỏng mà test này canh:
 *  - `state` phải dùng **một lần** (không thì CSRF quay lại được);
 *  - email **chưa** xác thực ở provider không được liên kết vào tài khoản có sẵn
 *    (lỗi kinh điển: tạo tài khoản GitHub với email người khác là chiếm được tài khoản);
 *  - token **không** nằm trong URL redirect — chỉ có mã dùng một lần;
 *  - OAuth **không** được là đường vòng qua 2FA;
 *  - mã đăng nhập chỉ dùng được một lần, sai 2FA quá số lần thì bị tiêu.
 */

const GOOGLE_ID = "google-client-id.apps.googleusercontent.com";
const GOOGLE_SECRET = "google-secret";
const WEB_URL = "http://web.test";
const API_URL = "http://api.test/api/v1";

let ctx: TestContext;
/** Hồ sơ mà "Google" sẽ trả cho lần gọi kế tiếp. */
let googleProfile: Record<string, unknown> = {};
/** Hồ sơ mà "GitHub" sẽ trả. */
let githubUser: Record<string, unknown> = {};
let githubEmails: Array<Record<string, unknown>> = [];
const calls: string[] = [];

/** `fetch` giả: chỉ nhận đúng các URL của provider, sai URL là lỗi test. */
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(JSON.stringify({ access_token: "google-access" }), { status: 200 });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return new Response(JSON.stringify(googleProfile), { status: 200 });
  }
  if (url === "https://github.com/login/oauth/access_token") {
    return new Response(JSON.stringify({ access_token: "github-access" }), { status: 200 });
  }
  if (url === "https://api.github.com/user") {
    return new Response(JSON.stringify(githubUser), { status: 200 });
  }
  if (url === "https://api.github.com/user/emails") {
    return new Response(JSON.stringify(githubEmails), { status: 200 });
  }
  throw new Error(`fetch giả không biết URL ${url}`);
}) as typeof fetch;

beforeAll(async () => {
  ctx = await createTestContext(
    {
      OAUTH_GOOGLE_CLIENT_ID: GOOGLE_ID,
      OAUTH_GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
      PUBLIC_WEB_URL: WEB_URL,
      PUBLIC_API_URL: API_URL,
      // GitHub **không** cấu hình: dùng để kiểm trạng thái "chưa bật".
    },
    { oauthFetch: fakeFetch },
  );
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await ctx.close();
});

function baseUrl(): string {
  return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/api/v1`;
}

async function start(provider = "google", acceptedTerms = true): Promise<string> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/auth/oauth/${provider}/start?acceptedTerms=${acceptedTerms ? "1" : "0"}`,
  });
  expect(response.statusCode).toBe(200);
  const url = new URL(response.json<{ url: string }>().url);
  return url.searchParams.get("state") ?? "";
}

/** Chạy trọn chặng callback, trả về URL mà trình duyệt được redirect tới. */
async function callback(state: string, code = "provider-code") {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/auth/oauth/google/callback?code=${code}&state=${state}`,
  });
  expect(response.statusCode).toBe(302);
  return new URL(response.headers.location as string);
}

function loginCodeFrom(location: URL): string {
  const code = location.searchParams.get("oauth_code");
  expect(code).not.toBeNull();
  return code as string;
}

async function exchange(code: string, body: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/oauth/exchange",
    payload: { code, ...body },
  });
}

describe("OAuth — cấu hình và bắt đầu", () => {
  it("chỉ liệt kê provider đã cấu hình đủ id + secret", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/auth/oauth/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ providers: Array<{ id: string; label: string }> }>().providers).toEqual([
      { id: "google", label: "Google" },
    ]);
  });

  it("provider chưa cấu hình → 404, không phải 'nửa bật'", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/oauth/github/start",
    });
    expect(response.statusCode).toBe(404);
  });

  it("start trả URL đồng ý của Google kèm state, redirect_uri và scope", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/oauth/google/start",
    });
    const url = new URL(response.json<{ url: string }>().url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(GOOGLE_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${API_URL}/auth/oauth/google/callback`,
    );
    expect(url.searchParams.get("scope")).toContain("email");
    expect((url.searchParams.get("state") ?? "").length).toBeGreaterThan(20);
  });

  it("provider lạ → 404", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/oauth/facebook/start",
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("OAuth — callback và đổi mã", () => {
  it("người dùng huỷ ở provider → redirect kèm oauth_error, không có token", async () => {
    const state = await start();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/auth/oauth/google/callback?error=access_denied&state=${state}`,
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get("oauth_error")).toBe("access_denied");
    expect(location.searchParams.get("access_token")).toBeNull();
  });

  it("state dùng một lần: lần thứ hai trả lỗi state", async () => {
    const state = await start();
    googleProfile = { sub: "g-1", email: "motlan@example.com", email_verified: true, name: "Một Lần" };
    await callback(state);
    const second = new URL(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/auth/oauth/google/callback?code=x&state=${state}`,
        })
      ).headers.location as string,
    );
    expect(second.searchParams.get("oauth_error")).toBe("state");
  });

  it("tạo tài khoản mới từ Google, token KHÔNG nằm trong URL", async () => {
    googleProfile = {
      sub: "g-new",
      email: "nguoi.moi@example.com",
      email_verified: true,
      name: "Người Mới",
    };
    const state = await start();
    const location = await callback(state);
    expect(location.origin + location.pathname).toBe(`${WEB_URL}/`);
    expect(location.searchParams.get("access_token")).toBeNull();
    expect(location.searchParams.get("refresh_token")).toBeNull();
    const code = loginCodeFrom(location);

    const exchanged = await exchange(code);
    expect(exchanged.statusCode).toBe(200);
    const body = exchanged.json<{
      user: { username: string; id: string };
      accessToken: string;
      provider: string;
    }>();
    expect(body.accessToken.length).toBeGreaterThan(20);
    expect(body.user.username).toBe("nguoi.moi");
    expect(body.provider).toBe("google");

    // Tài khoản OAuth không có mật khẩu ⇒ đăng nhập bằng mật khẩu phải nói rõ.
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nguoi.moi@example.com", password: "bat-ky-thu-gi" },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json<{ error: { code: string } }>().error.code).toBe("PASSWORD_NOT_SET");
  });

  it("mã đăng nhập chỉ dùng được một lần", async () => {
    googleProfile = { sub: "g-once", email: "once@example.com", email_verified: true, name: "Once" };
    const code = loginCodeFrom(await callback(await start()));
    expect((await exchange(code)).statusCode).toBe(200);
    const second = await exchange(code);
    expect(second.statusCode).toBe(401);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("OAUTH_CODE_INVALID");
  });

  it("mã rác bị từ chối", async () => {
    const response = await exchange("khong-phai-ma-dang-nhap-hop-le");
    expect(response.statusCode).toBe(401);
  });

  it("chưa tick điều khoản thì không tạo tài khoản mới", async () => {
    googleProfile = { sub: "g-terms", email: "terms@example.com", email_verified: true, name: "Terms" };
    const location = await callback(await start("google", false));
    expect(location.searchParams.get("oauth_error")).toBe("oauth_terms_required");
    expect(location.searchParams.get("oauth_code")).toBeNull();
  });
});

describe("OAuth — liên kết tài khoản", () => {
  it("email đã xác thực và đã có tài khoản → liên kết vào tài khoản đó", async () => {
    const existing: RegisteredUser = await registerUser(ctx, "oauth_link", "mat-khau-123");
    const email = `${existing.username}@example.com`;
    googleProfile = { sub: "g-link", email, email_verified: true, name: "Liên Kết" };
    const code = loginCodeFrom(await callback(await start()));
    const result = await exchange(code);
    expect(result.statusCode).toBe(200);
    // Cùng user id ⇒ đăng nhập vào tài khoản cũ, không tạo tài khoản thứ hai.
    expect(result.json<{ user: { id: string } }>().user.id).toBe(existing.id);

    const accounts = await ctx.pool.query(
      "SELECT provider, provider_user_id FROM oauth_accounts WHERE user_id = $1",
      [existing.id],
    );
    expect(accounts.rows).toEqual([{ provider: "google", provider_user_id: "g-link" }]);
  });

  it("email CHƯA xác thực thì không liên kết — trả lỗi thay vì chiếm tài khoản", async () => {
    const victim: RegisteredUser = await registerUser(ctx, "oauth_victim", "mat-khau-123");
    const email = `${victim.username}@example.com`;
    googleProfile = { sub: "g-attacker", email, email_verified: false, name: "Kẻ Giả" };
    const location = await callback(await start());
    expect(location.searchParams.get("oauth_error")).toBe("oauth_email_taken");
    expect(location.searchParams.get("oauth_code")).toBeNull();

    // Không có dòng liên kết nào được tạo ⇒ không chiếm được tài khoản.
    const accounts = await ctx.pool.query(
      "SELECT 1 FROM oauth_accounts WHERE user_id = $1",
      [victim.id],
    );
    expect(accounts.rowCount).toBe(0);
  });

  it("đăng nhập lần hai bằng cùng tài khoản Google → cùng user", async () => {
    googleProfile = { sub: "g-return", email: "quay.lai@example.com", email_verified: true, name: "Quay Lại" };
    const first = (await exchange(loginCodeFrom(await callback(await start())))).json<{
      user: { id: string };
    }>();
    // Đổi tên hiển thị ở provider không tạo user mới.
    googleProfile = { sub: "g-return", email: "quay.lai@example.com", email_verified: true, name: "Tên Khác" };
    const second = (await exchange(loginCodeFrom(await callback(await start())))).json<{
      user: { id: string };
    }>();
    expect(second.user.id).toBe(first.user.id);
  });
});

describe("OAuth — 2FA không bị bỏ qua", () => {
  it("tài khoản đã bật 2FA: exchange thiếu mã → TOTP_REQUIRED, có mã đúng → token", async () => {
    const user: RegisteredUser = await registerUser(ctx, "oauth_2fa", "mat-khau-123");
    // Bật TOTP qua API (đường thật, giống người dùng thật làm trong hồ sơ).
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/setup",
      headers: auth(user.token),
      payload: {},
    });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json<{ secret: string }>().secret;
    const { totpAt } = await import("../src/auth/totp.js");
    const totpNow = () => totpAt(secret, Date.now()).code;
    const enabled = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/enable",
      headers: auth(user.token),
      payload: { code: totpNow() },
    });
    expect(enabled.statusCode).toBe(200);

    const email = `${user.username}@example.com`;
    googleProfile = { sub: "g-2fa", email, email_verified: true, name: "Hai Lớp" };
    const code = loginCodeFrom(await callback(await start()));

    const withoutCode = await exchange(code);
    expect(withoutCode.statusCode).toBe(401);
    expect(withoutCode.json<{ error: { code: string } }>().error.code).toBe("TOTP_REQUIRED");

    // Sai mã: bị đếm, và mã đăng nhập vẫn còn dùng được cho lần đúng.
    const wrong = await exchange(code, { totpCode: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe("INVALID_TOTP");

    const correct = await exchange(code, { totpCode: totpNow() });
    expect(correct.statusCode).toBe(200);
    expect(correct.json<{ user: { id: string } }>().user.id).toBe(user.id);
  });

  it("sai 2FA quá 5 lần thì mã đăng nhập bị tiêu", async () => {
    const user: RegisteredUser = await registerUser(ctx, "oauth_2fa_brute", "mat-khau-123");
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/setup",
      headers: auth(user.token),
      payload: {},
    });
    const secret = setup.json<{ secret: string }>().secret;
    const { totpAt } = await import("../src/auth/totp.js");
    const totpNow = () => totpAt(secret, Date.now()).code;
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/enable",
      headers: auth(user.token),
      payload: { code: totpNow() },
    });

    googleProfile = {
      sub: "g-2fa-brute",
      email: `${user.username}@example.com`,
      email_verified: true,
      name: "Brute",
    };
    const code = loginCodeFrom(await callback(await start()));
    // Mã sai cố định — mã 000000 gần như chắc chắn không trùng bước hiện tại.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await exchange(code, { totpCode: "000000" });
    }
    // Lần thứ 6: mã đăng nhập đã bị tiêu, kể cả khi mã TOTP đúng.
    const after = await exchange(code, { totpCode: totpNow() });
    expect(after.statusCode).toBe(401);
    expect(after.json<{ error: { code: string } }>().error.code).toBe("OAUTH_CODE_INVALID");
  });
});

describe("OAuth — GitHub (email ẩn)", () => {
  it("lấy email đã xác thực từ /user/emails khi /user không trả email", async () => {
    // Bật GitHub bằng cách dựng app thứ hai có cấu hình GitHub.
    const github = await createTestContext(
      {
        OAUTH_GITHUB_CLIENT_ID: "gh-id",
        OAUTH_GITHUB_CLIENT_SECRET: "gh-secret",
        PUBLIC_WEB_URL: WEB_URL,
        PUBLIC_API_URL: API_URL,
      },
      { oauthFetch: fakeFetch },
    );
    try {
      calls.length = 0;
      githubUser = { id: 4242, login: "octocat", name: null, email: null, avatar_url: null };
      githubEmails = [
        { email: "cu@example.com", primary: false, verified: true },
        { email: "octocat@example.com", primary: true, verified: true },
      ];
      const started = await github.app.inject({
        method: "GET",
        url: "/api/v1/auth/oauth/github/start?acceptedTerms=1",
      });
      expect(started.statusCode).toBe(200);
      const authorizeUrl = new URL(started.json<{ url: string }>().url);
      expect(authorizeUrl.origin).toBe("https://github.com");
      expect(authorizeUrl.searchParams.get("scope")).toContain("user:email");

      const callbacks = await github.app.inject({
        method: "GET",
        url: `/api/v1/auth/oauth/github/callback?code=abc&state=${authorizeUrl.searchParams.get("state")}`,
      });
      expect(callbacks.statusCode).toBe(302);
      const location = new URL(callbacks.headers.location as string);
      const code = location.searchParams.get("oauth_code");
      expect(code).not.toBeNull();

      const exchanged = await github.app.inject({
        method: "POST",
        url: "/api/v1/auth/oauth/exchange",
        payload: { code },
      });
      expect(exchanged.statusCode).toBe(200);
      // Username lấy từ email chính (đã xác thực), không phải `null` của /user.
      expect(exchanged.json<{ user: { username: string } }>().user.username).toBe("octocat");
      // Đã gọi đúng cả ba endpoint của GitHub.
      expect(calls).toContain("GET https://api.github.com/user/emails");
    } finally {
      await github.close();
    }
  });
});

describe("OAuth — gỡ liên kết", () => {
  it("không cho gỡ cách đăng nhập duy nhất của tài khoản OAuth-only", async () => {
    googleProfile = { sub: "g-unlink", email: "unlink@example.com", email_verified: true, name: "Unlink" };
    const login = await exchange(loginCodeFrom(await callback(await start())));
    const token = login.json<{ accessToken: string }>().accessToken;

    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/oauth/google",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(400);
    // Dòng liên kết vẫn còn (không xoá rồi mới phát hiện là đường duy nhất).
    const still = await ctx.pool.query("SELECT 1 FROM oauth_accounts WHERE provider_user_id = 'g-unlink'");
    expect(still.rowCount).toBe(1);
  });

  it("tài khoản có mật khẩu thì gỡ được", async () => {
    const user: RegisteredUser = await registerUser(ctx, "oauth_unlink_ok", "mat-khau-123");
    googleProfile = {
      sub: "g-unlink-ok",
      email: `${user.username}@example.com`,
      email_verified: true,
      name: "Gỡ Được",
    };
    const login = await exchange(loginCodeFrom(await callback(await start())));
    const token = login.json<{ accessToken: string }>().accessToken;

    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/oauth/google",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(204);
    const gone = await ctx.pool.query("SELECT 1 FROM oauth_accounts WHERE user_id = $1", [user.id]);
    expect(gone.rowCount).toBe(0);
  });
});

describe("Tài khoản liên kết — xem và đặt mật khẩu", () => {
  it("GET /users/@me/oauth trả provider đã liên kết + hasPassword=false cho tài khoản OAuth-only", async () => {
    googleProfile = { sub: "g-list", email: "list@example.com", email_verified: true, name: "List" };
    const login = await exchange(loginCodeFrom(await callback(await start())));
    const token = login.json<{ accessToken: string }>().accessToken;

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/oauth",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ accounts: Array<{ provider: string; label: string }>; hasPassword: boolean }>();
    expect(body.hasPassword).toBe(false);
    expect(body.accounts.map((entry) => entry.provider)).toEqual(["google"]);
    expect(body.accounts[0]?.label).toBe("Google");
  });

  it("tài khoản OAuth-only đặt được mật khẩu, sau đó đăng nhập bằng mật khẩu", async () => {
    googleProfile = { sub: "g-pw", email: "pw@example.com", email_verified: true, name: "Pw" };
    const login = await exchange(loginCodeFrom(await callback(await start())));
    const token = login.json<{ accessToken: string }>().accessToken;

    const set = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/password",
      headers: auth(token),
      payload: { password: "mat-khau-moi-123" },
    });
    expect(set.statusCode).toBe(204);

    const signIn = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pw@example.com", password: "mat-khau-moi-123" },
    });
    expect(signIn.statusCode).toBe(200);

    // Đã có mật khẩu ⇒ gỡ provider cuối cùng được (không còn tự khoá ngoài).
    const unlink = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/oauth/google",
      headers: auth(token),
    });
    expect(unlink.statusCode).toBe(204);
  });

  it("đổi mật khẩu khi đã có mật khẩu thì phải đúng mật khẩu hiện tại", async () => {
    const user = await registerUser(ctx, "oauth_pw_change", "mat-khau-123");
    const signIn = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `${user.username}@example.com`, password: "mat-khau-123" },
    });
    const token = signIn.json<{ accessToken: string }>().accessToken;

    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/password",
      headers: auth(token),
      payload: { password: "mat-khau-moi-456", currentPassword: "sai-mat-khau" },
    });
    expect(wrong.statusCode).toBe(401);

    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/password",
      headers: auth(token),
      payload: { password: "mat-khau-moi-456" },
    });
    expect(missing.statusCode).toBe(401);

    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/password",
      headers: auth(token),
      payload: { password: "mat-khau-moi-456", currentPassword: "mat-khau-123" },
    });
    expect(ok.statusCode).toBe(204);

    const oldPassword = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `${user.username}@example.com`, password: "mat-khau-123" },
    });
    expect(oldPassword.statusCode).toBe(401);
  });

  it("mật khẩu ngắn bị từ chối; chưa đăng nhập thì 401", async () => {
    const user = await registerUser(ctx, "oauth_pw_short", "mat-khau-123");
    const signIn = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `${user.username}@example.com`, password: "mat-khau-123" },
    });
    const token = signIn.json<{ accessToken: string }>().accessToken;

    const short = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/password",
      headers: auth(token),
      payload: { password: "ngan", currentPassword: "mat-khau-123" },
    });
    expect(short.statusCode).toBe(400);

    const anonymous = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/password",
      payload: { password: "mat-khau-moi-789" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("GET /users/@me/oauth cần đăng nhập", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/users/@me/oauth" });
    expect(response.statusCode).toBe(401);
  });
});

describe("OAuth — baseUrl không dùng tới nhưng giữ để soi log khi cần", () => {
  it("app lắng nghe trên cổng thật (callback cần URL công khai)", () => {
    expect(baseUrl()).toContain("http://127.0.0.1:");
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from "../src/auth/totp.js";
import {
  auth,
  createTestContext,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Xác thực hai lớp.
 *
 * Hai tầng: (1) phần crypto thuần — vector RFC 6238, base32, cửa sổ thời gian,
 * chống replay; (2) luồng thật qua HTTP — setup → enable → login bắt buộc mã →
 * mã khôi phục dùng một lần → tắt cần mật khẩu. Tầng 2 mới là chỗ chứng minh
 * "bật 2FA không tự khoá mình ra ngoài".
 */

/** Vector RFC 6238 (SHA-1) cho bí mật `12345678901234567890`. */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp (thuần)", () => {
  it("base32 khớp vector RFC 4648", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode("mzxw6ytboi=====").toString()).toBe("foobar");
    expect(() => base32Decode("MZXW6YTBO1")).toThrow(/base32/u);
  });

  it("khớp vector RFC 6238 (SHA-1, 8 chữ số rút về 6)", () => {
    // RFC dùng 8 chữ số; mã 6 chữ số là 6 số cuối của cùng giá trị.
    const cases: Array<[number, string]> = [
      [59, "287082"], // T=59s → 94287082
      [1111111109, "081804"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [seconds, expected] of cases) {
      expect(totpAt(RFC_SECRET, seconds * 1000).code).toBe(expected);
    }
  });

  it("bí mật sinh ra là base32 32 ký tự, mỗi lần một khác", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/u);
    expect(a).not.toBe(b);
  });

  it("nhận mã đúng, chấp nhận lệch ±1 bước, từ chối lệch 2 bước", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const current = totpAt(secret, now).code;
    expect(verifyTotp(secret, current, { now }).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 30_000).code, { now }).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000).code, { now }).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 60_000).code, { now }).ok).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, now + 90_000).code, { now }).ok).toBe(false);
  });

  it("chấp nhận mã có khoảng trắng, từ chối chuỗi không phải 6 số", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpAt(secret, now).code;
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok).toBe(true);
    expect(verifyTotp(secret, "12345", { now }).ok).toBe(false);
    expect(verifyTotp(secret, "abcdef", { now }).ok).toBe(false);
    expect(verifyTotp(secret, "", { now }).ok).toBe(false);
  });

  it("mã đã dùng (cùng bước hoặc cũ hơn) bị từ chối — chống replay", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const { code, step } = totpAt(secret, now);
    expect(verifyTotp(secret, code, { now }).ok).toBe(true);
    // Đã tiêu bước này rồi thì mã đó không dùng lại được, dù vẫn còn hạn.
    expect(verifyTotp(secret, code, { now, lastStep: step }).ok).toBe(false);
    // Bước kế tiếp vẫn dùng được.
    expect(verifyTotp(secret, totpAt(secret, now + 30_000).code, { now: now + 30_000, lastStep: step }).ok).toBe(true);
  });

  it("URI otpauth đúng định dạng authenticator đọc được", () => {
    const url = new URL(otpauthUrl("ABCDEFGH23456789", "minh"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(url.pathname).toBe("/Umaru:minh");
    expect(url.searchParams.get("secret")).toBe("ABCDEFGH23456789");
    expect(url.searchParams.get("issuer")).toBe("Umaru");
    expect(url.searchParams.get("digits")).toBe("6");
    expect(url.searchParams.get("period")).toBe("30");
    expect(url.searchParams.get("algorithm")).toBe("SHA1");
  });

  it("mã khôi phục: 10 mã, không trùng, chuẩn hoá được khi người dùng gõ", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/u);
    expect(normalizeRecoveryCode(" ABCDE-FGHJK ")).toBe("abcdefghjk");
    // Chép tay có thể mất gạch hoặc gõ hoa — hash vẫn khớp.
    expect(hashRecoveryCode("ABCDE-FGHJK")).toBe(hashRecoveryCode("abcde fghjk"));
  });
});

describe("luồng 2FA qua HTTP", () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  /** `RegisteredUser` không mang email (helpers chỉ trả token) — test này cần. */
  const email = "totp_alice@example.com";

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await registerUser(ctx, "totp_alice");
  });

  afterAll(async () => {
    await ctx.close();
  });

  function login(payload: Record<string, unknown>) {
    return ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
  }

  async function currentCode(): Promise<string> {
    const status = await ctx.pool.query<{ secret: string }>(
      "SELECT secret FROM user_totp WHERE user_id = $1",
      [alice.id],
    );
    return totpAt(status.rows[0]!.secret, Date.now()).code;
  }

  it("tài khoản chưa bật → /security nói chưa bật", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/security",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ totpEnabled: false, recoveryCodesLeft: 0 });
  });

  it("setup trả bí mật + otpauth nhưng **chưa** chặn đăng nhập", async () => {
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/setup",
      headers: auth(alice.token),
    });
    expect(setup.statusCode).toBe(200);
    const body = setup.json<{ secret: string; otpauthUrl: string; secretGroups: string }>();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(body.otpauthUrl).toContain("otpauth://totp/Umaru:totp_alice");
    expect(body.secretGroups.replace(/ /gu, "")).toBe(body.secret);

    // Chưa xác nhận mã đầu tiên ⇒ 2FA chưa có hiệu lực (không tự khoá mình).
    const loginResponse = await login({ email, password: "mat-khau-123" });
    expect(loginResponse.statusCode).toBe(200);
  });

  it("enable với mã sai bị từ chối; mã đúng thì bật và trả 10 mã khôi phục", async () => {
    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/enable",
      headers: auth(alice.token),
      payload: { code: "000000" },
    });
    // Có 1/1e6 khả năng mã 000000 đúng — chấp nhận rủi ro cực nhỏ, hoặc mã này
    // sẽ rơi vào nhánh 200 và test dưới đỏ để ta biết.
    expect(wrong.statusCode).toBe(401);

    const enabled = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/enable",
      headers: auth(alice.token),
      payload: { code: await currentCode() },
    });
    expect(enabled.statusCode).toBe(200);
    const { recoveryCodes } = enabled.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);

    const security = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/security",
      headers: auth(alice.token),
    });
    expect(security.json()).toEqual({ totpEnabled: true, recoveryCodesLeft: 10 });
  });

  it("đăng nhập không có mã → 401 TOTP_REQUIRED (không phải sai mật khẩu)", async () => {
    const response = await login({ email, password: "mat-khau-123" });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("TOTP_REQUIRED");
  });

  it("mã sai → 401 INVALID_TOTP, mật khẩu sai vẫn là UNAUTHORIZED", async () => {
    const invalid = await login({
      email: email,
      password: "mat-khau-123",
      totpCode: "000000",
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("INVALID_TOTP");

    const wrongPassword = await login({ email: email, password: "sai-mat-khau" });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("mã đúng → đăng nhập được; dùng lại chính mã đó bị chặn (chống replay)", async () => {
    const code = await currentCode();
    const first = await login({ email: email, password: "mat-khau-123", totpCode: code });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ accessToken: string }>().accessToken).toBeTypeOf("string");

    const replay = await login({ email: email, password: "mat-khau-123", totpCode: code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("INVALID_TOTP");
  });

  it("mã khôi phục đăng nhập được **đúng một lần**", async () => {
    // Bản rõ chỉ tồn tại đúng một lần trong response lúc sinh mã — DB chỉ có
    // hash, nên muốn mã thật để test thì phải sinh lại bộ mới.
    const regenerated = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/recovery-codes",
      headers: auth(alice.token),
      payload: { password: "mat-khau-123" },
    });
    expect(regenerated.statusCode).toBe(200);
    const fresh = regenerated.json<{ recoveryCodes: string[] }>().recoveryCodes[0]!;

    const used = await login({
      email: email,
      password: "mat-khau-123",
      recoveryCode: fresh,
    });
    expect(used.statusCode).toBe(200);
    expect(used.json<{ usedRecoveryCode?: boolean }>().usedRecoveryCode).toBe(true);

    const again = await login({
      email: email,
      password: "mat-khau-123",
      recoveryCode: fresh,
    });
    expect(again.statusCode).toBe(401);
  });

  it("tắt 2FA cần mật khẩu; sai mật khẩu thì vẫn bật", async () => {
    const wrong = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/disable",
      headers: auth(alice.token),
      payload: { password: "khong-dung" },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/security/totp/disable",
      headers: auth(alice.token),
      payload: { password: "mat-khau-123" },
    });
    expect(ok.statusCode).toBe(204);

    // Đã tắt ⇒ không cần mã nữa.
    const plain = await login({ email: email, password: "mat-khau-123" });
    expect(plain.statusCode).toBe(200);

    const left = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_recovery_codes WHERE user_id = $1",
      [alice.id],
    );
    expect(left.rows[0]?.count).toBe("0");
  });

  it("không lộ bí mật TOTP ra bất kỳ endpoint nào khác", async () => {
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me",
      headers: auth(alice.token),
    });
    const secret = await ctx.pool.query<{ secret: string }>(
      "SELECT secret FROM user_totp WHERE user_id = $1",
      [alice.id],
    );
    if (secret.rows[0] !== undefined) {
      expect(me.body).not.toContain(secret.rows[0].secret);
    }
    expect(me.body).not.toContain("secret");
    expect(me.body).not.toContain("recovery");
  });
});

import { ApiError } from "@umaru/sdk";
import { describe, expect, it } from "vitest";
import { isTotpRequired } from "./chatStore.js";

/**
 * Cổng 2FA ở client.
 *
 * Điểm quan trọng: `TOTP_REQUIRED` **không** được hiện như lỗi "sai mật khẩu".
 * Người dùng vừa gõ đúng mật khẩu, hiện "Email hoặc mật khẩu không đúng" là chỉ
 * đường sai hoàn toàn (họ sẽ đi đổi mật khẩu). Hàm này là chỗ duy nhất phân biệt.
 */
function errorWith(code: string | undefined): ApiError {
  return new ApiError(401, "API /auth/login thất bại: 401", {
    error: { code, message: "..." },
  });
}

describe("isTotpRequired", () => {
  it("nhận đúng mã lỗi TOTP_REQUIRED", () => {
    expect(isTotpRequired(errorWith("TOTP_REQUIRED"))).toBe(true);
  });

  it("các lỗi 401 khác thì không", () => {
    expect(isTotpRequired(errorWith("INVALID_TOTP"))).toBe(false);
    expect(isTotpRequired(errorWith("UNAUTHORIZED"))).toBe(false);
    expect(isTotpRequired(errorWith(undefined))).toBe(false);
  });

  it("body lạ (không có error.code) hoặc lỗi không phải ApiError", () => {
    expect(isTotpRequired(new ApiError(401, "x"))).toBe(false);
    expect(isTotpRequired(new ApiError(401, "x", "chuỗi"))).toBe(false);
    expect(isTotpRequired(new Error("TOTP_REQUIRED"))).toBe(false);
    expect(isTotpRequired(null)).toBe(false);
  });
});

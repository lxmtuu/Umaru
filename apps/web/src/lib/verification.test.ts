import { describe, expect, it } from "vitest";
import { readVerificationToken, withoutVerificationToken } from "./verification.js";

const TOKEN = "a".repeat(43);

describe("readVerificationToken", () => {
  it("đọc token từ query string", () => {
    expect(readVerificationToken(`?verifyToken=${TOKEN}`)).toBe(TOKEN);
    expect(readVerificationToken(`?a=1&verifyToken=${TOKEN}&b=2`)).toBe(TOKEN);
  });

  it("không có token → null", () => {
    expect(readVerificationToken("")).toBeNull();
    expect(readVerificationToken("?other=1")).toBeNull();
  });

  it("token quá ngắn hoặc quá dài → null (không gọi API vô ích)", () => {
    expect(readVerificationToken("?verifyToken=abc")).toBeNull();
    expect(readVerificationToken(`?verifyToken=${"a".repeat(201)}`)).toBeNull();
  });

  it("token có ký tự base64url được giải mã đúng", () => {
    const token = "ab-_CDefghijklmnopqrstuvwxyz0123456789ABCDEF";
    expect(readVerificationToken(`?verifyToken=${token}`)).toBe(token);
  });
});

describe("withoutVerificationToken", () => {
  it("bỏ verifyToken, giữ tham số khác và hash", () => {
    expect(withoutVerificationToken(`http://x.test/?verifyToken=${TOKEN}&lang=vi#chat`)).toBe(
      "/?lang=vi#chat",
    );
  });

  it("không còn tham số nào thì về '/'", () => {
    expect(withoutVerificationToken(`/?verifyToken=${TOKEN}`)).toBe("/");
  });

  it("URL không có token giữ nguyên", () => {
    expect(withoutVerificationToken("http://x.test/app?lang=vi")).toBe("/app?lang=vi");
  });
});

import { describe, expect, it } from "vitest";
import { readOAuthResult, withoutOAuthParams } from "./oauthQuery.js";

const CODE = "k".repeat(43);

describe("readOAuthResult", () => {
  it("đọc mã một lần từ ?oauth_code và bỏ các tham số khác đi kèm", () => {
    expect(readOAuthResult(`?oauth_code=${CODE}`)).toEqual({ code: CODE, error: null });
    expect(readOAuthResult(`?a=1&oauth_code=${CODE}`)).toEqual({ code: CODE, error: null });
  });

  it("đọc lý do lỗi, hạ chữ thường", () => {
    expect(readOAuthResult("?oauth_error=ACCESS_DENIED")).toEqual({
      code: null,
      error: "access_denied",
    });
    expect(readOAuthResult("?oauth_error=oauth_email_taken")?.error).toBe("oauth_email_taken");
  });

  it("mã quá ngắn/quá dài thì coi như không có (không gọi server với rác)", () => {
    expect(readOAuthResult("?oauth_code=abc")).toBeNull();
    expect(readOAuthResult(`?oauth_code=${"k".repeat(201)}`)).toBeNull();
  });

  it("không có tham số OAuth thì trả null — boot đi đường thường", () => {
    expect(readOAuthResult("")).toBeNull();
    expect(readOAuthResult("?verifyToken=abc")).toBeNull();
    expect(readOAuthResult("?oauth_error=")).toBeNull();
  });

  it("không render bất cứ thứ gì từ URL: lý do lỗi dài bị bỏ", () => {
    expect(readOAuthResult(`?oauth_error=${"x".repeat(41)}`)).toBeNull();
  });
});

describe("withoutOAuthParams", () => {
  it("xoá mã khỏi URL, giữ tham số khác và hash", () => {
    expect(withoutOAuthParams(`https://umaru.dev/channels/42?oauth_code=${CODE}&keep=1#m`)).toBe(
      "/channels/42?keep=1#m",
    );
  });

  it("xoá cả lý do lỗi", () => {
    expect(withoutOAuthParams("https://umaru.dev/?oauth_error=state")).toBe("/");
  });

  it("không đụng verifyToken", () => {
    expect(withoutOAuthParams(`https://umaru.dev/?oauth_code=${CODE}&verifyToken=abc`)).toBe(
      "/?verifyToken=abc",
    );
  });
});

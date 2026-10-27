import { describe, expect, it } from "vitest";
import { oauthErrorKey } from "./chatStore.js";
import { translate } from "./i18n.js";

/**
 * `?oauth_error=` là dữ liệu từ URL, nên **không** được render thẳng. Hàm này
 * biến nó thành một khoá i18n cố định; lý do lạ (kể cả chuỗi do kẻ tấn công
 * chèn) rơi về câu chung.
 */
describe("oauthErrorKey", () => {
  it("ánh xạ các lý do server thật sự gửi", () => {
    expect(oauthErrorKey("access_denied")).toBe("oauthCancelled");
    expect(oauthErrorKey("state")).toBe("oauthExpired");
    expect(oauthErrorKey("code")).toBe("oauthExpired");
    expect(oauthErrorKey("oauth_email_taken")).toBe("oauthEmailTaken");
    expect(oauthErrorKey("account")).toBe("oauthAccountFailed");
    expect(oauthErrorKey("provider")).toBe("oauthProviderFailed");
  });

  it("lý do lạ hoặc chuỗi chèn vào URL → câu chung, không phải text tuỳ ý", () => {
    expect(oauthErrorKey("<script>alert(1)</script>")).toBe("oauthProviderFailed");
    expect(oauthErrorKey("")).toBe("oauthProviderFailed");
  });

  it("mọi khoá trả về đều có bản dịch (không hiện key thô)", () => {
    for (const reason of ["access_denied", "state", "code", "oauth_email_taken", "account", "x"]) {
      const key = oauthErrorKey(reason);
      expect(translate(key)).toBeTypeOf("string");
      expect(translate(key).length).toBeGreaterThan(0);
      expect(translate(key)).not.toBe(key);
    }
  });
});

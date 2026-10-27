import { describe, expect, it } from "vitest";
import {
  BANNER_COLORS,
  MAX_BIO_LENGTH,
  MAX_PRONOUNS_LENGTH,
  bannerColorOf,
  buildProfilePatch,
  characterCount,
  draftFromUser,
  isPatchEmpty,
  readableTextOn,
  sameDraft,
  type ProfileDraft,
} from "./profileForm.js";

/**
 * Phần thuần của form hồ sơ.
 *
 * Trọng tâm: patch chỉ chứa trường **đã đổi** (chống ghi đè giữa hai tab), và
 * các giá trị đi vào `style` phải được kiểm lại ở client.
 */

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return { bio: "", pronouns: "", bannerColor: "", ...overrides };
}

describe("draftFromUser", () => {
  it("null → chuỗi rỗng", () => {
    expect(draftFromUser(null)).toEqual({ bio: "", pronouns: "", bannerColor: "" });
  });

  it("giữ nguyên giá trị đã có", () => {
    expect(
      draftFromUser({ bio: "xin chào", pronouns: "cô ấy", bannerColor: "#5865f2" }),
    ).toEqual({ bio: "xin chào", pronouns: "cô ấy", bannerColor: "#5865f2" });
  });

  it("trường undefined coi như chưa đặt (USER_UPDATE bản cũ)", () => {
    expect(draftFromUser({}).bio).toBe("");
    expect(draftFromUser({ bio: null }).pronouns).toBe("");
  });
});

describe("buildProfilePatch", () => {
  it("không đổi gì → patch rỗng", () => {
    const base = draft({ bio: "a", pronouns: "b", bannerColor: "#5865f2" });
    expect(isPatchEmpty(buildProfilePatch({ ...base }, base))).toBe(true);
  });

  it("chỉ gửi trường đã đổi", () => {
    const base = draft({ bio: "a", pronouns: "b", bannerColor: "#5865f2" });
    expect(buildProfilePatch({ ...base, bio: "c" }, base)).toEqual({ bio: "c" });
    expect(buildProfilePatch({ ...base, pronouns: "d" }, base)).toEqual({ pronouns: "d" });
  });

  it("khoảng trắng hai đầu không tính là thay đổi", () => {
    const base = draft({ bio: "abc" });
    expect(buildProfilePatch({ ...base, bio: "  abc  " }, base)).toEqual({});
  });

  it("xoá (chuỗi rỗng / toàn khoảng trắng) gửi null, không gửi \"\"", () => {
    const base = draft({ bio: "abc", pronouns: "cô ấy", bannerColor: "#5865f2" });
    expect(buildProfilePatch(draft({ pronouns: "cô ấy", bannerColor: "#5865f2" }), base)).toEqual({
      bio: null,
    });
    expect(
      buildProfilePatch(draft({ bio: "abc", pronouns: "   ", bannerColor: "#5865f2" }), base),
    ).toEqual({ pronouns: null });
  });

  it("màu banner so sánh không phân biệt hoa thường và gửi chữ thường", () => {
    const base = draft({ bannerColor: "#5865F2" });
    expect(buildProfilePatch({ ...base, bannerColor: "#5865f2" }, base)).toEqual({});
    expect(buildProfilePatch({ ...base, bannerColor: "#ABCDEF" }, base)).toEqual({
      bannerColor: "#abcdef",
    });
  });

  it("cắt khoảng trắng trong giá trị gửi đi", () => {
    const base = draft();
    expect(buildProfilePatch({ bio: "  xin chào  ", pronouns: "", bannerColor: "" }, base)).toEqual(
      { bio: "xin chào" },
    );
  });
});

describe("bannerColorOf", () => {
  it("chưa đặt → màu mặc định", () => {
    expect(bannerColorOf(null)).toBe("#5865f2");
    expect(bannerColorOf({ bannerColor: null })).toBe("#5865f2");
    expect(bannerColorOf({})).toBe("#5865f2");
  });

  it("màu hợp lệ được chữ thường hoá", () => {
    expect(bannerColorOf({ bannerColor: "#ABCDEF" })).toBe("#abcdef");
  });

  it("chuỗi lạ không lọt vào style", () => {
    for (const bad of ["red", "#12345", "url(x)", "#1234567", "#GGGGGG", ""]) {
      expect(bannerColorOf({ bannerColor: bad }), bad).toBe("#5865f2");
    }
  });

  it("mọi màu gợi ý đều hợp lệ", () => {
    for (const color of BANNER_COLORS) {
      expect(bannerColorOf({ bannerColor: color })).toBe(color);
    }
  });
});

describe("readableTextOn", () => {
  it("màu sáng → chữ đậm, màu tối → chữ trắng", () => {
    expect(readableTextOn("#ffffff")).toBe("#0f172a");
    expect(readableTextOn("#000000")).toBe("#ffffff");
    expect(readableTextOn("#5865f2")).toBe("#ffffff");
  });

  it("đầu vào rác vẫn trả màu đọc được", () => {
    expect(readableTextOn("không phải màu")).toBe("#ffffff");
  });
});

describe("characterCount", () => {
  it("đếm theo ký tự, không theo đơn vị UTF-16", () => {
    expect(characterCount("abc")).toBe(3);
    // Cờ VN: 2 code point (2 regional indicator) nhưng `length` = 4 đơn vị UTF-16.
    expect("🇻🇳".length).toBe(4);
    expect(characterCount("🇻🇳")).toBe(2);
  });

  it("bỏ khoảng trắng hai đầu, khớp cách server đo", () => {
    expect(characterCount("  abc  ")).toBe(3);
    expect(characterCount("   ")).toBe(0);
  });

  it("trần khớp hằng số đang hiển thị", () => {
    expect(MAX_BIO_LENGTH).toBe(190);
    expect(MAX_PRONOUNS_LENGTH).toBe(40);
  });
});

describe("sameDraft", () => {
  it("so sánh đã chuẩn hoá", () => {
    expect(sameDraft(draft({ bio: "a" }), draft({ bio: " a " }))).toBe(true);
    expect(
      sameDraft(draft({ bannerColor: "#ABCDEF" }), draft({ bannerColor: "#abcdef" })),
    ).toBe(true);
    expect(sameDraft(draft({ bio: "a" }), draft({ bio: "b" }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  decideNotify,
  formatTabTitle,
  notificationText,
  parseNotificationSettings,
  type NotifyInput,
} from "./notifications.js";

/**
 * Quy tắc báo tin mới. Test đọc **lý do** chứ không chỉ đúng/sai: sau này thêm
 * điều kiện mới mà quên thứ tự ưu tiên thì phải thấy ngay lý do nào thắng.
 */

const base: NotifyInput = {
  authorId: "u2",
  meId: "u1",
  channelId: "c1",
  activeChannelId: "c1",
  windowFocused: true,
  desktopEnabled: true,
  important: false,
  lastNotifiedAt: null,
  now: 1_000_000,
};

describe("decideNotify", () => {
  it("tin của chính mình không bao giờ báo", () => {
    expect(decideNotify({ ...base, authorId: "u1" })).toEqual({ notify: false, reason: "self" });
  });

  it("chưa bật thông báo thì không báo (kể cả mention)", () => {
    expect(decideNotify({ ...base, desktopEnabled: false, important: true })).toEqual({
      notify: false,
      reason: "disabled",
    });
  });

  it("đang mở đúng kênh và cửa sổ focus → đang đọc, không báo", () => {
    expect(decideNotify(base)).toEqual({ notify: false, reason: "reading" });
  });

  it("đang mở kênh nhưng ở tab khác (không focus) → vẫn báo", () => {
    expect(decideNotify({ ...base, windowFocused: false })).toEqual({ notify: true });
  });

  it("kênh khác, có focus → vẫn báo", () => {
    expect(decideNotify({ ...base, channelId: "c9" })).toEqual({ notify: true });
  });

  it("cooldown 15s trong cùng kênh, nhưng mention thì bỏ qua cooldown", () => {
    const recent = { ...base, channelId: "c9", lastNotifiedAt: base.now - 3_000 };
    expect(decideNotify(recent)).toEqual({ notify: false, reason: "cooldown" });
    expect(decideNotify({ ...recent, important: true })).toEqual({ notify: true });
  });

  it("cooldown hết hạn (hoặc đúng mốc) thì báo lại", () => {
    expect(decideNotify({ ...base, channelId: "c9", lastNotifiedAt: base.now - 15_000 })).toEqual({
      notify: true,
    });
    expect(decideNotify({ ...base, channelId: "c9", lastNotifiedAt: base.now - 14_999 })).toEqual({
      notify: false,
      reason: "cooldown",
    });
  });

  it("cooldown áp riêng từng kênh (kênh khác không bị chặn oan)", () => {
    const common = { ...base, windowFocused: false };
    expect(decideNotify({ ...common, channelId: "c9", lastNotifiedAt: base.now - 1_000 })).toEqual({
      notify: false,
      reason: "cooldown",
    });
    expect(decideNotify({ ...common, channelId: "c10", lastNotifiedAt: null })).toEqual({
      notify: true,
    });
  });
});

describe("formatTabTitle", () => {
  it("chưa đọc gì → đúng tên app, không có (0)", () => {
    expect(formatTabTitle("Umaru", { unread: 0, mentions: 0 })).toBe("Umaru");
  });

  it("có tin chưa đọc → (n) đứng trước", () => {
    expect(formatTabTitle("Umaru", { unread: 3, mentions: 0 })).toBe("(3) Umaru");
  });

  it("có mention → đánh dấu @ để liếc tab là biết, nhưng vẫn đếm unread", () => {
    expect(formatTabTitle("Umaru", { unread: 4, mentions: 2 })).toBe("(4@) Umaru");
  });

  it("tắt đếm trên tab thì luôn trả tên app", () => {
    expect(formatTabTitle("Umaru", { unread: 9, mentions: 1 }, false)).toBe("Umaru");
  });
});

describe("parseNotificationSettings", () => {
  it("không có gì → mặc định (tab bật, desktop tắt vì cần quyền)", () => {
    expect(parseNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({ desktop: false, tabTitle: true });
  });

  it("JSON hỏng / kiểu sai → về mặc định, không ném lỗi", () => {
    expect(parseNotificationSettings("{hỏng")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(parseNotificationSettings("null")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(parseNotificationSettings('"chuỗi"')).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("đọc đúng hai khoá, thiếu khoá nào thì khoá đó về mặc định", () => {
    expect(parseNotificationSettings('{"desktop":true,"tabTitle":false}')).toEqual({
      desktop: true,
      tabTitle: false,
    });
    expect(parseNotificationSettings('{"desktop":true}')).toEqual({ desktop: true, tabTitle: true });
    // Kiểu sai ở một khoá không kéo khoá kia về mặc định.
    expect(parseNotificationSettings('{"desktop":"có","tabTitle":false}')).toEqual({
      desktop: false,
      tabTitle: false,
    });
  });
});

describe("notificationText", () => {
  it("mention có tiêu đề riêng; body gộp khoảng trắng và cắt 140 ký tự", () => {
    const text = notificationText({
      authorName: "An",
      channelLabel: "#general",
      content: "  chào   bạn\n" + "x".repeat(200),
      important: true,
    });
    expect(text.title).toContain("An");
    expect(text.body.length).toBe(140);
    expect(text.body.startsWith("chào bạn xxx")).toBe(true);
  });

  it("tin thường có tên kênh; nội dung rỗng (chỉ có tệp) vẫn có body", () => {
    const text = notificationText({
      authorName: "An",
      channelLabel: "#general",
      content: "   ",
      important: false,
    });
    expect(text.title).toContain("#general");
    expect(text.body.length).toBeGreaterThan(0);
  });
});

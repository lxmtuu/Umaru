import { describe, expect, it } from "vitest";
import { readChannelDeepLink } from "./deepLink.js";

describe("readChannelDeepLink", () => {
  it("lấy id kênh và xoá tham số khỏi query", () => {
    expect(readChannelDeepLink("?channel=240329223200309248")).toEqual({
      channelId: "240329223200309248",
      messageId: null,
      cleanedSearch: "",
    });
  });

  it("giữ các tham số khác, không tự thêm dấu ? rỗng", () => {
    expect(readChannelDeepLink("?lang=vi&channel=123&x=1")).toEqual({
      channelId: "123",
      messageId: null,
      cleanedSearch: "?lang=vi&x=1",
    });
  });

  it("không có tham số thì trả nguyên chuỗi gốc", () => {
    expect(readChannelDeepLink("")).toEqual({
      channelId: null,
      messageId: null,
      cleanedSearch: "",
    });
    expect(readChannelDeepLink("?lang=vi")).toEqual({
      channelId: null,
      messageId: null,
      cleanedSearch: "?lang=vi",
    });
  });

  it("id không phải snowflake bị bỏ, nhưng tham số vẫn được dọn", () => {
    // Id rác trong URL (ai đó sửa tay) không được làm app gọi API rồi 404.
    expect(readChannelDeepLink("?channel=abc")).toEqual({
      channelId: null,
      messageId: null,
      cleanedSearch: "",
    });
    expect(readChannelDeepLink("?channel=")).toEqual({
      channelId: null,
      messageId: null,
      cleanedSearch: "",
    });
    expect(readChannelDeepLink("?channel=12;34")).toEqual({
      channelId: null,
      messageId: null,
      cleanedSearch: "",
    });
  });

  it("nhận thêm `message` để mở đúng tin (link 'Sao chép liên kết')", () => {
    expect(readChannelDeepLink("?channel=123&message=456")).toEqual({
      channelId: "123",
      messageId: "456",
      cleanedSearch: "",
    });
    // Cả hai tham số đều bị xoá khỏi URL: F5 không được nhảy lại tin cũ.
    expect(readChannelDeepLink("?lang=vi&channel=1&message=2&x=3")).toEqual({
      channelId: "1",
      messageId: "2",
      cleanedSearch: "?lang=vi&x=3",
    });
  });

  it("`message` vô nghĩa khi không có `channel`, hoặc không phải snowflake", () => {
    expect(readChannelDeepLink("?message=456")).toEqual({
      channelId: null,
      messageId: null,
      cleanedSearch: "?message=456",
    });
    expect(readChannelDeepLink("?channel=123&message=abc")).toEqual({
      channelId: "123",
      messageId: null,
      cleanedSearch: "",
    });
  });
});

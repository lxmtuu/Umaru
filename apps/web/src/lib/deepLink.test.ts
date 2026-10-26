import { describe, expect, it } from "vitest";
import { readChannelDeepLink } from "./deepLink.js";

describe("readChannelDeepLink", () => {
  it("lấy id kênh và xoá tham số khỏi query", () => {
    expect(readChannelDeepLink("?channel=240329223200309248")).toEqual({
      channelId: "240329223200309248",
      cleanedSearch: "",
    });
  });

  it("giữ các tham số khác, không tự thêm dấu ? rỗng", () => {
    expect(readChannelDeepLink("?lang=vi&channel=123&x=1")).toEqual({
      channelId: "123",
      cleanedSearch: "?lang=vi&x=1",
    });
  });

  it("không có tham số thì trả nguyên chuỗi gốc", () => {
    expect(readChannelDeepLink("")).toEqual({ channelId: null, cleanedSearch: "" });
    expect(readChannelDeepLink("?lang=vi")).toEqual({ channelId: null, cleanedSearch: "?lang=vi" });
  });

  it("id không phải snowflake bị bỏ, nhưng tham số vẫn được dọn", () => {
    // Id rác trong URL (ai đó sửa tay) không được làm app gọi API rồi 404.
    expect(readChannelDeepLink("?channel=abc")).toEqual({ channelId: null, cleanedSearch: "" });
    expect(readChannelDeepLink("?channel=")).toEqual({ channelId: null, cleanedSearch: "" });
    expect(readChannelDeepLink("?channel=12;34")).toEqual({ channelId: null, cleanedSearch: "" });
  });
});

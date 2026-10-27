import { describe, expect, it } from "vitest";
import { buildTimeline, dividerLabel, GROUP_WINDOW_MS } from "./messageTimeline.js";
import type { Message } from "@umaru/protocol";

function message(id: string, authorId: string, createdAt: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channelId: "c",
    authorId,
    content: "x",
    replyToId: null,
    pinned: false,
    createdAt,
    editedAt: null,
    attachments: [],
    ...extra,
  } as unknown as Message;
}

const base = Date.parse("2026-10-26T09:00:00.000Z");

describe("buildTimeline", () => {
  it("tin đầu tiên luôn có vạch ngày và không bị gộp", () => {
    const items = buildTimeline([message("1", "a", new Date(base).toISOString())]);
    expect(items.map((item) => item.kind)).toEqual(["divider", "message"]);
    expect(items[1]).toMatchObject({ grouped: false });
  });

  it("cùng người, trong 5 phút → gộp (ẩn avatar/tên)", () => {
    const items = buildTimeline([
      message("1", "a", new Date(base).toISOString()),
      message("2", "a", new Date(base + 60_000).toISOString()),
    ]);
    expect(items.filter((item) => item.kind === "message")).toEqual([
      expect.objectContaining({ grouped: false }),
      expect.objectContaining({ grouped: true }),
    ]);
  });

  it("cách nhau hơn 5 phút → không gộp", () => {
    const items = buildTimeline([
      message("1", "a", new Date(base).toISOString()),
      message("2", "a", new Date(base + GROUP_WINDOW_MS + 1).toISOString()),
    ]);
    const messages = items.filter((item) => item.kind === "message");
    expect(messages[1]).toMatchObject({ grouped: false });
  });

  it("người khác gửi → không gộp", () => {
    const items = buildTimeline([
      message("1", "a", new Date(base).toISOString()),
      message("2", "b", new Date(base + 1000).toISOString()),
    ]);
    expect(items.filter((item) => item.kind === "message")[1]).toMatchObject({ grouped: false });
  });

  it("tin trả lời đứng riêng, và tin sau nó cũng không gộp vào nó", () => {
    const items = buildTimeline([
      message("1", "a", new Date(base).toISOString()),
      message("2", "a", new Date(base + 1000).toISOString(), { replyToId: "1" as never }),
      message("3", "a", new Date(base + 2000).toISOString()),
    ]);
    expect(items.filter((item) => item.kind === "message").map((m) => (m.kind === "message" ? m.grouped : null))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("sang ngày mới → thêm vạch và không gộp qua nửa đêm", () => {
    const day1 = Date.parse("2026-10-25T23:58:00.000Z");
    const day2 = Date.parse("2026-10-26T00:01:00.000Z");
    const items = buildTimeline([
      message("1", "a", new Date(day1).toISOString()),
      message("2", "a", new Date(day2).toISOString()),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["divider", "message", "divider", "message"]);
    expect(items[3]).toMatchObject({ grouped: false });
  });

  it("nhiều tin cùng ngày chỉ có một vạch ngày", () => {
    const items = buildTimeline([
      message("1", "a", new Date(base).toISOString()),
      message("2", "b", new Date(base + 10 * 60_000).toISOString()),
      message("3", "c", new Date(base + 20 * 60_000).toISOString()),
    ]);
    expect(items.filter((item) => item.kind === "divider")).toHaveLength(1);
  });

  it("danh sách rỗng → không có gì", () => {
    expect(buildTimeline([])).toEqual([]);
  });
});

describe("dividerLabel", () => {
  const now = Date.parse("2026-10-26T10:00:00.000Z");
  const labels = { today: "Hôm nay", yesterday: "Hôm qua" };

  it("hôm nay / hôm qua / ngày cũ", () => {
    expect(dividerLabel(Date.parse("2026-10-26T01:00:00.000Z"), now, "vi", labels)).toBe("Hôm nay");
    expect(dividerLabel(Date.parse("2026-10-25T23:00:00.000Z"), now, "vi", labels)).toBe("Hôm qua");
    expect(dividerLabel(Date.parse("2026-10-01T09:00:00.000Z"), now, "vi", labels)).toBe("01/10/2026");
  });
});

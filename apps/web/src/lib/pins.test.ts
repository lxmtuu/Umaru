import type { Message } from "@umaru/protocol";
import { describe, expect, it } from "vitest";
import { patchMessage } from "./chatStore.js";

/** State tối thiểu đủ cho `patchMessage` (chỉ các trường nó chạm tới). */
function makeState(options: {
  messages?: Record<string, Message[]>;
  pins?: Message[] | null;
  pinsChannelId?: string | null;
}) {
  return {
    messages: options.messages ?? {},
    pins: options.pins ?? null,
    pinsChannelId: options.pinsChannelId ?? null,
  } as unknown as Parameters<typeof patchMessage>[0];
}

/** Tin tối thiểu, đủ trường mà UI/store đọc; `extra` để đổi kênh/pinned. */
function message(id: string, extra: Record<string, unknown> = {}): Message {
  return {
    channelId: "C1",
    authorId: "U1",
    content: "nội dung",
    replyToId: null,
    pinned: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    editedAt: null,
    attachments: [],
    ...extra,
    id,
  } as unknown as Message;
}

describe("patchMessage (ghim/bỏ ghim)", () => {
  it("bật pinned trong danh sách tin của kênh", () => {
    const state = makeState({
      messages: { C1: [message("m1"), message("m2")] },
    });
    const patch = patchMessage(state, { id: "m1", channelId: "C1", pinned: true });
    expect(patch.messages?.C1?.map((item) => item.pinned)).toEqual([true, false]);
  });

  it("thêm tin vào danh sách ghim khi đang mở đúng kênh", () => {
    const state = makeState({
      messages: { C1: [message("m1")] },
      pins: [],
      pinsChannelId: "C1",
    });
    const patch = patchMessage(state, { id: "m1", channelId: "C1", pinned: true });
    expect(patch.pins?.map((item) => item.id)).toEqual(["m1"]);
  });

  it("bỏ ghim thì rời danh sách ghim", () => {
    const state = makeState({
      messages: { C1: [message("m1", { pinned: true })] },
      pins: [message("m1", { pinned: true })],
      pinsChannelId: "C1",
    });
    const patch = patchMessage(state, { id: "m1", channelId: "C1", pinned: false });
    expect(patch.pins).toEqual([]);
    expect(patch.messages?.C1?.[0]?.pinned).toBe(false);
  });

  it("không đụng danh sách ghim của kênh khác", () => {
    const state = makeState({
      messages: { C1: [message("m1")] },
      pins: [message("x1", { channelId: "C2" })],
      pinsChannelId: "C2",
    });
    const patch = patchMessage(state, { id: "m1", channelId: "C1", pinned: true });
    expect(patch.pins?.map((item) => item.id)).toEqual(["x1"]);
  });

  it("tin chưa tải trong bộ nhớ thì không bịa vào danh sách ghim", () => {
    const state = makeState({ messages: {}, pins: [], pinsChannelId: "C1" });
    const patch = patchMessage(state, { id: "m9", channelId: "C1", pinned: true });
    expect(patch.pins).toEqual([]);
  });
});

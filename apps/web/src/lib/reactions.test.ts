// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@umaru/protocol";

/**
 * Reaction ở phía client.
 *
 * Server gửi **delta** (`count` tuyệt đối + ai vừa làm) chứ không gửi cả danh
 * sách, nên store phải tự dựng lại chip. Ba thứ dễ sai và được khoá ở đây:
 *
 * 1. `me` chỉ đổi khi event là **của chính mình** — nếu không, thấy người khác
 *    thả tim cũng làm chip của mình sáng lên và lần bấm sau thành xoá.
 * 2. `count === 0` phải **xoá chip**, không để lại chip "0".
 * 3. Áp lặp cùng một event (reconnect phát lại) phải ra cùng kết quả.
 */

const fake = vi.hoisted(() => {
  class FakeGatewayClient {
    static last: FakeGatewayClient | null = null;
    private handlers = new Map<string, (data: unknown) => void>();
    private stateCb: ((state: string) => void) | null = null;

    constructor(_options: unknown) {
      FakeGatewayClient.last = this;
    }

    onStateChange(cb: (state: string) => void): void {
      this.stateCb = cb;
    }

    on(event: string, cb: (data: unknown) => void): void {
      this.handlers.set(event, cb);
    }

    connect(): void {
      this.stateCb?.("ready");
    }

    updatePresence(): void {
      /* không cần cho test này */
    }

    close(): void {
      /* không cần cho test này */
    }

    emit(event: string, data: unknown): void {
      const handler = this.handlers.get(event);
      if (handler === undefined) throw new Error(`chưa đăng ký handler ${event}`);
      handler(data);
    }
  }
  return { FakeGatewayClient };
});

vi.mock("@umaru/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@umaru/sdk")>();
  return { ...actual, GatewayClient: fake.FakeGatewayClient };
});

const calls = vi.hoisted(() => ({ add: [] as string[], remove: [] as string[] }));

vi.mock("./session.js", () => ({
  api: {
    getGatewayUrl: async () => ({ url: "ws://localhost/api/v1/gateway/ws", version: 1 }),
  },
  authedApi: {
    listMessageRequests: async () => [],
    listMessages: async () => [],
    ackRead: async () => undefined,
    addReaction: async (messageId: string, emoji: string) => {
      calls.add.push(`${messageId}:${emoji}`);
      return { reactions: [] };
    },
    removeReaction: async (messageId: string, emoji: string) => {
      calls.remove.push(`${messageId}:${emoji}`);
      return { reactions: [] };
    },
  },
  clearTokens: () => undefined,
  getAccessToken: () => "test-token",
  getRefreshToken: () => null,
  refreshSession: async () => false,
  storeTokens: () => undefined,
}));

const { useChat } = await import("./chatStore.js");

const ME = { id: "1", username: "me", displayName: "Me", avatarUrl: null };
const OTHER = "2";

function message(id: string, extra: Record<string, unknown> = {}): Message {
  return {
    id,
    channelId: "100",
    authorId: OTHER,
    content: "nội dung",
    replyToId: null,
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    attachments: [],
    reactions: [],
    ...extra,
  } as unknown as Message;
}

/** Đưa store vào trạng thái "đang mở kênh 100, có sẵn tin" rồi trả client giả. */
async function openWith(messages: Message[]): Promise<InstanceType<typeof fake.FakeGatewayClient>> {
  await useChat.getState().connectGateway();
  const client = fake.FakeGatewayClient.last;
  if (client === null) throw new Error("chưa có client giả");
  client.emit("READY", {
    user: ME,
    guilds: [
      {
        guild: {
          id: "10",
          name: "S",
          iconUrl: null,
          ownerId: "1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        channels: [
          { id: "100", guildId: "10", type: "guild_text", name: "chung", topic: null, parentId: null, position: 0 },
        ],
        members: [{ userId: "1", nickname: null, joinedAt: "2026-01-01T00:00:00.000Z", roles: [] }],
        roles: [
          { id: "11", guildId: "10", name: "everyone", color: 0, position: 0, permissions: "1795", isEveryone: true },
        ],
      },
    ],
    dms: [],
    readStates: [],
    channelPermissions: { "100": "1795" },
    voiceStates: [],
  });
  // READY kích hoạt `loadMessages` bất đồng bộ (mock trả []) — chờ nó xong rồi
  // mới đặt tin, nếu không danh sách tin vừa đặt sẽ bị lần load đó ghi đè.
  await new Promise((resolve) => setTimeout(resolve, 0));
  useChat.setState({ activeChannelId: "100", messages: { "100": messages } });
  return client;
}

function reactionsOf(id = "m1") {
  return (useChat.getState().messages["100"] ?? []).find((item) => item.id === id)?.reactions;
}

function reaction(emoji: string, count: number, userId: string, added: boolean) {
  return { messageId: "m1", channelId: "100", emoji, count, userId, added };
}

beforeEach(() => {
  fake.FakeGatewayClient.last = null;
  calls.add.length = 0;
  calls.remove.length = 0;
  useChat.setState({ messages: {}, activeChannelId: null, me: null, error: null });
});

describe("MESSAGE_REACTION_UPDATE", () => {
  it("emoji mới → chip xuống cuối danh sách, `me: true` khi là của mình", async () => {
    const client = await openWith([
      message("m1", {
        reactions: [
          { emoji: "👍", count: 1, me: false },
          { emoji: "🔥", count: 1, me: false },
        ],
      }),
    ]);
    client.emit("MESSAGE_REACTION_UPDATE", reaction("❤️", 1, ME.id, true));
    expect(reactionsOf()).toEqual([
      { emoji: "👍", count: 1, me: false },
      { emoji: "🔥", count: 1, me: false },
      { emoji: "❤️", count: 1, me: true },
    ]);
  });

  it("người khác thả emoji mình đã thả → chỉ tăng count, `me` giữ nguyên true", async () => {
    const client = await openWith([message("m1", { reactions: [{ emoji: "👍", count: 1, me: true }] })]);
    client.emit("MESSAGE_REACTION_UPDATE", reaction("👍", 2, OTHER, true));
    expect(reactionsOf()).toEqual([{ emoji: "👍", count: 2, me: true }]);
  });

  it("người khác thả emoji mình chưa thả → `me` vẫn false", async () => {
    const client = await openWith([message("m1", { reactions: [{ emoji: "👍", count: 1, me: false }] })]);
    client.emit("MESSAGE_REACTION_UPDATE", reaction("👍", 2, OTHER, true));
    expect(reactionsOf()).toEqual([{ emoji: "👍", count: 2, me: false }]);
  });

  it("mình bỏ reaction → `me` false, chip còn lại của người khác", async () => {
    const client = await openWith([message("m1", { reactions: [{ emoji: "👍", count: 2, me: true }] })]);
    client.emit("MESSAGE_REACTION_UPDATE", reaction("👍", 1, ME.id, false));
    expect(reactionsOf()).toEqual([{ emoji: "👍", count: 1, me: false }]);
  });

  it("count về 0 → xoá chip, không để lại chip rỗng", async () => {
    const client = await openWith([
      message("m1", {
        reactions: [
          { emoji: "👍", count: 1, me: true },
          { emoji: "🎉", count: 3, me: false },
        ],
      }),
    ]);
    client.emit("MESSAGE_REACTION_UPDATE", reaction("👍", 0, ME.id, false));
    expect(reactionsOf()).toEqual([{ emoji: "🎉", count: 3, me: false }]);
  });

  it("áp lặp cùng một event (phát lại sau reconnect) ra cùng kết quả", async () => {
    const client = await openWith([message("m1")]);
    const event = reaction("😀", 1, ME.id, true);
    client.emit("MESSAGE_REACTION_UPDATE", event);
    const once = reactionsOf();
    client.emit("MESSAGE_REACTION_UPDATE", event);
    expect(reactionsOf()).toEqual(once);
  });

  it("kênh không mở trong bộ nhớ thì bỏ qua, không tạo tin giả", async () => {
    const client = await openWith([message("m1")]);
    client.emit("MESSAGE_REACTION_UPDATE", { ...reaction("👍", 1, ME.id, true), channelId: "999" });
    expect(useChat.getState().messages["999"]).toBeUndefined();
  });
});

describe("toggleReaction", () => {
  it("chưa thả → gọi addReaction; đã thả → gọi removeReaction", async () => {
    await openWith([message("m1")]);
    await useChat.getState().toggleReaction("m1", "👍", false);
    await useChat.getState().toggleReaction("m1", "👍", true);
    expect(calls.add).toEqual(["m1:👍"]);
    expect(calls.remove).toEqual(["m1:👍"]);
  });

  it("không tự sửa state — chờ event, để hai tab không cộng hai lần", async () => {
    await openWith([message("m1")]);
    await useChat.getState().toggleReaction("m1", "👍", false);
    expect(reactionsOf()).toEqual([]);
  });
});

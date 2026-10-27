// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@umaru/protocol";
import { useLocale } from "./i18n.js";
import { readDrafts, writeDraft } from "./drafts.js";

/**
 * Test cho **đường khởi động kết nối gateway** — chỗ đã làm mất toàn bộ sidebar
 * trên bản chạy https: `connectGateway()` chạy tới `GET /gateway` rồi dừng, không
 * bao giờ gọi `connect()`, nên không có `READY` và người dùng thấy "không có
 * server nào". Test này khoá hai điều:
 *
 * 1. `connect()` **phải** được gọi (nếu code ném lỗi trước đó, test đỏ ngay).
 * 2. `READY` phải đổ được guild/kênh vào store — tức dữ liệu hiện lên sidebar.
 *
 * `GatewayClient` được thay bằng bản giả để không cần mạng; phần URL thì đã có
 * `gatewayUrl.test.ts` lo riêng.
 */

const fake = vi.hoisted(() => {
  class FakeGatewayClient {
    static last: FakeGatewayClient | null = null;
    url = "";
    token = "";
    connectCalls = 0;
    closeCalls = 0;
    private handlers = new Map<string, (data: unknown) => void>();
    private stateCb: ((state: string) => void) | null = null;

    constructor(options: { url: string; token: string }) {
      this.url = options.url;
      this.token = options.token;
      FakeGatewayClient.last = this;
    }

    onStateChange(cb: (state: string) => void): void {
      this.stateCb = cb;
    }

    on(event: string, cb: (data: unknown) => void): void {
      this.handlers.set(event, cb);
    }

    connect(): void {
      this.connectCalls += 1;
      this.stateCb?.("ready");
    }

    presenceSent: string[] = [];

    updatePresence(status: string): void {
      this.presenceSent.push(status);
    }

    close(): void {
      this.closeCalls += 1;
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

const session = vi.hoisted(() => ({
  gatewayUrl: "ws://localhost:4173/api/v1/gateway/ws",
  /** Kết quả `listMessages` cho lần gọi kế tiếp (dùng cho test resume). */
  messages: [] as unknown[],
  readStates: [] as unknown[],
  /** Bật để `listMessages` ném lỗi (mô phỏng mất mạng ngay sau resume). */
  failMessages: false,
}));

vi.mock("./session.js", () => ({
  api: {
    getGatewayUrl: async () => ({ url: session.gatewayUrl, version: 1 }),
  },
  authedApi: {
    getCurrentUser: async () => ({
      id: "1",
      username: "demo_user",
      displayName: "Demo",
      avatarUrl: null,
    }),
    getAdminStatus: async () => ({ admin: false }),
    getPushPublicKey: async () => ({ publicKey: null }),
    listMessageRequests: async () => [],
    listMessages: async () => {
      if (session.failMessages) throw new Error("mất mạng");
      return session.messages;
    },
    listReadStates: async () => session.readStates,
    listThreads: async () => [],
    ackRead: async () => undefined,
  },
  clearTokens: () => undefined,
  getAccessToken: () => "test-token",
  getRefreshToken: () => null,
  refreshSession: async () => false,
  storeTokens: () => undefined,
}));

const { useChat } = await import("./chatStore.js");

const ME = { id: "1", username: "demo_user", displayName: "Demo", avatarUrl: null };
const GUILD = { id: "10", name: "Umaru Demo", iconUrl: null, ownerId: "1", createdAt: "2026-01-01T00:00:00.000Z" };
const TEXT_CHANNEL = {
  id: "100",
  guildId: "10",
  type: "guild_text",
  name: "chung",
  topic: null,
  parentId: null,
  position: 0,
};

function readyPayload() {
  return {
    user: ME,
    guilds: [
      {
        guild: GUILD,
        channels: [TEXT_CHANNEL],
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
  };
}

beforeEach(() => {
  useLocale.setState({ locale: "vi" });
  fake.FakeGatewayClient.last = null;
  session.messages = [];
  session.readStates = [];
  session.failMessages = false;
  useChat.setState({ guilds: [], channels: {}, activeGuildId: null, activeChannelId: null });
});

describe("connectGateway", () => {
  it("gọi connect() thật — không dừng lại sau khi lấy URL", async () => {
    await useChat.getState().connectGateway();
    const client = fake.FakeGatewayClient.last;
    expect(client).not.toBeNull();
    expect(client?.connectCalls).toBe(1);
    expect(useChat.getState().gatewayStatus).toBe("ready");
  });

  it("dùng URL gateway đã chuẩn hoá và token hiện tại", async () => {
    await useChat.getState().connectGateway();
    const client = fake.FakeGatewayClient.last;
    expect(client?.url).toBe("ws://localhost:4173/api/v1/gateway/ws");
    expect(client?.token).toBe("test-token");
  });

  it("READY đổ guild + kênh vào store (sidebar có dữ liệu)", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());

    const state = useChat.getState();
    expect(state.guilds.map((guild) => guild.name)).toEqual(["Umaru Demo"]);
    expect(state.channels["10"]?.map((channel) => channel.name)).toEqual(["chung"]);
    expect(state.activeGuildId).toBe("10");
    expect(state.activeChannelId).toBe("100");
    expect(state.me?.username).toBe("demo_user");
  });

  it("gọi lại thì đóng kết nối cũ trước khi mở kết nối mới", async () => {
    await useChat.getState().connectGateway();
    const first = fake.FakeGatewayClient.last;
    await useChat.getState().connectGateway();
    expect(first?.closeCalls).toBe(1);
    expect(fake.FakeGatewayClient.last).not.toBe(first);
  });
});

describe("presence và quan hệ bạn bè", () => {
  it("READY nạp presences vào store, không có trong danh sách = chưa có", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", {
      ...readyPayload(),
      presences: [{ userId: "2", status: "dnd" }],
    });
    expect(useChat.getState().presence["2"]).toBe("dnd");
  });

  it("PRESENCE_UPDATE cập nhật đúng một người, không xoá người khác", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", {
      ...readyPayload(),
      presences: [
        { userId: "2", status: "online" },
        { userId: "3", status: "idle" },
      ],
    });
    fake.FakeGatewayClient.last?.emit("PRESENCE_UPDATE", { userId: "3", status: "offline" });
    expect(useChat.getState().presence).toMatchObject({ "2": "online", "3": "offline" });
  });

  it("huỷ kết bạn với người không chung server → quên trạng thái của họ", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", {
      ...readyPayload(),
      presences: [{ userId: "999", status: "online" }],
    });
    expect(useChat.getState().presence["999"]).toBe("online");

    fake.FakeGatewayClient.last?.emit("FRIEND_REMOVE", { userId: "999" });
    expect(useChat.getState().presence["999"]).toBeUndefined();
  });

  it("huỷ kết bạn nhưng vẫn chung server → giữ trạng thái", async () => {
    await useChat.getState().connectGateway();
    // "1" là chính mình và có trong member list của guild 10.
    fake.FakeGatewayClient.last?.emit("READY", {
      ...readyPayload(),
      presences: [{ userId: "1", status: "online" }],
    });
    fake.FakeGatewayClient.last?.emit("FRIEND_REMOVE", { userId: "1" });
    expect(useChat.getState().presence["1"]).toBe("online");
  });

  it("setPresence cập nhật lạc quan và gửi lên gateway", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    useChat.getState().setPresence("dnd");
    expect(useChat.getState().selfStatus).toBe("dnd");
    expect(useChat.getState().presence["1"]).toBe("dnd");
    expect(fake.FakeGatewayClient.last?.presenceSent).toEqual(["dnd"]);
  });
});

describe("RESUMED — đồng bộ lại thay vì tin replay", () => {
  /** Tin tối thiểu: hàm ghép chỉ đọc `id`, phần còn lại để nguyên. */
  function msg(id: string): Message {
    return {
      id,
      channelId: "100",
      authorId: "2",
      content: `tin ${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      replyToId: null,
      attachments: [],
      reactions: [],
      pinned: false,
    } as unknown as Message;
  }

  it("tải lại kênh đang mở và xoá tin đã bị xoá trong lúc mất mạng", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    expect(useChat.getState().activeChannelId).toBe("100");

    // Trong bộ nhớ có ba tin, nhưng server chỉ còn hai (tin 12 bị xoá lúc offline).
    useChat.setState({ messages: { "100": [msg("11"), msg("12"), msg("13")] } });
    session.messages = [msg("13"), msg("11")]; // server trả mới nhất trước
    useChat.getState().resyncAfterResume();
    await vi.waitFor(() => {
      expect(useChat.getState().messages["100"]?.map((item) => item.id)).toEqual(["11", "13"]);
    });
  });

  it("badge được tính lại từ server, kênh đang mở không bị vẽ badge", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    session.readStates = [
      { channelId: "100", lastReadMessageId: "11", unread: 3, mentions: 1 },
      { channelId: "200", lastReadMessageId: "9", unread: 2, mentions: 0 },
    ];
    useChat.getState().resyncAfterResume();
    await vi.waitFor(() => {
      expect(useChat.getState().unread).toEqual({ "200": 2 });
      expect(useChat.getState().mentions).toEqual({});
    });
  });

  it("lỗi mạng khi tải lại không làm mất tin đang có", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    // READY tự gọi `loadMessages` (không await) — chờ nó xong rồi mới đặt state,
    // nếu không nó ghi đè đúng thứ test vừa đặt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    useChat.setState({ messages: { "100": [msg("11")] } });
    session.failMessages = true;
    await useChat.getState().resyncAfterResume();
    expect(useChat.getState().messages["100"]?.map((item) => item.id)).toEqual(["11"]);
    expect(useChat.getState().error).toBeNull();
  });
});

describe("POLL_VOTE_UPDATE — delta của bình chọn", () => {
  function pollMessage() {
    return {
      id: "900",
      channelId: "100",
      authorId: "1",
      content: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      replyToId: null,
      attachments: [],
      reactions: [],
      pinned: false,
      poll: {
        question: "Q",
        allowMultiple: false,
        totalVotes: 0,
        expiresAt: null,
        ended: false,
        options: [
          { id: "901", label: "A", votes: 0, me: false },
          { id: "902", label: "B", votes: 0, me: false },
        ],
      },
    } as unknown as Message;
  }

  it("người khác bỏ phiếu: số phiếu đổi, `me` của mình KHÔNG đổi", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    useChat.setState({ messages: { "100": [pollMessage()] } });

    fake.FakeGatewayClient.last?.emit("POLL_VOTE_UPDATE", {
      messageId: "900",
      channelId: "100",
      optionId: "901",
      userId: "2",
      added: true,
      votes: 1,
      totalVotes: 1,
    });

    const poll = useChat.getState().messages["100"]![0]!.poll!;
    expect(poll.options[0]).toMatchObject({ votes: 1, me: false });
    expect(poll.totalVotes).toBe(1);
  });

  it("chính mình bỏ phiếu ở tab khác: `me` bật lên", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    useChat.setState({ messages: { "100": [pollMessage()] } });

    fake.FakeGatewayClient.last?.emit("POLL_VOTE_UPDATE", {
      messageId: "900",
      channelId: "100",
      optionId: "902",
      userId: "1",
      added: true,
      votes: 2,
      totalVotes: 3,
    });

    const poll = useChat.getState().messages["100"]![0]!.poll!;
    expect(poll.options[1]).toMatchObject({ votes: 2, me: true });
    expect(poll.options[0]).toMatchObject({ votes: 0, me: false });
  });

  it("tin không có poll thì bỏ qua, không crash", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    const plain = { ...pollMessage(), poll: null } as unknown as Message;
    useChat.setState({ messages: { "100": [plain] } });

    expect(() =>
      fake.FakeGatewayClient.last?.emit("POLL_VOTE_UPDATE", {
        messageId: "900",
        channelId: "100",
        optionId: "901",
        userId: "2",
        added: true,
        votes: 1,
        totalVotes: 1,
      }),
    ).not.toThrow();
    expect(useChat.getState().messages["100"]![0]!.poll).toBeNull();
  });
});

describe("nháp tin theo kênh", () => {
  it("giữ nháp riêng cho từng kênh — đổi kênh rồi quay lại vẫn còn", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    useChat.setState({ drafts: {} });

    useChat.getState().setDraft("100", "đang viết dở");
    useChat.getState().setDraft("200", "kênh khác");
    expect(useChat.getState().drafts).toMatchObject({
      "100": "đang viết dở",
      "200": "kênh khác",
    });
  });

  it("gửi xong (xoá nháp) thì nháp biến mất khỏi state và localStorage", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    useChat.getState().setDraft("100", "sắp gửi");
    expect(readDrafts(localStorage, "1")["100"]).toBe("sắp gửi");

    useChat.getState().setDraft("100", "");
    expect(useChat.getState().drafts["100"]).toBeUndefined();
    expect(readDrafts(localStorage, "1")["100"]).toBeUndefined();
  });

  it("vào phiên mới (F5) thì nháp được nạp lại từ localStorage", async () => {
    writeDraft(localStorage, "1", "100", "còn dở sau F5");
    useChat.setState({ drafts: {} });
    await useChat.getState().startSession();
    expect(useChat.getState().drafts["100"]).toBe("còn dở sau F5");
  });

  it("tab khác ghi nháp → tab này cập nhật theo sự kiện `storage`", async () => {
    // Dọn nháp các test trước để khẳng định chính xác bản đồ sau sự kiện.
    localStorage.clear();
    await useChat.getState().startSession();
    useChat.setState({ drafts: {} });

    // Tab kia vừa lưu nháp cho đúng tài khoản này.
    writeDraft(localStorage, "1", "300", "từ tab khác");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "umaru.drafts.v1:1",
        newValue: localStorage.getItem("umaru.drafts.v1:1"),
      }),
    );
    expect(useChat.getState().drafts).toEqual({ "300": "từ tab khác" });

    // Khoá của người khác thì phải bỏ qua.
    writeDraft(localStorage, "2", "400", "của người khác");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "umaru.drafts.v1:2",
        newValue: localStorage.getItem("umaru.drafts.v1:2"),
      }),
    );
    expect(useChat.getState().drafts).toEqual({ "300": "từ tab khác" });
  });

  it("đăng xuất gỡ listener: sự kiện `storage` sau đó không đổi state", async () => {
    await useChat.getState().startSession();
    await useChat.getState().logout();
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "umaru.drafts.v1:1",
        newValue: JSON.stringify({ 500: { text: "sau khi đăng xuất", at: 1 } }),
      }),
    );
    expect(useChat.getState().drafts).toEqual({});
  });

  it("đăng xuất xoá nháp của tài khoản đó (không để lại cho người sau)", async () => {
    await useChat.getState().connectGateway();
    fake.FakeGatewayClient.last?.emit("READY", readyPayload());
    useChat.getState().setDraft("100", "riêng tư");
    await useChat.getState().logout();
    expect(readDrafts(localStorage, "1")).toEqual({});
    expect(useChat.getState().drafts).toEqual({});
  });
});

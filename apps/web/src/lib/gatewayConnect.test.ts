// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "./i18n.js";

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
}));

vi.mock("./session.js", () => ({
  api: {
    getGatewayUrl: async () => ({ url: session.gatewayUrl, version: 1 }),
  },
  authedApi: {
    listMessageRequests: async () => [],
    listMessages: async () => [],
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

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { BusMessage, EventBus } from "../src/gateway/bus.js";
import { ClusterPublisher } from "../src/gateway/cluster.js";
import type { GatewayHub } from "../src/gateway/hub.js";
import {
  auth,
  createGuild,
  createTestContext,
  GatewayTestClient,
  listChannels,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Bus "dây" trong test: mô phỏng Redis pub/sub mà **không** cần Redis server.
 *
 * Sandbox không có Redis, nên phần chứng minh được ở đây là: hai publisher có
 * tên node riêng, trao đổi qua một hàng đợi chung thì session nối vào node B
 * nhận được sự kiện phát từ node A — và **không** nhận trùng. Giao thức RESP với
 * Redis thật nằm ở `redis-bus.test.ts` (Redis giả nói TCP thật).
 */
class WireHub {
  /** Message đã đi qua dây — test soi được nội dung. */
  readonly published: BusMessage[] = [];
  private readonly handlers = new Map<string, (message: BusMessage) => void>();

  end(name: string): EventBus {
    return {
      publish: (message) => {
        this.published.push(message);
        for (const [key, handler] of this.handlers) {
          // Giống Redis: kết nối đã publish không nhận lại message của mình.
          if (key === name) continue;
          setImmediate(() => handler(message));
        }
      },
      subscribe: (handler) => {
        this.handlers.set(name, handler);
      },
      close: async () => {
        this.handlers.delete(name);
      },
    };
  }

  readonly busA = this.end("a");
  readonly busB = this.end("b");
}

const HUB_STUB = (calls: unknown[][]): GatewayHub =>
  ({
    setPresenceRelay: () => undefined,
    deliverToChannel: (...args: unknown[]) => calls.push(["channel", ...args]),
    deliverToGuild: (...args: unknown[]) => calls.push(["guild", ...args]),
    deliverToUser: (...args: unknown[]) => calls.push(["user", ...args]),
    deliverVoiceState: (...args: unknown[]) => calls.push(["voice", ...args]),
  }) as unknown as GatewayHub;

function captureBus(): { bus: EventBus; fire: (message: BusMessage) => void } {
  let handler: ((message: BusMessage) => void) | null = null;
  return {
    bus: {
      publish: () => undefined,
      subscribe: (next) => {
        handler = next;
      },
      close: async () => undefined,
    },
    fire: (message) => handler?.(message),
  };
}

describe("ClusterPublisher — đơn vị", () => {
  it("fan-out tại chỗ trước, rồi mới publish lên bus", () => {
    const order: string[] = [];
    const bus: EventBus = {
      publish: () => order.push("bus"),
      subscribe: () => undefined,
      close: async () => undefined,
    };
    const hub = {
      setPresenceRelay: () => undefined,
      deliverToChannel: () => order.push("local"),
    } as unknown as GatewayHub;
    const publisher = new ClusterPublisher(hub, bus, "node-1");
    order.length = 0; // bỏ `__PRESENCE_SYNC` phát lúc khởi tạo
    publisher.publishToChannel("1", "TYPING_START", { channelId: "1", userId: "2" } as never);
    expect(order).toEqual(["local", "bus"]);
  });

  it("bỏ qua message của chính mình (nếu không sẽ gửi trùng cho mọi người)", () => {
    const { bus, fire } = captureBus();
    const seen: unknown[] = [];
    const hub = {
      setPresenceRelay: () => undefined,
      deliverToChannel: (channelId: string) => seen.push(channelId),
    } as unknown as GatewayHub;
    new ClusterPublisher(hub, bus, "node-1");
    fire({ origin: "node-1", scope: "channel", target: "111", event: "TYPING_START", data: {} });
    expect(seen).toEqual([]);
    fire({ origin: "node-2", scope: "channel", target: "222", event: "TYPING_START", data: {} });
    expect(seen).toEqual(["222"]);
  });

  it("định tuyến message theo scope sang đúng hàm của hub", () => {
    const calls: unknown[][] = [];
    const { bus, fire } = captureBus();
    new ClusterPublisher(HUB_STUB(calls), bus, "node-1");
    for (const scope of ["channel", "guild", "user", "voice"] as const) {
      fire({ origin: "node-2", scope, target: "42", event: "VOICE_STATE_UPDATE", data: { channelId: "42" } });
    }
    expect(calls.map((call) => call[0])).toEqual(["channel", "guild", "user", "voice"]);
    expect(calls.every((call) => call[1] === "42")).toBe(true);
  });

  it("giữ nguyên thao tác trạng thái node — không đẩy lên bus", async () => {
    const calls: unknown[][] = [];
    const hub = {
      setPresenceRelay: () => undefined,
      grantChannelAccess: (...args: unknown[]) => calls.push(["grant", ...args]),
      revokeChannelAccess: (...args: unknown[]) => calls.push(["revoke", ...args]),
      refreshGuildVisibility: async () => {
        calls.push(["guildVis"]);
      },
      refreshUserVisibility: async () => {
        calls.push(["userVis"]);
      },
      refreshFriendAudience: async () => {
        calls.push(["friends"]);
      },
    } as unknown as GatewayHub;
    const published: BusMessage[] = [];
    const bus: EventBus = {
      publish: (message) => published.push(message),
      subscribe: () => undefined,
      close: async () => undefined,
    };
    const publisher = new ClusterPublisher(hub, bus, "node-1");
    publisher.grantChannelAccess("1", ["2"]);
    publisher.revokeChannelAccess("1", ["2"]);
    void publisher.refreshGuildVisibility("3");
    void publisher.refreshUserVisibility("4");
    // Danh sách bạn **không** giữ cục bộ: phải báo node khác tính lại, nếu không
    // bạn mới kết ở node khác sẽ không thấy nhau online cho tới lần reconnect.
    await publisher.refreshFriendAudience("5");
    expect(calls).toEqual([
      ["grant", "1", ["2"]],
      ["revoke", "1", ["2"]],
      ["guildVis"],
      ["userVis"],
      ["friends"],
    ]);
    // `__PRESENCE_SYNC` là câu hỏi node mới gửi lúc khởi tạo — có trước, không
    // liên quan tới lệnh làm bạn.
    expect(published.map((entry) => [entry.scope, entry.event, entry.target])).toEqual([
      ["control", "__PRESENCE_SYNC", ""],
      ["control", "__REFRESH_FRIENDS", "5"],
    ]);
  });

  it("message sai hình dạng từ bus bị bỏ qua, không làm sập node", () => {
    const calls: unknown[][] = [];
    const { bus, fire } = captureBus();
    new ClusterPublisher(HUB_STUB(calls), bus, "node-1");
    expect(() => fire({ origin: "node-2" } as BusMessage)).not.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("Gateway nhiều node", () => {
  let nodeA: TestContext;
  let nodeB: TestContext;
  let wire: WireHub;
  let urlA = "";
  let urlB = "";
  const clients: GatewayTestClient[] = [];

  beforeAll(async () => {
    wire = new WireHub();
    nodeA = await createTestContext({}, { bus: wire.busA, nodeId: "node-a" });
    // Node B dùng **cùng pool** nên không migrate/truncate lại (sẽ xoá dữ liệu
    // node A vừa tạo); đóng B cũng không `end()` pool của A.
    nodeB = await createTestContext({}, { bus: wire.busB, nodeId: "node-b", pool: nodeA.pool });
    await nodeA.app.listen({ port: 0, host: "127.0.0.1" });
    await nodeB.app.listen({ port: 0, host: "127.0.0.1" });
    urlA = `ws://127.0.0.1:${(nodeA.app.server.address() as AddressInfo).port}/api/v1/gateway/ws`;
    urlB = `ws://127.0.0.1:${(nodeB.app.server.address() as AddressInfo).port}/api/v1/gateway/ws`;
  }, 30_000);

  afterAll(async () => {
    for (const client of clients) client.close();
    await nodeB?.close();
    await nodeA?.close();
  });

  async function connect(url: string, user: RegisteredUser): Promise<GatewayTestClient> {
    const { client } = await GatewayTestClient.connect(url);
    clients.push(client);
    client.send({ op: 2, d: { token: user.token } });
    await client.next((frame) => frame.op === 0 && frame.t === "READY");
    return client;
  }

  async function guildWithTwoMembers(): Promise<{ channelId: string; owner: RegisteredUser; member: RegisteredUser }> {
    const tag = randomUUID().slice(0, 8);
    const owner = await registerUser(nodeA, `cluown${tag}`);
    const member = await registerUser(nodeA, `clumb${tag}`);
    const guildId = await createGuild(nodeA, owner.token, "Cluster");
    const channelId = (await listChannels(nodeA, owner.token, guildId))[0]!.id;
    const invite = await nodeA.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(owner.token),
      payload: { channelId },
    });
    const { code } = invite.json<{ code: string }>();
    const joined = await nodeA.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(member.token),
    });
    expect(joined.statusCode).toBe(200);
    return { channelId, owner, member };
  }

  it("người nối node B nhận tin gửi qua REST ở node A", async () => {
    const { channelId, owner, member } = await guildWithTwoMembers();
    const onB = await connect(urlB, member);
    const onA = await connect(urlA, owner);

    const sent = await nodeA.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(owner.token),
      payload: { content: "từ node A" },
    });
    expect(sent.statusCode).toBe(201);
    const messageId = sent.json<{ id: string }>().id;

    // Người ở node B nhận được nhờ bus; người ở node A nhận trực tiếp.
    const atB = await onB.next((frame) => frame.op === 0 && frame.t === "MESSAGE_CREATE");
    const atA = await onA.next((frame) => frame.op === 0 && frame.t === "MESSAGE_CREATE");
    expect((atB.d as { id: string }).id).toBe(messageId);
    expect((atA.d as { id: string }).id).toBe(messageId);
    // Bus phải mang **đúng một** message cho sự kiện này: node phát fan-out tại
    // chỗ rồi publish một lần, không publish vòng qua bus của chính mình.
    const forMessage = wire.published.filter(
      (entry) => entry.scope === "channel" && entry.event === "MESSAGE_CREATE",
    );
    expect(forMessage).toHaveLength(1);
    expect(forMessage[0]!.origin).toBe("node-a");
    expect(forMessage[0]!.target).toBe(channelId);
  }, 20_000);

  it("node B không gửi trùng sự kiện do chính nó phát", async () => {
    const { channelId, owner, member } = await guildWithTwoMembers();
    const onB = await connect(urlB, member);
    await connect(urlA, owner);
    const before = wire.published.length;
    const sent = await nodeB.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(member.token),
      payload: { content: "từ node B" },
    });
    expect(sent.statusCode).toBe(201);
    const first = await onB.next((frame) => frame.op === 0 && frame.t === "MESSAGE_CREATE");
    expect((first.d as { content: string }).content).toBe("từ node B");
    // Người gửi ngay trên node B: nếu logic sai, họ nhận tin hai lần.
    await expect(
      onB.next((frame) => frame.op === 0 && frame.t === "MESSAGE_CREATE", 150),
    ).rejects.toThrow();
    expect(wire.published.length - before).toBe(1);
  }, 20_000);

  it("presence đi qua bus: người nối node A hiện online với người ở node B", async () => {
    const { owner, member } = await guildWithTwoMembers();
    // Alice nối **trước** ở node A; Bob vào sau ở node B. Node B không có session
    // nào của Alice, nên chỉ bus mới cho Bob biết Alice đang online.
    const onA = await connect(urlA, owner);
    const { client: onB } = await GatewayTestClient.connect(urlB);
    clients.push(onB);
    onB.send({ op: 2, d: { token: member.token } });
    const ready = await onB.next((frame) => frame.op === 0 && frame.t === "READY");
    const presences = (ready.d as { presences: Array<{ userId: string; status: string }> }).presences;
    expect(presences.find((entry) => entry.userId === owner.id)?.status).toBe("online");

    // Đổi trạng thái ở node A → Bob ở node B nhận ngay.
    onA.send({ op: 3, d: { status: "dnd" } });
    const update = await onB.next(
      (frame) =>
        frame.op === 0 &&
        frame.t === "PRESENCE_UPDATE" &&
        (frame.d as { userId: string }).userId === owner.id,
    );
    expect((update.d as { status: string }).status).toBe("dnd");
  }, 20_000);

  it("typing từ node này không echo về chính người gõ ở node kia", async () => {
    const { channelId, owner, member } = await guildWithTwoMembers();
    const onA = await connect(urlA, owner);
    const onB = await connect(urlB, member);
    await nodeA.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/typing`,
      headers: auth(owner.token),
    });
    const atB = await onB.next((frame) => frame.op === 0 && frame.t === "TYPING_START");
    expect((atB.d as { userId: string }).userId).toBe(owner.id);
    // Người gõ (node A) không nhận lại typing của chính mình.
    await expect(
      onA.next((frame) => frame.op === 0 && frame.t === "TYPING_START", 150),
    ).rejects.toThrow();
  }, 20_000);
});

describe("Cấu hình nhiều node", () => {
  it("mặc định một node: không có bus, tên node theo host:pid", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.redisUrl).toBeNull();
    expect(config.redisChannel).toBe("umaru:gateway");
    expect(config.nodeId).toMatch(/^.+:\d+$/);
  });

  it("đọc REDIS_URL / REDIS_CHANNEL / GATEWAY_NODE_ID", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      REDIS_URL: "rediss://:mat-khau@redis.internal:6380/1",
      REDIS_CHANNEL: "umaru:staging",
      GATEWAY_NODE_ID: "api-2",
    });
    expect(config.redisUrl).toBe("rediss://:mat-khau@redis.internal:6380/1");
    expect(config.redisChannel).toBe("umaru:staging");
    expect(config.nodeId).toBe("api-2");
  });
});

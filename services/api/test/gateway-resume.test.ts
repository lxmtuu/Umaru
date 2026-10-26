import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/gateway/sessionStore.js";
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
import { WireHub } from "./wire-bus.js";

/**
 * Resume **qua node** (ADR-0006): client mất mạng, reconnect vào node khác, và
 * vẫn nhận đúng những frame đã lỡ thay vì phải full resync.
 *
 * Điều kiện để test có nghĩa: hai app thật dùng chung Postgres **và** chung một
 * `SessionStore`; session được tạo ở node A, frame replay do node A ghi, rồi
 * node B đọc lại. `MemorySessionStore` đóng vai Redis ở đây — phần giao thức
 * Redis được kiểm riêng ở `redis-session-store.test.ts`.
 */

const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Hết thời gian chờ điều kiện");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("Resume khi session nằm ở node khác", () => {
  let nodeA: TestContext;
  let nodeB: TestContext;
  const store = new MemorySessionStore();
  let urlA = "";
  let urlB = "";
  const clients: GatewayTestClient[] = [];

  beforeAll(async () => {
    const wire = new WireHub();
    nodeA = await createTestContext({}, { bus: wire.end("a"), nodeId: "node-a", sessionStore: store });
    nodeB = await createTestContext(
      {},
      { bus: wire.end("b"), nodeId: "node-b", sessionStore: store, pool: nodeA.pool },
    );
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

  async function identify(url: string, user: RegisteredUser): Promise<{ client: GatewayTestClient; sessionId: string; seq: number }> {
    const { client } = await GatewayTestClient.connect(url);
    clients.push(client);
    client.send({ op: 2, d: { token: user.token } });
    const ready = await client.next((frame) => frame.op === 0 && frame.t === "READY", 5_000);
    const data = ready.d as { sessionId: string };
    return { client, sessionId: data.sessionId, seq: ready.s ?? 0 };
  }

  async function setUpGuild(): Promise<{ channelId: string; owner: RegisteredUser }> {
    const tag = randomUUID().slice(0, 8);
    const owner = await registerUser(nodeA, `res${tag}`);
    const guildId = await createGuild(nodeA, owner.token, "Resume");
    const channelId = (await listChannels(nodeA, owner.token, guildId))[0]!.id;
    return { channelId, owner };
  }

  function send(channelId: string, token: string, content: string): Promise<{ statusCode: number }> {
    return nodeA.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(token),
      payload: { content },
    });
  }

  it("nhận lại đúng những tin đã lỡ, không cần full resync", async () => {
    const { channelId, owner } = await setUpGuild();
    const { client, sessionId, seq } = await identify(urlA, owner);

    const first = await send(channelId, owner.token, "trước khi ngắt");
    expect(first.statusCode).toBe(201);
    const received = await client.next((frame) => frame.op === 0 && frame.t === "MESSAGE_CREATE");
    const seenSeq = received.s ?? seq;

    // Mất mạng: socket đóng nhưng session còn sống (chờ resume trong TTL).
    client.close();
    await waitFor(async () => (await store.load(sessionId))?.disconnectedAt !== null);

    // Trong lúc offline, hai tin mới được phát — node A vẫn ghi replay vì session
    // của owner nằm ở đó, dù socket đã đóng.
    expect((await send(channelId, owner.token, "lỡ 1")).statusCode).toBe(201);
    expect((await send(channelId, owner.token, "lỡ 2")).statusCode).toBe(201);
    await waitFor(async () => (await store.readReplay(sessionId, seenSeq)).length === 2);

    // Reconnect **vào node B** — node này chưa từng có session đó trong RAM.
    const { client: resumed } = await GatewayTestClient.connect(urlB);
    clients.push(resumed);
    resumed.send({ op: 6, d: { token: owner.token, sessionId, seq: seenSeq } });

    const replayed: Array<{ s: number; content: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const frame = await resumed.next((entry) => entry.op === 0 && entry.t === "MESSAGE_CREATE", 5_000);
      replayed.push({ s: frame.s ?? 0, content: (frame.d as { content: string }).content });
    }
    expect(replayed.map((frame) => frame.content)).toEqual(["lỡ 1", "lỡ 2"]);
    expect(replayed[0]!.s).toBeGreaterThan(seenSeq);
    expect(replayed[1]!.s).toBeGreaterThan(replayed[0]!.s);

    const resumedFrame = await resumed.next((frame) => frame.op === 0 && frame.t === "RESUMED", 5_000);
    expect(resumedFrame.s).toBeGreaterThan(replayed[1]!.s);
    resumed.close();
  }, 30_000);

  it("node cũ nhả session sau khi node mới nhận — không còn hai chủ", async () => {
    const { channelId, owner } = await setUpGuild();
    const { client, sessionId, seq } = await identify(urlA, owner);
    client.close();
    await waitFor(async () => (await store.load(sessionId))?.disconnectedAt !== null);
    expect(nodeA.hub.getStats().sessions).toBe(1);

    const { client: resumed } = await GatewayTestClient.connect(urlB);
    clients.push(resumed);
    resumed.send({ op: 6, d: { token: owner.token, sessionId, seq } });
    await resumed.next((frame) => frame.op === 0 && frame.t === "RESUMED", 5_000);

    // Node A bỏ session qua bus (không phát offline: người dùng đang online ở B).
    await waitFor(() => nodeA.hub.getStats().sessions === 0);
    expect((await store.load(sessionId))?.node).toBe("node-b");

    // Tin mới vẫn tới node B đúng **một** lần.
    expect((await send(channelId, owner.token, "sau takeover")).statusCode).toBe(201);
    const frame = await resumed.next(
      (entry) => entry.op === 0 && entry.t === "MESSAGE_CREATE" && (entry.d as { content: string }).content === "sau takeover",
      5_000,
    );
    expect(frame.s).toBeGreaterThan(0);
    await expect(
      resumed.next(
        (entry) => entry.op === 0 && entry.t === "MESSAGE_CREATE" && (entry.d as { content: string }).content === "sau takeover",
        300,
      ),
    ).rejects.toThrow();
    resumed.close();
  }, 30_000);

  it("session id không tồn tại → INVALID_SESSION false, socket vẫn mở", async () => {
    const owner = await registerUser(nodeA, `bad${randomUUID().slice(0, 8)}`);
    const { client } = await GatewayTestClient.connect(urlB);
    clients.push(client);
    client.send({ op: 6, d: { token: owner.token, sessionId: "khong-co", seq: 0 } });
    const frame = await client.next((entry) => entry.op === 9, 5_000);
    // `d: false` = identify lại từ đầu; socket **không** bị đóng.
    expect(frame.d).toBe(false);

    // Bằng chứng socket còn sống: heartbeat vẫn được trả lời.
    client.send({ op: 1, d: null });
    await client.next((entry) => entry.op === 11, 5_000);
    client.close();
  }, 20_000);

  it("replay có khoảng trống → buộc identify lại thay vì resume thiếu tin", async () => {
    const { owner } = await setUpGuild();
    const { client, sessionId, seq } = await identify(urlA, owner);
    client.close();
    await waitFor(async () => (await store.load(sessionId))?.disconnectedAt !== null);

    // Server đã phát thêm 3 frame nhưng replay không còn (bị cắt / node chết
    // trước khi ghi). Client sẽ mất tin nếu ta resume như không có gì.
    const meta = (await store.load(sessionId))!;
    await store.save({ ...meta, seq: meta.seq + 3 }, 300_000);

    const before = nodeB.hub.getStats().sessions;
    const { client: resumed } = await GatewayTestClient.connect(urlB);
    clients.push(resumed);
    resumed.send({ op: 6, d: { token: owner.token, sessionId, seq } });
    const frame = await resumed.next((entry) => entry.op === 9, 5_000);
    expect(frame.d).toBe(false);
    // Không được giữ lại nửa session "đã nhận" trên node B.
    expect(nodeB.hub.getStats().sessions).toBe(before);
    resumed.close();
  }, 20_000);

  it("session của người khác không resume được", async () => {
    const { owner } = await setUpGuild();
    const other = await registerUser(nodeA, `other${randomUUID().slice(0, 8)}`);
    const { client, sessionId, seq } = await identify(urlA, owner);
    client.close();
    await waitFor(async () => (await store.load(sessionId))?.disconnectedAt !== null);

    const { client: intruder } = await GatewayTestClient.connect(urlB);
    clients.push(intruder);
    intruder.send({ op: 6, d: { token: other.token, sessionId, seq } });
    const frame = await intruder.next((entry) => entry.op === 9, 5_000);
    expect(frame.d).toBe(false);
    intruder.close();
  }, 20_000);
});

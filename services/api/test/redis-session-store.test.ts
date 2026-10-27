import { afterEach, describe, expect, it } from "vitest";
import { RedisClient } from "../src/gateway/redis-client.js";
import { RedisSessionStore } from "../src/gateway/redis-session-store.js";
import { FakeRedis } from "./fake-redis.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Hết thời gian chờ điều kiện");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const record = (overrides: Partial<Parameters<RedisSessionStore["save"]>[0]> = {}) => ({
  id: "sess-1",
  userId: "42",
  seq: 7,
  node: "node-a",
  disconnectedAt: null,
  ...overrides,
});

describe("RedisClient", () => {
  let client: RedisClient | null = null;
  let redis: FakeRedis | null = null;

  afterEach(async () => {
    await client?.close();
    await redis?.stop();
    client = null;
    redis = null;
  });

  it("ghép đúng reply với lệnh khi gửi nhiều lệnh một lượt", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    client = new RedisClient({ url: `redis://127.0.0.1:${port}` });
    const replies = await client.pipeline([
      ["HSET", "a", "x", "1"],
      ["HSET", "a", "y", "2"],
      ["HGETALL", "a"],
    ]);
    expect(replies[0]).toBe(1);
    expect(replies[2]).toEqual(["x", "1", "y", "2"]);
  });

  it("gửi AUTH/SELECT trước lệnh thật", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    client = new RedisClient({ url: `redis://:mat-khau@127.0.0.1:${port}/3` });
    await client.command(["HSET", "k", "f", "v"]);
    expect(redis.commands.map((args) => args[0])).toEqual(["AUTH", "SELECT", "HSET"]);
  });

  it("lệnh lỗi được trả về dưới dạng Error, không treo", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    client = new RedisClient({ url: `redis://127.0.0.1:${port}` });
    await expect(client.command(["KHONGCO", "x"])).rejects.toThrow(/không hỗ trợ/);
  });

  it("báo lỗi rõ khi không kết nối được", async () => {
    client = new RedisClient({ url: "redis://127.0.0.1:1", replyTimeoutMs: 300 });
    await expect(client.command(["PING"])).rejects.toThrow();
  });
});

describe("RedisSessionStore", () => {
  let client: RedisClient | null = null;
  let store: RedisSessionStore | null = null;
  let redis: FakeRedis | null = null;

  const setup = async (): Promise<void> => {
    redis = new FakeRedis();
    const port = await redis.start();
    client = new RedisClient({ url: `redis://127.0.0.1:${port}` });
    store = new RedisSessionStore(client);
  };

  afterEach(async () => {
    await store?.close();
    await redis?.stop();
    store = null;
    client = null;
    redis = null;
  });

  it("save/load giữ đủ userId, seq, node và đặt TTL", async () => {
    await setup();
    await store!.save(record(), 300_000);
    const loaded = await store!.load("sess-1");
    expect(loaded).toEqual(record());
    expect(redis!.ttls.get("umaru:session:sess-1")?.ms).toBe(300_000);
  });

  it("load trả null với session không tồn tại", async () => {
    await setup();
    expect(await store!.load("không-có")).toBeNull();
  });

  it("disconnectedAt null được giữ nguyên (không thành 0)", async () => {
    await setup();
    await store!.save(record({ disconnectedAt: null }), 1_000);
    expect((await store!.load("sess-1"))!.disconnectedAt).toBeNull();
    await store!.save(record({ disconnectedAt: 1_700_000_000_000 }), 1_000);
    expect((await store!.load("sess-1"))!.disconnectedAt).toBe(1_700_000_000_000);
  });

  it("replay chỉ giữ maxFrames frame gần nhất", async () => {
    await setup();
    for (let seq = 1; seq <= 5; seq += 1) {
      store!.appendReplay("sess-1", seq, { op: 0, s: seq }, 60_000, 3);
    }
    await waitFor(() => (redis!.lists.get("umaru:replay:sess-1")?.length ?? 0) === 3);
    expect((await store!.readReplay("sess-1", 0)).map((frame) => frame.s)).toEqual([3, 4, 5]);
  });

  it("readReplay chỉ trả frame có s lớn hơn mốc client đã nhận", async () => {
    await setup();
    for (let seq = 1; seq <= 4; seq += 1) store!.appendReplay("sess-1", seq, { s: seq }, 60_000, 10);
    await waitFor(() => (redis!.lists.get("umaru:replay:sess-1")?.length ?? 0) === 4);
    const missed = await store!.readReplay("sess-1", 2);
    expect(missed.map((frame) => frame.s)).toEqual([3, 4]);
    expect((await store!.readReplay("sess-1", 4))).toEqual([]);
  });

  it("replay đặt TTL riêng để không sống mãi sau khi session bị bỏ", async () => {
    await setup();
    store!.appendReplay("sess-1", 1, { s: 1 }, 120_000, 10);
    await waitFor(() => redis!.ttls.has("umaru:replay:sess-1"));
    expect(redis!.ttls.get("umaru:replay:sess-1")?.ms).toBe(120_000);
  });

  it("claim đổi node sở hữu và gia hạn TTL", async () => {
    await setup();
    await store!.save(record(), 1_000);
    await store!.claim("sess-1", "node-b", 300_000);
    expect((await store!.load("sess-1"))!.node).toBe("node-b");
    expect(redis!.ttls.get("umaru:session:sess-1")?.ms).toBe(300_000);
  });

  it("delete xoá cả session lẫn replay", async () => {
    await setup();
    await store!.save(record(), 1_000);
    store!.appendReplay("sess-1", 1, { s: 1 }, 1_000, 10);
    await waitFor(() => redis!.lists.has("umaru:replay:sess-1"));
    await store!.delete("sess-1");
    expect(await store!.load("sess-1")).toBeNull();
    expect(await store!.readReplay("sess-1", 0)).toEqual([]);
  });

  it("frame hỏng trong list bị bỏ qua, không làm hỏng cả lần resume", async () => {
    await setup();
    redis!.lists.set("umaru:replay:sess-1", ["{hỏng", JSON.stringify({ s: 2, payload: { ok: true } })]);
    const frames = await store!.readReplay("sess-1", 0);
    expect(frames).toEqual([{ s: 2, payload: { ok: true } }]);
  });

  it("tiền tố khoá đổi được khi nhiều môi trường chung một Redis", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    client = new RedisClient({ url: `redis://127.0.0.1:${port}` });
    store = new RedisSessionStore(client, "umaru-staging");
    await store.save(record(), 1_000);
    expect([...redis.hashes.keys()]).toEqual(["umaru-staging:session:sess-1"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { BusMessage } from "../src/gateway/bus.js";
import { encodeCommand, parseRedisUrl, RedisBus, RespReader } from "../src/gateway/redis-bus.js";
import { FakeRedis } from "./fake-redis.js";

/**
 * `RedisBus` chạy với Redis **giả** nói RESP thật trên TCP: chứng minh khung dữ
 * liệu và luồng lệnh (subscribe, publish, tự nối lại), **không** chứng minh hành
 * vi riêng của Redis thật (persist, ACL, cluster).
 */

const message = (overrides: Partial<BusMessage> = {}): BusMessage => ({
  origin: "node-a",
  scope: "channel",
  target: "123",
  event: "MESSAGE_CREATE",
  data: { id: "1", content: "chào" },
  ...overrides,
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Hết thời gian chờ điều kiện");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("parseRedisUrl", () => {
  it("đọc host/port mặc định", () => {
    expect(parseRedisUrl("redis://127.0.0.1")).toEqual({
      host: "127.0.0.1",
      port: 6379,
      secure: false,
      username: null,
      password: null,
      db: null,
    });
  });

  it("đọc TLS, user/pass đã mã hoá URL và số DB", () => {
    expect(parseRedisUrl("rediss://umaru:p%40ss@redis.internal:6380/3")).toEqual({
      host: "redis.internal",
      port: 6380,
      secure: true,
      username: "umaru",
      password: "p@ss",
      db: 3,
    });
  });

  it("chỉ nhận redis:// và rediss://", () => {
    expect(() => parseRedisUrl("http://redis:6379")).toThrow(/redis:\/\//);
    expect(() => parseRedisUrl("không-phải-url")).toThrow(/không hợp lệ/);
  });

  it("số DB không hợp lệ bị chặn", () => {
    expect(() => parseRedisUrl("redis://h:6379/abc")).toThrow(/DB/);
  });
});

describe("RESP", () => {
  it("encodeCommand đúng định dạng Redis", () => {
    expect(encodeCommand(["PUBLISH", "kênh", "xin chào"])).toBe(
      "*3\r\n$7\r\nPUBLISH\r\n$5\r\nkênh\r\n$9\r\nxin chào\r\n",
    );
  });

  it("đếm byte theo UTF-8, không theo số ký tự", () => {
    // "chào" = 5 byte (4 chữ + dấu) nhưng 4 ký tự; sai độ dài là Redis cắt cụt.
    expect(encodeCommand(["X", "chào"])).toContain("$5\r\nchào");
  });

  it("đọc được reply bị cắt làm nhiều mẩu TCP", () => {
    const reader = new RespReader();
    const payload = "*3\r\n$7\r\nmessage\r\n$5\r\nkênh\r\n$2\r\nhi\r\n";
    const chunks = [payload.slice(0, 5), payload.slice(5, 20), payload.slice(20)];
    const replies: unknown[] = [];
    for (const chunk of chunks) replies.push(...reader.push(Buffer.from(chunk, "utf8")));
    expect(replies).toEqual([["message", "kênh", "hi"]]);
  });

  it("đọc nhiều reply trong một mẩu", () => {
    const reader = new RespReader();
    const replies = reader.push(Buffer.from("+OK\r\n:1\r\n*2\r\n$1\r\na\r\n$-1\r\n", "utf8"));
    expect(replies).toHaveLength(3);
    expect(replies[0]).toBe("OK");
    expect(replies[1]).toBe(1);
    expect(replies[2]).toEqual(["a", null]);
  });
});

describe("RedisBus", () => {
  let bus: RedisBus | null = null;
  let redis: FakeRedis | null = null;

  afterEach(async () => {
    await bus?.close();
    await redis?.stop();
    bus = null;
    redis = null;
  });

  it("nhận message từ Redis và giải mã thành BusMessage", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    const received: BusMessage[] = [];
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}`, reconnectDelayMs: 20 });
    bus.subscribe((entry) => received.push(entry));
    await waitFor(() => redis!.commands.some((args) => args[0] === "SUBSCRIBE"));
    redis.pushMessage("umaru:gateway", JSON.stringify(message()));
    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual(message());
  });

  it("bỏ qua message rác mà không làm sập tiến trình", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    const received: BusMessage[] = [];
    const logs: string[] = [];
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}`, log: (line) => logs.push(line) });
    bus.subscribe((entry) => received.push(entry));
    await waitFor(() => redis!.commands.some((args) => args[0] === "SUBSCRIBE"));
    redis.pushMessage("umaru:gateway", "{không phải json");
    redis.pushMessage("umaru:gateway", JSON.stringify({ origin: "x" }));
    redis.pushMessage("umaru:gateway", JSON.stringify(message()));
    await waitFor(() => received.length > 0);
    expect(received).toEqual([message()]);
    expect(logs.filter((line) => line.includes("bỏ qua"))).toHaveLength(2);
  });

  it("gửi AUTH/SELECT trước khi subscribe khi URL có mật khẩu và DB", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    bus = new RedisBus({ url: `redis://:b%C3%ADm@127.0.0.1:${port}/2` });
    bus.subscribe(() => undefined);
    await waitFor(() => redis!.commands.some((args) => args[0] === "SUBSCRIBE"));
    expect(redis.commands.map((args) => args[0])).toEqual(["AUTH", "SELECT", "SUBSCRIBE"]);
    expect(redis.commands[1]).toEqual(["SELECT", "2"]);
    expect(redis.commands[0]![1]).toBe("bím");
  });

  it("PUBLISH đi đúng kênh và đúng payload JSON", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}` });
    bus.publish(message());
    await waitFor(() => redis!.published.length > 0);
    expect(redis.published[0]!.channel).toBe("umaru:gateway");
    expect(JSON.parse(redis.published[0]!.payload)).toEqual(message());
  });

  it("publish trước khi nối xong thì được gửi bù, không mất", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}` });
    bus.publish(message({ target: "sớm" }));
    await waitFor(() => redis!.published.length === 1);
    expect(JSON.parse(redis.published[0]!.payload).target).toBe("sớm");
  });

  it("tự subscribe lại sau khi Redis restart", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}`, reconnectDelayMs: 10 });
    bus.subscribe(() => undefined);
    await waitFor(() => redis!.commands.filter((args) => args[0] === "SUBSCRIBE").length === 1);
    redis.dropAll();
    await waitFor(() => redis!.commands.filter((args) => args[0] === "SUBSCRIBE").length >= 2, 3_000);
  });

  it("kênh tuỳ chỉnh được tôn trọng", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}`, channel: "umaru:staging" });
    bus.subscribe(() => undefined);
    await waitFor(() => redis!.commands.some((args) => args[0] === "SUBSCRIBE"));
    expect(redis.commands.find((args) => args[0] === "SUBSCRIBE")![1]).toBe("umaru:staging");
  });

  it("close() đóng kết nối và ngừng publish", async () => {
    redis = new FakeRedis();
    const port = await redis.start();
    const created = new RedisBus({ url: `redis://127.0.0.1:${port}` });
    created.publish(message());
    await waitFor(() => redis!.published.length === 1);
    await created.close();
    created.publish(message({ target: "sau khi đóng" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(redis.published).toHaveLength(1);
    expect(created.getStatus().connected).toBe(false);
  });
});

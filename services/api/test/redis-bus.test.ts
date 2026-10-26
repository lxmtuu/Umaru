import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { BusMessage } from "../src/gateway/bus.js";
import { encodeCommand, parseRedisUrl, RedisBus, RespReader } from "../src/gateway/redis-bus.js";

/**
 * Redis **giả**: một server TCP nói RESP thật, đủ để `RedisBus` chạy trọn vòng
 * (AUTH → SUBSCRIBE → nhận message; PUBLISH → đếm). Sandbox không có Redis nên
 * đây là mức cao nhất kiểm được mà không cần dịch vụ ngoài — nó chứng minh
 * **khung dữ liệu và luồng lệnh**, không chứng minh hành vi của Redis thật
 * (persist, ACL, cluster…). Điều đó ghi rõ trong DEPLOY.md.
 */
class FakeRedis {
  readonly commands: string[][] = [];
  readonly published: Array<{ channel: string; payload: string }> = [];
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private subscribers: net.Socket[] = [];

  async start(): Promise<number> {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Đẩy message tới mọi kết nối đã SUBSCRIBE — như Redis fan-out. */
  pushMessage(channel: string, payload: string): void {
    for (const socket of this.subscribers) {
      socket.write(`*3\r\n$7\r\nmessage\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n$${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
    }
  }

  /** Ngắt mọi kết nối đang mở (mô phỏng Redis restart). */
  dropAll(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.subscribers = [];
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = readCommand(buffer);
        if (parsed === null) return;
        buffer = buffer.subarray(parsed.next);
        this.handle(socket, parsed.args);
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.subscribers = this.subscribers.filter((open) => open !== socket);
    });
    socket.on("error", () => undefined);
  }

  private handle(socket: net.Socket, args: string[]): void {
    this.commands.push(args);
    const name = (args[0] ?? "").toUpperCase();
    if (name === "AUTH" || name === "SELECT") {
      socket.write("+OK\r\n");
      return;
    }
    if (name === "SUBSCRIBE") {
      this.subscribers.push(socket);
      const channel = args[1] ?? "";
      socket.write(`*3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n:1\r\n`);
      return;
    }
    if (name === "PUBLISH") {
      this.published.push({ channel: args[1] ?? "", payload: args[2] ?? "" });
      socket.write(":1\r\n");
      return;
    }
    socket.write("-ERR lệnh không hỗ trợ\r\n");
  }
}

/**
 * Đọc một lệnh RESP (array bulk string) từ buffer; `null` = chưa đủ.
 *
 * Làm việc trên **Buffer**, không phải string: độ dài trong RESP là **byte**,
 * còn `String.slice` đếm **ký tự**. Payload có tiếng Việt (2 byte/ký tự) sẽ làm
 * bộ đọc chờ mãi — đúng cái bẫy mà test này sinh ra để bắt.
 */
function readCommand(buffer: Buffer): { args: string[]; next: number } | null {
  const text = buffer.toString("utf8");
  if (!text.startsWith("*")) return null;
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd < 0) return null;
  const count = Number(text.slice(1, headerEnd));
  let cursor = headerEnd + 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lengthEnd = buffer.indexOf("\r\n", cursor);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.subarray(cursor + 1, lengthEnd).toString("utf8"));
    const start = lengthEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    args.push(buffer.subarray(start, end).toString("utf8"));
    cursor = end + 2;
  }
  return { args, next: cursor };
}

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
    let subscribeCount = 0;
    bus = new RedisBus({ url: `redis://127.0.0.1:${port}`, reconnectDelayMs: 10 });
    bus.subscribe(() => undefined);
    await waitFor(() => (subscribeCount = redis!.commands.filter((args) => args[0] === "SUBSCRIBE").length) === 1);
    redis.dropAll();
    await waitFor(() => redis!.commands.filter((args) => args[0] === "SUBSCRIBE").length >= 2, 3_000);
    expect(subscribeCount).toBeGreaterThanOrEqual(1);
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

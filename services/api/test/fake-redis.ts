import net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * Redis **giả** nói RESP thật trên TCP, đủ cho những gì app dùng: pub/sub
 * (`SUBSCRIBE`/`PUBLISH`) và các lệnh của session store (`HSET`/`HGETALL`/
 * `PEXPIRE`/`DEL`/`RPUSH`/`LTRIM`/`LRANGE`).
 *
 * Vì sao cần: sandbox/CI không có Redis server, nhưng "client tự viết có nói
 * đúng giao thức không" phải trả lời bằng chạy thật, không phải bằng suy luận.
 * Nó **không** kiểm hành vi riêng của Redis (ACL, cluster, persist, độ bền) —
 * những thứ đó phải thử với Redis thật khi deploy.
 */

interface TtlEntry {
  ms: number;
  setAt: number;
}

export class FakeRedis {
  readonly commands: string[][] = [];
  readonly published: Array<{ channel: string; payload: string }> = [];
  readonly hashes = new Map<string, Map<string, string>>();
  readonly lists = new Map<string, string[]>();
  readonly ttls = new Map<string, TtlEntry>();

  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private subscribers: Array<{ socket: net.Socket; channel: string }> = [];

  async start(): Promise<number> {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.subscribers = [];
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Đẩy message tới mọi kết nối đã SUBSCRIBE kênh đó — như Redis fan-out. */
  pushMessage(channel: string, payload: string): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.channel !== channel) continue;
      subscriber.socket.write(replyArray(["message", channel, payload]));
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
      this.subscribers = this.subscribers.filter((entry) => entry.socket !== socket);
    });
    socket.on("error", () => undefined);
  }

  private handle(socket: net.Socket, args: string[]): void {
    this.commands.push(args);
    const name = (args[0] ?? "").toUpperCase();
    switch (name) {
      case "AUTH":
      case "SELECT":
      case "PING":
        socket.write("+OK\r\n");
        return;
      case "SUBSCRIBE": {
        const channel = args[1] ?? "";
        this.subscribers.push({ socket, channel });
        socket.write(replyArray(["subscribe", channel, 1]));
        return;
      }
      case "PUBLISH": {
        const channel = args[1] ?? "";
        const payload = args[2] ?? "";
        this.published.push({ channel, payload });
        let delivered = 0;
        for (const subscriber of this.subscribers) {
          if (subscriber.channel !== channel) continue;
          subscriber.socket.write(replyArray(["message", channel, payload]));
          delivered += 1;
        }
        socket.write(integer(delivered));
        return;
      }
      case "HSET": {
        const key = args[1] ?? "";
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        for (let index = 2; index + 1 < args.length; index += 2) {
          hash.set(args[index] ?? "", args[index + 1] ?? "");
        }
        this.hashes.set(key, hash);
        socket.write(integer(1));
        return;
      }
      case "HGETALL": {
        const key = args[1] ?? "";
        const hash = this.hashes.get(key);
        const flat: string[] = [];
        if (hash !== undefined) {
          for (const [field, value] of hash) flat.push(field, value);
        }
        socket.write(replyArray(flat));
        return;
      }
      case "PEXPIRE":
      case "EXPIRE": {
        const key = args[1] ?? "";
        const amount = Number(args[2] ?? "0");
        this.ttls.set(key, { ms: name === "EXPIRE" ? amount * 1000 : amount, setAt: Date.now() });
        socket.write(integer(1));
        return;
      }
      case "DEL": {
        let deleted = 0;
        for (const key of args.slice(1)) {
          if (this.hashes.delete(key)) deleted += 1;
          if (this.lists.delete(key)) deleted += 1;
          this.ttls.delete(key);
        }
        socket.write(integer(deleted));
        return;
      }
      case "RPUSH": {
        const key = args[1] ?? "";
        const list = this.lists.get(key) ?? [];
        list.push(...args.slice(2));
        this.lists.set(key, list);
        socket.write(integer(list.length));
        return;
      }
      case "LTRIM": {
        const key = args[1] ?? "";
        const list = this.lists.get(key) ?? [];
        const start = normalizeIndex(Number(args[2] ?? "0"), list.length);
        const stop = normalizeIndex(Number(args[3] ?? "-1"), list.length);
        const kept = stop < start ? [] : list.slice(start, stop + 1);
        this.lists.set(key, kept);
        socket.write("+OK\r\n");
        return;
      }
      case "LRANGE": {
        const key = args[1] ?? "";
        const list = this.lists.get(key) ?? [];
        const start = normalizeIndex(Number(args[2] ?? "0"), list.length);
        const stop = normalizeIndex(Number(args[3] ?? "-1"), list.length);
        socket.write(replyArray(stop < start ? [] : list.slice(start, stop + 1)));
        return;
      }
      default:
        socket.write(`-ERR lệnh không hỗ trợ: ${name}\r\n`);
    }
  }
}

/** Chỉ số âm tính từ cuối list (giống Redis). */
function normalizeIndex(index: number, length: number): number {
  return index < 0 ? Math.max(0, length + index) : index;
}

function integer(value: number): string {
  return `:${value}\r\n`;
}

function bulk(value: string): string {
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function replyArray(values: Array<string | number>): string {
  let out = `*${values.length}\r\n`;
  for (const value of values) {
    out += typeof value === "number" ? integer(value) : bulk(value);
  }
  return out;
}

/**
 * Đọc một lệnh RESP (array bulk string) từ buffer; `null` = chưa đủ.
 *
 * Làm việc trên **Buffer**, không phải string: độ dài trong RESP là **byte**,
 * còn `String.slice` đếm **ký tự**. Payload có tiếng Việt (2 byte/ký tự) sẽ làm
 * bộ đọc chờ mãi — đúng cái bẫy mà test này sinh ra để bắt.
 */
export function readCommand(buffer: Buffer): { args: string[]; next: number } | null {
  if (buffer[0] !== 0x2a /* "*" */) return null;
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd < 0) return null;
  const count = Number(buffer.subarray(1, headerEnd).toString("utf8"));
  let cursor = headerEnd + 2;
  const args: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[cursor] !== 0x24 /* "$" */) return null;
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

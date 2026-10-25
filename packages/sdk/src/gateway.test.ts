import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, type SocketEventLike, type WebSocketLike } from "./gateway.js";

class FakeWs implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, ((event: SocketEventLike) => void)[]>();

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SocketEventLike) => void,
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emitClose(1000);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.fire("open", {});
  }

  emitMessage(data: unknown): void {
    this.fire("message", { data });
  }

  emitClose(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code });
  }

  private fire(type: string, event: SocketEventLike): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function parseSent(ws: FakeWs, index: number): Record<string, any> {
  const raw = ws.sent[index];
  expect(raw).toBeDefined();
  return JSON.parse(raw as string);
}

describe("GatewayClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("identify khi mới kết nối, dispatch READY, resume sau khi mất kết nối", () => {
    const sockets: FakeWs[] = [];
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/?v=1&encoding=json",
      token: "test-token",
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0.5, // jitter cố định → backoff attempt0 = 1000ms
    });

    const onReady = vi.fn();
    const onMessage = vi.fn();
    client.on("READY", onReady);
    client.on("MESSAGE_CREATE", onMessage);

    // Kết nối lần đầu → Identify
    client.connect();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emitOpen();

    const identify = parseSent(sockets[0]!, 0);
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("test-token");

    // Hello + READY → state ready
    sockets[0]!.emitMessage({ op: 10, d: { heartbeat_interval: 60_000 } });
    sockets[0]!.emitMessage({
      op: 0,
      t: "READY",
      s: 1,
      d: { user: { id: "1", username: "tester" }, sessionId: "sess-42" },
    });
    expect(client.state).toBe("ready");
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady.mock.calls[0]![0].sessionId).toBe("sess-42");
    expect(client.getSession()).toEqual({ sessionId: "sess-42", seq: 1 });

    // Event thường được dispatch typed
    sockets[0]!.emitMessage({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: { id: "100", channelId: "5", content: "xin chào" },
    });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0]![0].content).toBe("xin chào");

    // Mất kết nối ngoài ý muốn → backoff 1000ms → socket mới → Resume
    sockets[0]!.emitClose();
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.emitOpen();
    const resume = parseSent(sockets[1]!, 0);
    expect(resume.op).toBe(6);
    expect(resume.d.sessionId).toBe("sess-42");
    expect(resume.d.seq).toBe(2);

    // Resume thành công → ready lại
    sockets[1]!.emitMessage({ op: 0, t: "RESUMED", s: 3, d: {} });
    expect(client.state).toBe("ready");

    // close() chủ động → không reconnect
    client.close();
    expect(client.state).toBe("closed");
    expect(sockets[1]!.readyState).toBe(3);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("frame sai protocol → đóng kết nối thay vì parse lung tung", () => {
    const sockets: FakeWs[] = [];
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/",
      token: "t",
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0.5,
    });
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage("{not json");
    expect(sockets[0]!.readyState).toBe(3);
    expect(client.state).toBe("reconnecting");
  });

  it("đóng 4003 → xoá session, lần sau IDENTIFY thay vì RESUME", () => {
    const sockets: FakeWs[] = [];
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/",
      token: "t",
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0,
    });
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "sess-1", user: {} } });

    // Server đóng 4003: session không còn resumable.
    sockets[0]!.emitClose(4003);
    expect(client.state).toBe("reconnecting");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emitOpen();
    const first = parseSent(sockets[1]!, 0);
    expect(first.op).toBe(2); // IDENTIFY
    expect(client.getSession()).toBeNull();
  });

  it("đóng 4004 (rate limited) → chờ tối thiểu 5 giây mới nối lại", () => {
    const sockets: FakeWs[] = [];
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/",
      token: "t",
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0, // backoff thường chỉ 1 s
    });
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "sess-9", user: {} } });

    sockets[0]!.emitClose(4004);
    vi.advanceTimersByTime(4_999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });
});

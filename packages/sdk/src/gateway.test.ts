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

  it("dedupe theo `s`: frame trùng/`s` cũ không phát lại, READY đặt lại bộ đếm", () => {
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
    const onMessage = vi.fn();
    client.on("MESSAGE_CREATE", onMessage);
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s1", user: {} } });

    const msg = (id: string, s: number) => ({
      op: 0,
      t: "MESSAGE_CREATE",
      s,
      d: { id, channelId: "5", content: id },
    });
    sockets[0]!.emitMessage(msg("a", 2));
    sockets[0]!.emitMessage(msg("a-lặp", 2)); // cùng `s` → trùng, bỏ
    sockets[0]!.emitMessage(msg("cũ", 1)); // `s` cũ → bỏ
    sockets[0]!.emitMessage(msg("c", 3));
    expect(onMessage.mock.calls.map((call) => call[0].id)).toEqual(["a", "c"]);
    expect(client.getSession()).toEqual({ sessionId: "s1", seq: 3 });

    // READY mới (session mới) đặt lại bộ đếm → `s` thấp vẫn phải nhận.
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s2", user: {} } });
    sockets[0]!.emitMessage(msg("sau-ready", 2));
    expect(onMessage.mock.calls.map((call) => call[0].id)).toEqual(["a", "c", "sau-ready"]);
  });

  it("heartbeat lệch ngẫu nhiên ở nhịp đầu rồi đều theo interval (jitter)", () => {
    const sockets: FakeWs[] = [];
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/",
      token: "t",
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0.5, // jitter = 0.5 × 1000ms = 500ms
    });
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ op: 10, d: { heartbeat_interval: 1_000 } });

    // Chưa tới mốc jitter → chưa gửi heartbeat nào.
    vi.advanceTimersByTime(499);
    expect(sockets[0]!.sent).toHaveLength(1); // chỉ có IDENTIFY
    vi.advanceTimersByTime(1);
    expect(parseSent(sockets[0]!, 1).op).toBe(1);

    // Ack rồi nhịp sau đúng chu kỳ, không cộng dồn jitter.
    sockets[0]!.emitMessage({ op: 11, d: null });
    vi.advanceTimersByTime(1_000);
    expect(parseSent(sockets[0]!, 2).op).toBe(1);
    expect(sockets[0]!.sent).toHaveLength(3);
  });

  it("đóng 4000 → gọi onAuthFailure, nối lại bằng token mới và resume session", async () => {
    const sockets: FakeWs[] = [];
    const onAuthFailure = vi.fn(async () => "token-mới");
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/",
      token: "token-cũ",
      getToken: () => "token-cũ",
      onAuthFailure,
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0,
    });
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s1", user: {} } });

    sockets[0]!.emitClose(4000);
    expect(onAuthFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emitOpen();
    const resume = parseSent(sockets[1]!, 0);
    expect(resume.op).toBe(6);
    expect(resume.d.token).toBe("token-mới");
    expect(resume.d.sessionId).toBe("s1");
  });

  it("đóng 4000 mà refresh thất bại → closed (đăng xuất mềm), không thử lại", async () => {
    const sockets: FakeWs[] = [];
    const onAuthFailure = vi.fn(async () => null);
    const client = new GatewayClient({
      url: "wss://gw.umaru.test/",
      token: "t",
      onAuthFailure,
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      random: () => 0,
    });
    client.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s1", user: {} } });

    sockets[0]!.emitClose(4000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onAuthFailure).toHaveBeenCalledOnce();
    expect(client.state).toBe("closed");
    expect(sockets).toHaveLength(1);
  });

  it("không có onAuthFailure thì 4000 → closed luôn (không đốt backoff)", () => {
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
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s1", user: {} } });
    sockets[0]!.emitClose(4000);
    expect(client.state).toBe("closed");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("updatePresence gửi op 3, và gửi lại sau khi nối lại (trạng thái không bị mất)", () => {
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
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s1", user: {} } });

    client.updatePresence("dnd");
    const sent = sockets[0]!.sent.map((raw) => JSON.parse(raw) as Record<string, any>);
    expect(sent.at(-1)).toMatchObject({ op: 3, d: { status: "dnd" } });

    // Mất kết nối rồi resume: server quên trạng thái khi socket đóng, client phải
    // gửi lại — nếu không người đang "Không làm phiền" lại hiện "Trực tuyến".
    sockets[0]!.emitClose(1006);
    vi.advanceTimersByTime(5_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emitOpen();
    sockets[1]!.emitMessage({ op: 0, t: "RESUMED", s: 2, d: {} });

    const resent = sockets[1]!.sent.map((raw) => JSON.parse(raw) as Record<string, any>);
    expect(resent.some((frame) => frame.op === 3 && frame.d.status === "dnd")).toBe(true);
  });

  it("chưa chọn trạng thái thì không gửi frame op 3 thừa sau READY", () => {
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
    sockets[0]!.emitMessage({ op: 0, t: "READY", s: 1, d: { sessionId: "s1", user: {} } });
    const frames = sockets[0]!.sent.map((raw) => JSON.parse(raw) as Record<string, any>);
    expect(frames.some((frame) => frame.op === 3)).toBe(false);
  });
});

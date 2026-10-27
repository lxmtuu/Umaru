import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayTestClient,
  createTestContext,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Rate limit gateway (spec §7): 120 frame/phút/socket → đóng `4004`;
 * HEARTBEAT dư 2 frame thì **bỏ qua và log**, không đóng; IDENTIFY/RESUME
 * 1 lần/5s/socket; quá 5 session/user thì session cũ nhất bị đóng `4003`.
 *
 * Lưu ý khi thêm test: `createTestContext` chạy `TRUNCATE` trên database test
 * dùng chung, nên mọi context phụ phải tạo **sau** khi đã dùng xong user của
 * context chính (user cũ sẽ bị xoá → token hợp lệ nhưng "Tài khoản không tồn tại").
 */

function gatewayUrl(ctx: TestContext): string {
  const address = ctx.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;
}

async function listen(ctx: TestContext): Promise<void> {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
}

async function waitForClose(client: GatewayTestClient, timeoutMs = 2_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && client.closeCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return client.closeCode;
}

describe("rate limit gateway", () => {
  let ctx: TestContext;
  let wsUrl: string;
  let alice: RegisteredUser;
  const clients: GatewayTestClient[] = [];

  beforeAll(async () => {
    ctx = await createTestContext({
      // 10 frame/phút để chạm trần nhanh; trần session thấp để kiểm 4003.
      RATE_LIMIT_GATEWAY_FRAMES_PER_MINUTE: "10",
      RATE_LIMIT_SESSIONS_PER_USER: "2",
    });
    await listen(ctx);
    wsUrl = gatewayUrl(ctx);
    alice = await registerUser(ctx, "rlgw_alice");
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await ctx.close();
  });

  async function connect(user: RegisteredUser, doIdentify = true): Promise<GatewayTestClient> {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    if (doIdentify) {
      client.send({ op: 2, d: { token: user.token } });
      await client.next((frame) => frame.op === 0 && frame.t === "READY");
    }
    return client;
  }

  it("quá số frame/phút → đóng 4004 (kể cả frame rác)", async () => {
    const client = await connect(alice); // IDENTIFY = frame 1/10
    // Tổng 10 frame vẫn trong trần; frame thứ 11 mới bị đóng.
    for (let index = 0; index < 9; index += 1) client.send({ op: 1 });
    expect(await waitForClose(client, 300)).toBeNull();
    client.send({ op: 1 });
    expect(await waitForClose(client)).toBe(4004);
  });

  it("HEARTBEAT dư: bỏ qua và log, KHÔNG đóng kết nối", async () => {
    // Interval test = 5s → 1 heartbeat + 2 dư = 3 được ack.
    const client = await connect(alice); // frame 1/10, trần frame còn dư 9
    for (let index = 0; index < 4; index += 1) client.send({ op: 1 });
    for (let index = 0; index < 3; index += 1) {
      const ack = await client.next((frame) => frame.op === 11);
      expect(ack.op).toBe(11);
    }
    // Cái thứ tư bị bỏ: không có ack, kết nối vẫn mở.
    const extraAck = await client.next((frame) => frame.op === 11, 300).catch(() => null);
    expect(extraAck).toBeNull();
    expect(client.closeCode).toBeNull();
  });

  it("RESUME hai lần trong 5 giây → đóng 4004", async () => {
    const client = await connect(alice, false);
    client.send({ op: 6, d: { token: alice.token, sessionId: "khong-ton-tai", seq: 0 } });
    // Session không tồn tại → INVALID_SESSION (d=false) nhưng **giữ** kết nối.
    await client.next((frame) => frame.op === 9);
    expect(client.closeCode).toBeNull();

    client.send({ op: 6, d: { token: alice.token, sessionId: "khong-ton-tai", seq: 0 } });
    expect(await waitForClose(client)).toBe(4004);
  });

  it("sau INVALID_SESSION vẫn IDENTIFY được ngay (không bị 4004 oan)", async () => {
    // Hồi quy: nếu gộp chung bộ đếm IDENTIFY/RESUME thì luồng hợp lệ này (SDK
    // resume xong identify lại ngay trên cùng kết nối) bị đóng 4004 oan.
    const client = await connect(alice, false);
    client.send({ op: 6, d: { token: alice.token, sessionId: "khong-ton-tai", seq: 0 } });
    await client.next((frame) => frame.op === 9);
    client.send({ op: 2, d: { token: alice.token } });
    const ready = await client.next((frame) => frame.op === 0 && frame.t === "READY");
    expect(ready.t).toBe("READY");
    expect(client.closeCode).toBeNull();
  });

  it("quá số session/user → session cũ nhất bị đóng 4003", async () => {
    const first = await connect(alice);
    const second = await connect(alice);
    expect(first.closeCode).toBeNull();
    expect(second.closeCode).toBeNull();

    // Session thứ ba (trần = 2) → session cũ nhất (`first`) bị đóng.
    const third = await connect(alice);
    expect(await waitForClose(first)).toBe(4003);
    // Session mới và session thứ hai vẫn sống.
    expect(third.closeCode).toBeNull();
    expect(second.closeCode).toBeNull();
  });

  it("tắt được bằng RATE_LIMITS=off (test/bench) — chạy cuối vì TRUNCATE", async () => {
    const offCtx = await createTestContext({ RATE_LIMITS: "off" });
    await listen(offCtx);
    const user = await registerUser(offCtx, "rlgw_off");
    const { client } = await GatewayTestClient.connect(gatewayUrl(offCtx));
    clients.push(client);
    client.send({ op: 2, d: { token: user.token } });
    await client.next((frame) => frame.op === 0 && frame.t === "READY");

    // 15 heartbeat > trần 3/interval ở context chính, nhưng context này tắt giới hạn.
    for (let index = 0; index < 15; index += 1) client.send({ op: 1 });
    for (let index = 0; index < 15; index += 1) {
      const ack = await client.next((frame) => frame.op === 11);
      expect(ack.op).toBe(11);
    }
    expect(client.closeCode).toBeNull();

    client.close();
    await offCtx.close();
  });
});

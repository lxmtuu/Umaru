import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayCompressionOptions } from "../src/gateway/compression.js";
import {
  GatewayTestClient,
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  sendMessage,
  type TestContext,
} from "./helpers.js";

/**
 * Nén frame gateway.
 *
 * Hai thứ đáng khoá: **đàm phán được** (server mở, client `ws`/trình duyệt tự
 * nhận) và **frame vẫn đọc được y nguyên** sau khi giải nén. Phần tiết kiệm byte
 * được đo bằng số byte TCP thật, không đoán.
 */

interface OpenContext {
  ctx: TestContext;
  url: string;
}

let current: TestContext | null = null;

async function openContext(env: NodeJS.ProcessEnv = {}): Promise<OpenContext> {
  const ctx = await createTestContext(env);
  current = ctx;
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = ctx.app.server.address() as AddressInfo;
  return { ctx, url: `ws://127.0.0.1:${port}/api/v1/gateway/ws` };
}

afterEach(async () => {
  await current?.close();
  current = null;
});

async function identify(url: string, token: string): Promise<GatewayTestClient> {
  const { client } = await GatewayTestClient.connect(url);
  client.send({ op: 2, d: { token } });
  await client.next((frame) => frame.op === 0 && frame.t === "READY");
  return client;
}

describe("gatewayCompressionOptions", () => {
  it("bật mặc định: có ngưỡng và không tái dùng từ điển giữa các message", () => {
    const options = gatewayCompressionOptions({
      gatewayCompress: true,
      gatewayCompressThreshold: 1024,
    });
    expect(options).not.toBe(false);
    if (options === false) return;
    expect(options.threshold).toBe(1024);
    // Chống rò rỉ kiểu BREACH: từ điển không được dùng lại giữa các message.
    expect(options.clientNoContextTakeover).toBe(true);
    expect(options.serverNoContextTakeover).toBe(true);
    expect(options.zlibDeflateOptions.level).toBe(6);
  });

  it("tắt thì trả `false` (ws hiểu là không đàm phán extension), không phải object rỗng", () => {
    expect(gatewayCompressionOptions({ gatewayCompress: false, gatewayCompressThreshold: 0 })).toBe(
      false,
    );
  });
});

describe("permessage-deflate qua gateway thật", () => {
  it("bật: client đàm phán được, READY vẫn đọc đúng", async () => {
    const { ctx, url } = await openContext();
    const user = await registerUser(ctx, "zip_on");
    const client = await identify(url, user.token);
    expect(client.raw.extensions).toBe("permessage-deflate");
    expect(client.lastSeq).toBeGreaterThan(0);
    client.close();
  });

  it("tắt (`GATEWAY_COMPRESS=off`): không đàm phán nén, gateway vẫn chạy", async () => {
    const { ctx, url } = await openContext({ GATEWAY_COMPRESS: "off" });
    const user = await registerUser(ctx, "zip_off");
    const client = await identify(url, user.token);
    expect(client.raw.extensions).toBe("");
    expect(client.lastSeq).toBeGreaterThan(0);
    client.close();
  });

  it("frame lớn: nội dung MESSAGE_CREATE nguyên vẹn sau khi giải nén", async () => {
    const { ctx, url } = await openContext();
    const user = await registerUser(ctx, "zip_payload");
    const guildId = await createGuild(ctx, user.token, "Nén");
    const channelId = (await listChannels(ctx, user.token, guildId))[0]!.id;
    const client = await identify(url, user.token);

    const content = "nội dung lặp để nén được ".repeat(40).slice(0, 1500);
    const message = await sendMessage(ctx, user.token, channelId, content);
    // `MESSAGE_CREATE` mang thẳng object `Message` (không bọc thêm khoá).
    const frame = await client.dispatch<{ id: string; content: string }>("MESSAGE_CREATE");
    expect(frame.id).toBe(message.id);
    expect(frame.content).toBe(content);
    client.close();
  });

  it("frame ≥ ngưỡng đi ít byte hơn hẳn khi bật nén", async () => {
    /** Gửi một tin ~1.5 KB rồi đo số byte TCP client nhận thêm. */
    async function measureBytes(compress: boolean): Promise<number> {
      const { ctx, url } = await openContext(compress ? {} : { GATEWAY_COMPRESS: "off" });
      const user = await registerUser(ctx, compress ? "zip_measure_on" : "zip_measure_off");
      const guildId = await createGuild(ctx, user.token, "Nén");
      const channelId = (await listChannels(ctx, user.token, guildId))[0]!.id;
      const client = await identify(url, user.token);

      const socket = (client.raw as unknown as { _socket: { bytesRead: number } })._socket;
      const before = socket.bytesRead;
      await sendMessage(ctx, user.token, channelId, "a".repeat(1500));
      await client.dispatch("MESSAGE_CREATE");
      const after = socket.bytesRead;
      client.close();
      await ctx.close();
      current = null;
      return after - before;
    }

    const plain = await measureBytes(false);
    const packed = await measureBytes(true);
    // JSON 1.5 KB toàn ký tự lặp: nén phải còn dưới một nửa. Dùng biên rộng để
    // test không đỏ vì chênh lệch vài byte header giữa hai lần chạy.
    expect(packed).toBeLessThan(plain * 0.6);
  });
});

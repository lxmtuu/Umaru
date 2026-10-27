import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayTestClient,
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Sticker qua gateway.
 *
 * Tin gửi đi phải tới **người khác** kèm nguyên khối `sticker` (id, tên,
 * `imageUrl`, kích thước). Nếu chỉ gắn sticker vào phản hồi REST thì người nhận
 * thấy tin trống cho tới lần F5 — đúng kiểu lỗi khó thấy khi test một mình.
 */

let ctx: TestContext;
let wsUrl: string;
let owner: RegisteredUser;
let member: RegisteredUser;
let channelId: string;
let stickerId: string;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  owner = await registerUser(ctx, "stkgw_owner");
  member = await registerUser(ctx, "stkgw_member");
  const guildId = await createGuild(ctx, owner.token, "Sticker GW");
  channelId = (await listChannels(ctx, owner.token, guildId))[0]!.id;
  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(owner.token),
    payload: { channelId },
  });
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
    headers: auth(member.token),
  });

  const pack = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/sticker-packs`,
    headers: auth(owner.token),
    payload: { name: "Gateway" },
  });
  const packId = pack.json<{ id: string }>().id;

  // PNG 32×32: header đủ để `readImageSize` đọc kích thước.
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x20, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const boundary = "----umaruGwBoundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nVẫy\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const sticker = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/sticker-packs/${packId}/stickers`,
    headers: {
      ...auth(owner.token),
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
    payload,
  });
  if (sticker.statusCode !== 201) throw new Error(`Tải sticker lỗi: ${sticker.body}`);
  stickerId = sticker.json<{ id: string }>().id;
});

afterAll(async () => {
  for (const client of clients) client.close();
  await ctx.close();
});

async function connect(user: RegisteredUser): Promise<GatewayTestClient> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: 2, d: { token: user.token } });
  await client.next((frame) => frame.op === 0 && frame.t === "READY");
  return client;
}

describe("MESSAGE_CREATE với sticker", () => {
  it("người khác nhận được tin kèm sticker đầy đủ", async () => {
    const client = await connect(member);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(owner.token),
      payload: { stickerId },
    });
    expect(sent.statusCode).toBe(201);

    const frame = await client.next(
      (candidate) => candidate.op === 0 && candidate.t === "MESSAGE_CREATE",
    );
    const message = (frame.d as {
      content: string;
      sticker?: { id: string; name: string; imageUrl: string; width: number } | null;
    });
    expect(message.content).toBe("");
    expect(message.sticker?.id).toBe(stickerId);
    expect(message.sticker?.name).toBe("Vẫy");
    expect(message.sticker?.width).toBe(32);
    // URL ảnh phải đúng dạng client tải được (có guildId + stickerId).
    expect(message.sticker?.imageUrl).toMatch(/^\/api\/v1\/guilds\/\d+\/stickers\/\d+\/image$/);
  });

  it("tin thường vẫn có sticker = null (không phải thiếu trường)", async () => {
    const client = await connect(member);
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(owner.token),
      payload: { content: "tin thường" },
    });
    const frame = await client.next(
      (candidate) => candidate.op === 0 && candidate.t === "MESSAGE_CREATE",
    );
    expect((frame.d as { sticker?: unknown }).sticker).toBeNull();
  });
});

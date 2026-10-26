import type { Message } from "@umaru/protocol";
import { GatewayOpcode } from "@umaru/protocol";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GatewayTestClient,
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/**
 * Embed liên kết, đầu-cuối: gửi tin có URL → server tải trang (HTTP server thật
 * trên loopback) → lưu → trả trong danh sách tin → phát `MESSAGE_UPDATE` cho
 * client đang mở kênh.
 *
 * Điều đáng kiểm nhất là **đường bất đồng bộ**: tin phải hiện ngay cả khi trang
 * bên ngoài chết, và embed tới sau bằng một sự kiện riêng.
 */

let ctx: TestContext;
let alice: RegisteredUser;
let guildId = "";
let channelId = "";
let wsUrl = "";
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/bai-viet") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><head>
        <meta property="og:title" content="Bài viết thử" />
        <meta property="og:description" content="Mô tả của bài viết" />
        <meta property="og:site_name" content="Umaru Blog" />
        <meta property="og:image" content="/cover.png" />
      </head></html>`);
      return;
    }
    if (url === "/bai-viet-2") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<meta property="og:title" content="Bài thứ hai">`);
      return;
    }
    // Trang không có thẻ meta nào → không được tạo embed rỗng.
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>trang trơn</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  wsUrl = `ws://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "embed_alice");
  guildId = await createGuild(ctx, alice.token, "Embed Server");
  channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
});

afterAll(async () => {
  await ctx.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function messages(): Promise<Message[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: auth(alice.token),
  });
  expect(response.statusCode).toBe(200);
  return response.json<Message[]>();
}

describe("Embed xem trước liên kết", () => {
  it("gửi tin có link → embed được lưu và trả về trong danh sách", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, `đọc bài này ${base}/bai-viet`);
    await ctx.embeds?.whenIdle();

    const found = (await messages()).find((message) => message.id === sent.id);
    expect(found?.embeds).toHaveLength(1);
    expect(found?.embeds?.[0]).toEqual({
      url: `${base}/bai-viet`,
      title: "Bài viết thử",
      description: "Mô tả của bài viết",
      siteName: "Umaru Blog",
      // Ảnh tương đối được ghép với URL trang.
      imageUrl: `${base}/cover.png`,
    });
  }, 20_000);

  it("client đang mở kênh nhận MESSAGE_UPDATE kèm embed", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    client.send({ op: GatewayOpcode.Identify, d: { token: alice.token } });
    await client.dispatch("READY");
    try {
      await sendMessage(ctx, alice.token, channelId, `link ${base}/bai-viet`);
      // `dispatch()` trả thẳng `d` của frame.
      const update = (await client.dispatch("MESSAGE_UPDATE")) as {
        content?: unknown;
        embeds?: Array<{ title: string | null }>;
      };
      expect(update.embeds).toEqual([expect.objectContaining({ title: "Bài viết thử" })]);
      // Sự kiện này không được mang nội dung: client giữ nguyên văn bản hiện có.
      expect(update.content).toBeUndefined();
    } finally {
      client.close();
    }
  }, 20_000);

  it("trang không có thẻ meta → không tạo embed", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, `xem ${base}/trang-tron`);
    await ctx.embeds?.whenIdle();
    const found = (await messages()).find((message) => message.id === sent.id);
    expect(found?.embeds ?? []).toEqual([]);
  }, 20_000);

  it("sửa tin đổi link → thẻ cũ bị xoá, thẻ mới thay vào", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, `xem ${base}/bai-viet`);
    await ctx.embeds?.whenIdle();

    const edit = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${sent.id}`,
      headers: auth(alice.token),
      payload: { content: `đổi sang ${base}/bai-viet-2` },
    });
    expect(edit.statusCode).toBe(200);
    await ctx.embeds?.whenIdle();

    const found = (await messages()).find((message) => message.id === sent.id);
    expect(found?.embeds?.map((embed) => embed.title)).toEqual(["Bài thứ hai"]);
  }, 20_000);

  it("sửa tin bỏ link → không còn embed", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, `xem ${base}/bai-viet`);
    await ctx.embeds?.whenIdle();

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${sent.id}`,
      headers: auth(alice.token),
      payload: { content: "bỏ link rồi" },
    });
    await ctx.embeds?.whenIdle();

    const found = (await messages()).find((message) => message.id === sent.id);
    expect(found?.embeds ?? []).toEqual([]);
  }, 20_000);

  it("không có URL → không xếp hàng tải gì", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, "chỉ là chữ");
    const found = (await messages()).find((message) => message.id === sent.id);
    expect(found?.embeds ?? []).toEqual([]);
  });
});

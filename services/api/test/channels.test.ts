import type { Channel } from "@umaru/protocol";
import { GatewayOpcode } from "@umaru/protocol";
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

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let generalId: string;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  guildId = await createGuild(ctx, alice.token);
  generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId: generalId },
  });
  const { code } = invite.json<{ code: string }>();
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(bob.token),
  });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await ctx.close();
});

async function createChannel(
  payload: Record<string, unknown>,
  token = alice.token,
): Promise<Channel> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: auth(token),
    payload,
  });
  if (response.statusCode !== 201) throw new Error(`Tạo kênh lỗi: ${response.body}`);
  return response.json();
}

async function patchChannel(
  channelId: string,
  payload: Record<string, unknown>,
  token = alice.token,
) {
  return ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/channels/${channelId}`,
    headers: auth(token),
    payload,
  });
}

/** Kênh thường cùng nhóm (cùng `parentId`), theo đúng thứ tự server trả về. */
async function siblings(parentId: string | null): Promise<Channel[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/guilds/${guildId}/channels`,
    headers: auth(alice.token),
  });
  if (response.statusCode !== 200) throw new Error(`List channel lỗi: ${response.body}`);
  const channels = response.json<Channel[]>();
  return channels.filter(
    (channel) => channel.type !== "category" && channel.categoryId === parentId,
  );
}

async function names(parentId: string | null): Promise<string[]> {
  return (await siblings(parentId)).map((channel) => channel.name ?? "");
}

async function connectAndIdentify(user: RegisteredUser): Promise<GatewayTestClient> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: GatewayOpcode.Identify, d: { token: user.token } });
  await client.dispatch("READY");
  return client;
}

describe("PATCH /channels/:id — thứ tự kênh (kéo-thả)", () => {
  let categoryA = "";
  let categoryB = "";
  let a1 = "";
  let a2 = "";
  let a3 = "";
  let b1 = "";
  let b2 = "";

  beforeAll(async () => {
    categoryA = (await createChannel({ name: "A", type: "category" })).id;
    a1 = (await createChannel({ name: "a1", type: "guild_text", parentId: categoryA })).id;
    a2 = (await createChannel({ name: "a2", type: "guild_text", parentId: categoryA })).id;
    a3 = (await createChannel({ name: "a3", type: "guild_text", parentId: categoryA })).id;
    categoryB = (await createChannel({ name: "B", type: "category" })).id;
    b1 = (await createChannel({ name: "b1", type: "guild_text", parentId: categoryB })).id;
    b2 = (await createChannel({ name: "b2", type: "guild_text", parentId: categoryB })).id;
    expect(await names(categoryA)).toEqual(["a1", "a2", "a3"]);
    expect(await names(categoryB)).toEqual(["b1", "b2"]);
  });

  it("đưa kênh lên đầu danh mục: renumber lại 0..n cho cả nhóm", async () => {
    const response = await patchChannel(a3, { position: 0 });
    expect(response.statusCode).toBe(200);
    expect(response.json<Channel>()).toMatchObject({ id: a3, position: 0, categoryId: categoryA });

    expect(await names(categoryA)).toEqual(["a3", "a1", "a2"]);
    expect((await siblings(categoryA)).map((channel) => channel.position)).toEqual([0, 1, 2]);
  });

  it("kéo sang category khác kèm chỉ số giữa nhóm", async () => {
    const response = await patchChannel(a1, { parentId: categoryB, position: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json<Channel>()).toMatchObject({ id: a1, categoryId: categoryB, position: 1 });

    expect(await names(categoryB)).toEqual(["b1", "a1", "b2"]);
    expect(await names(categoryA)).toEqual(["a3", "a2"]);
  });

  it("position vượt quá nhóm bị kẹp về cuối", async () => {
    const response = await patchChannel(a2, { position: 999 });
    expect(response.statusCode).toBe(200);
    expect(await names(categoryA)).toEqual(["a3", "a2"]);
  });

  it("thả vào nhóm gốc đổi thứ tự kênh không có category", async () => {
    const root2 = await createChannel({ name: "root-2", type: "guild_text" });
    expect(await names(null)).toEqual(["general", "root-2"]);

    const response = await patchChannel(root2.id, { position: 0 });
    expect(response.statusCode).toBe(200);
    expect(await names(null)).toEqual(["root-2", "general"]);
  });

  it("position không hợp lệ → 400", async () => {
    for (const position of [-1, 1.5, "1", Number.NaN]) {
      const response = await patchChannel(a2, { position });
      expect(response.statusCode, `position=${String(position)}`).toBe(400);
    }
    // Kênh vẫn ở nguyên vị trí cũ sau các lần 400.
    expect(await names(categoryA)).toEqual(["a3", "a2"]);
  });

  it("category không lồng vào category khác → 400", async () => {
    const response = await patchChannel(categoryA, { parentId: categoryB, position: 0 });
    expect(response.statusCode).toBe(400);
  });

  it("thành viên không có MANAGE_CHANNELS không đổi thứ tự được", async () => {
    const response = await patchChannel(a1, { position: 0 }, bob.token);
    expect(response.statusCode).toBe(403);
    expect(await names(categoryB)).toEqual(["b1", "a1", "b2"]);
  });

  it("kéo-thả phát CHANNEL_UPDATE cho từng kênh đổi vị trí", async () => {
    const client = await connectAndIdentify(alice);

    // [b1, a1, b2] → kéo b2 lên đầu: b2=0, b1=1, a1=2 (cả ba đều đổi).
    const response = await patchChannel(b2, { position: 0 });
    expect(response.statusCode).toBe(200);

    const events: Array<{ id: string; position: number }> = [];
    for (let index = 0; index < 3; index += 1) {
      events.push(await client.dispatch("CHANNEL_UPDATE"));
    }
    expect(events.map((event) => event.id)).toEqual([b2, b1, a1]);
    expect(events.map((event) => event.position)).toEqual([0, 1, 2]);
    expect(await names(categoryB)).toEqual(["b2", "b1", "a1"]);
  });
});

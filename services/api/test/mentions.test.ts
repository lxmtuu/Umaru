import { Permission } from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let carol: RegisteredUser;
let guildId: string;
let generalId: string;

interface MentionEntry {
  message: { id: string; content: string; channelId: string };
  channel: { id: string; name: string | null; type: string };
  guildName: string | null;
  author: { userId: string; username: string };
  recipient: { userId: string } | null;
}

async function mentions(user: RegisteredUser, query = ""): Promise<MentionEntry[]> {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/users/@me/mentions${query}`,
    headers: auth(user.token),
  });
  expect(res.statusCode).toBe(200);
  return res.json<MentionEntry[]>();
}

async function createInviteCode(channelId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  return res.json<{ code: string }>().code;
}

async function join(user: RegisteredUser): Promise<void> {
  const code = await createInviteCode(generalId);
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(user.token),
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  carol = await registerUser(ctx, "carol");

  guildId = await createGuild(ctx, alice.token);
  generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
  await join(bob);
  await join(carol);
});

afterAll(async () => {
  await ctx.close();
});

describe("GET /users/@me/mentions", () => {
  it("trả tin mới nhất trước, kèm kênh và tên người gửi", async () => {
    const first = await sendMessage(ctx, alice.token, generalId, "@bob xemPR #1");
    const second = await sendMessage(ctx, alice.token, generalId, "@bob xem PR #2");

    const rows = await mentions(bob);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.message.id).toBe(second.id);
    expect(rows[1]?.message.id).toBe(first.id);
    expect(rows[0]?.channel.name).toBe("general");
    expect(rows[0]?.guildName).toBe("Umaru Dev");
    expect(rows[0]?.author.username).toBe("alice");
    expect(rows[0]?.recipient).toBeNull();
  });

  it("chỉ trả mention của mình, không lộ mention của người khác", async () => {
    await sendMessage(ctx, alice.token, generalId, "@carol chỉ carol thấy");
    const forBob = await mentions(bob);
    expect(forBob.every((row) => row.message.content.includes("@bob"))).toBe(true);
    expect(await mentions(carol)).toHaveLength(1);
  });

  it("không trả tin đã sửa còn @ người khác (mention cập nhật lại)", async () => {
    const target = await sendMessage(ctx, alice.token, generalId, "@carol sẽ bị đổi tag");
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${target.id}`,
      headers: auth(alice.token),
      payload: { content: "@bob đã bị đổi tag" },
    });

    expect((await mentions(carol)).some((row) => row.message.id === target.id)).toBe(false);
    expect((await mentions(bob)).some((row) => row.message.id === target.id)).toBe(true);
  });

  it("trả DM kèm recipient; tin của chính mình không vào", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(bob.token),
      payload: { recipientId: carol.id },
    });
    const dmChannelId = dm.json<{ channel: { id: string } }>().channel.id;
    await sendMessage(ctx, bob.token, dmChannelId, "@carol đây là DM");

    const rows = await mentions(carol);
    const inDm = rows.find((row) => row.message.channelId === dmChannelId);
    expect(inDm).toBeDefined();
    expect(inDm?.channel.type).toBe("dm");
    expect(inDm?.channel.name).toBeNull();
    expect(inDm?.guildName).toBeNull();
    expect(inDm?.recipient?.userId).toBe(bob.id);

    // bob tự gửi → không có trong mention của chính mình
    expect((await mentions(bob)).some((row) => row.message.channelId === dmChannelId)).toBe(false);
  });

  it("phân trang theo before; tin cũ hơn cursor bị loại", async () => {
    for (let index = 1; index <= 3; index += 1) {
      await sendMessage(ctx, alice.token, generalId, `@bob trang ${index}`);
    }
    const page = await mentions(bob);
    expect(page.length).toBeGreaterThan(3);

    const firstPage = await mentions(bob, "?limit=1");
    expect(firstPage).toHaveLength(1);
    const cursor = firstPage[0]!.message.id;
    const secondPage = await mentions(bob, `?limit=5&before=${cursor}`);
    expect(secondPage.every((row) => BigInt(row.message.id) < BigInt(cursor))).toBe(true);
    expect(secondPage.some((row) => row.message.id === cursor)).toBe(false);
  });

  it("lọc theo kênh user thật sự được xem: kênh ẩn bằng overwrite biến mất", async () => {
    // Tạo kênh phụ rồi ghi trực tiếp overwrite deny VIEW_CHANNEL cho @everyone
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "bi-an", type: "guild_text" },
    });
    const secretId = created.json<{ id: string }>().id;
    await sendMessage(ctx, alice.token, secretId, "@bob kênh này sẽ ẩn");
    expect((await mentions(bob)).filter((row) => row.channel.id === secretId)).toHaveLength(1);

    const everyone = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM roles WHERE guild_id = $1 AND is_everyone = true",
      [guildId],
    );
    const everyoneRoleId = everyone.rows[0]!.id;
    await ctx.pool.query(
      `INSERT INTO permission_overwrites (channel_id, target_type, target_id, allow, deny)
       VALUES ($1, 'role', $2, '0', $3)`,
      [secretId, everyoneRoleId, Permission.VIEW_CHANNEL.toString()],
    );

    // bob mất quyền → dòng mention biến mất hoàn toàn
    expect((await mentions(bob)).filter((row) => row.channel.id === secretId)).toHaveLength(0);
    // và REST cũng 404 nhất quán
    const bobReads = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${secretId}/messages`,
      headers: auth(bob.token),
    });
    expect(bobReads.statusCode).toBe(404);
  });
});

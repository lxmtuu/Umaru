import { Permission, serializePermissions } from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toLikePattern } from "../src/search/routes.js";
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

interface Hit {
  message: { id: string; content: string; attachments: unknown[] };
  channel: { id: string; name: string | null };
  guildName: string | null;
  author: { displayName: string; username: string };
  recipient: { username: string } | null;
}

function search(
  ctx: TestContext,
  token: string,
  scope: { guildId: string } | { channelId: string },
  query: string,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams({ q: query, ...extra });
  const path =
    "guildId" in scope
      ? `/api/v1/guilds/${scope.guildId}/messages/search`
      : `/api/v1/channels/${scope.channelId}/messages/search`;
  return ctx.app.inject({ method: "GET", url: `${path}?${params.toString()}`, headers: auth(token) });
}

describe("tìm kiếm tin nhắn", () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  let guildId: string;
  let generalId: string;
  let secretId: string;
  let everyoneRoleId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await registerUser(ctx, "search_alice");
    bob = await registerUser(ctx, "search_bob");
    guildId = await createGuild(ctx, alice.token, "Search Server");
    generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
    const roles = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/roles`,
      headers: auth(alice.token),
    });
    everyoneRoleId = roles.json<{ id: string; isEveryone: boolean }[]>().find(
      (role) => role.isEveryone,
    )!.id;

    // Kênh riêng: chỉ alice (owner) xem được → bob không được thấy kết quả trong đó.
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/channels`,
      headers: auth(alice.token),
      payload: { name: "bi-mat", type: "guild_text" },
    });
    expect(created.statusCode).toBe(201);
    secretId = created.json<{ id: string }>().id;

    // Chặn @everyone xem kênh này (deny VIEW_CHANNEL).
    const overwrite = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/channels/${secretId}/overwrites/role/${everyoneRoleId}`,
      headers: auth(alice.token),
      payload: { allow: "0", deny: serializePermissions(Permission.VIEW_CHANNEL) },
    });
    expect(overwrite.statusCode).toBe(200);

    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId: generalId },
    });
    const code = invite.json<{ code: string }>().code;
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });

    await sendMessage(ctx, alice.token, generalId, "Chào mừng tới Umaru workspace");
    await sendMessage(ctx, alice.token, generalId, "Hôm nay học về permission overwrite");
    await sendMessage(ctx, bob.token, generalId, "Mình đang đọc umaru docs, có gì hot?");
    await sendMessage(ctx, alice.token, generalId, "Tỉ lệ hoàn thành 100% và snake_case_here");
    await sendMessage(ctx, alice.token, secretId, "bí mật: umaru nội bộ");
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("tìm trong một kênh, không phân biệt hoa/thường", async () => {
    const response = await search(ctx, alice.token, { channelId: generalId }, "UMARU");
    expect(response.statusCode).toBe(200);
    const hits = response.json<Hit[]>();
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((hit) => hit.channel.id === generalId)).toBe(true);
    expect(hits.every((hit) => hit.message.content.toLowerCase().includes("umaru"))).toBe(true);
  });

  it("mới nhất trước, kèm kênh + người gửi + tên server", async () => {
    const response = await search(ctx, alice.token, { guildId }, "umaru");
    const hits = response.json<Hit[]>();
    const ids = hits.map((hit) => BigInt(hit.message.id));
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
    expect(hits[0]?.guildName).toBe("Search Server");
    expect(hits[0]?.author.username).toMatch(/search_/);
    expect(hits[0]?.channel.name).toBeTruthy();
  });

  it("toàn server: chỉ trả kênh user được xem (kênh ẩn bị lọc TRONG SQL)", async () => {
    const asBob = await search(ctx, bob.token, { guildId }, "umaru");
    expect(asBob.statusCode).toBe(200);
    const bobHits = asBob.json<Hit[]>();
    expect(bobHits.length).toBeGreaterThan(0);
    expect(bobHits.some((hit) => hit.channel.id === secretId)).toBe(false);

    // Chính chủ (owner) thấy tin trong kênh riêng.
    const asAlice = await search(ctx, alice.token, { guildId }, "nội bộ");
    expect(asAlice.json<Hit[]>().some((hit) => hit.channel.id === secretId)).toBe(true);
  });

  it("kênh không xem được → 404 (không lộ sự tồn tại)", async () => {
    const response = await search(ctx, bob.token, { channelId: secretId }, "umaru");
    expect(response.statusCode).toBe(404);
  });

  it("người ngoài server → 404", async () => {
    const outsider = await registerUser(ctx, "search_outsider");
    const response = await search(ctx, outsider.token, { guildId }, "umaru");
    expect(response.statusCode).toBe(404);
  });

  it("q ngắn hơn 2 ký tự hoặc thiếu → 400", async () => {
    for (const query of ["", " a ", "a"]) {
      const response = await search(ctx, alice.token, { guildId }, query);
      expect(response.statusCode).toBe(400);
    }
    const missing = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/messages/search`,
      headers: auth(alice.token),
    });
    expect(missing.statusCode).toBe(400);
  });

  it("ký tự đại diện của LIKE không được dùng làm wildcard", async () => {
    // "100%" chỉ khớp đúng chuỗi có "100%", không khớp mọi tin.
    const percent = await search(ctx, alice.token, { channelId: generalId }, "100%");
    expect(percent.json<Hit[]>().map((hit) => hit.message.content)).toEqual([
      "Tỉ lệ hoàn thành 100% và snake_case_here",
    ]);

    // "_" cũng là ký tự thường.
    const underscore = await search(ctx, alice.token, { channelId: generalId }, "snake_case");
    expect(underscore.json<Hit[]>().length).toBe(1);

    const anyChar = await search(ctx, alice.token, { channelId: generalId }, "snake_case_here");
    expect(anyChar.json<Hit[]>().length).toBe(1);
  });

  it("phân trang bằng cursor before", async () => {
    const first = await search(ctx, alice.token, { guildId }, "umaru", { limit: "1" });
    const firstHits = first.json<Hit[]>();
    expect(firstHits).toHaveLength(1);

    const next = await search(ctx, alice.token, { guildId }, "umaru", {
      limit: "1",
      before: firstHits[0]!.message.id,
    });
    const nextHits = next.json<Hit[]>();
    expect(nextHits).toHaveLength(1);
    expect(BigInt(nextHits[0]!.message.id) < BigInt(firstHits[0]!.message.id)).toBe(true);
  });

  it("before không hợp lệ → 400; limit ngoài khoảng → 400", async () => {
    expect(
      (await search(ctx, alice.token, { guildId }, "umaru", { before: "abc" })).statusCode,
    ).toBe(400);
    expect(
      (await search(ctx, alice.token, { guildId }, "umaru", { limit: "0" })).statusCode,
    ).toBe(400);
    expect(
      (await search(ctx, alice.token, { guildId }, "umaru", { limit: "51" })).statusCode,
    ).toBe(400);
  });

  it("tìm trong DM của mình và trả kèm người ở đầu bên kia", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    expect(dm.statusCode).toBeLessThan(300);
    // Trả về DmChannelSummary: { channel, recipient }.
    const dmId = dm.json<{ channel: { id: string } }>().channel.id;
    await sendMessage(ctx, alice.token, dmId, "tin nhắn riêng về umaru");

    const response = await search(ctx, alice.token, { channelId: dmId }, "umaru");
    expect(response.statusCode).toBe(200);
    const hits = response.json<Hit[]>();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.recipient?.username).toBe("search_bob");
    expect(hits[0]?.guildName).toBeNull();
  });

  it("không có kết quả → mảng rỗng (không 404)", async () => {
    const response = await search(ctx, alice.token, { guildId }, "khong-bao-gio-khop-xyz");
    expect(response.statusCode).toBe(200);
    expect(response.json<Hit[]>()).toEqual([]);
  });
});

describe("toLikePattern", () => {
  it("escape % _ và backslash", () => {
    expect(toLikePattern("100%")).toBe("%100\\%%");
    expect(toLikePattern("snake_case")).toBe("%snake\\_case%");
    expect(toLikePattern("a\\b")).toBe("%a\\\\b%");
    expect(toLikePattern("umaru")).toBe("%umaru%");
  });
});

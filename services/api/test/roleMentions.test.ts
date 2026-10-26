import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRoleMentions } from "../src/mentions.js";
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

/**
 * Nhắc **role** (`@Tên role`).
 *
 * Phần dễ hỏng không phải "có ghi nhận" mà là:
 *  - nhắc đúng **người trong role**, không phải cả server;
 *  - `@everyone` chỉ người có `MANAGE_MESSAGES` mới ping được (nếu không, ai cũng
 *    đánh thức được 5 000 người bằng hai chữ);
 *  - tên role dài thắng tên ngắn (`@Đội QA` không kích hoạt role `@QA`);
 *  - sửa tin thì danh sách nhắc được **ghi lại**, không cộng dồn.
 */

let ctx: TestContext;
let alice: RegisteredUser;
let bob: RegisteredUser;
let carol: RegisteredUser;
let dave: RegisteredUser;
let guildId = "";
let channelId = "";
let qaRoleId = "";
let daiQaRoleId = "";

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await registerUser(ctx, "role_alice");
  bob = await registerUser(ctx, "role_bob");
  carol = await registerUser(ctx, "role_carol");
  dave = await registerUser(ctx, "role_dave");
  guildId = await createGuild(ctx, alice.token, "Role Server");
  channelId = (await listChannels(ctx, alice.token, guildId)).find(
    (channel) => channel.type === "guild_text",
  )!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  const code = invite.json<{ code: string }>().code;
  for (const member of [bob, carol, dave]) {
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(member.token),
    });
  }

  async function createRole(name: string): Promise<string> {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/roles`,
      headers: auth(alice.token),
      payload: { name, color: 0x5865f2, permissions: "0" },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }
  async function assign(roleId: string, user: RegisteredUser) {
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/guilds/${guildId}/members/${user.id}/roles/${roleId}`,
      headers: auth(alice.token),
    });
    // Endpoint gán role trả 204 (không có body).
    expect(response.statusCode).toBe(204);
  }

  qaRoleId = await createRole("QA");
  daiQaRoleId = await createRole("Đội QA");
  await assign(qaRoleId, bob);
  await assign(daiQaRoleId, carol);
});

afterAll(async () => {
  await ctx.close();
});

/** Các tin mà `user` thấy trong hộp thư nhắc tới mình. */
async function mentionsOf(user: RegisteredUser): Promise<string[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/users/@me/mentions",
    headers: auth(user.token),
  });
  expect(response.statusCode).toBe(200);
  return response.json<Array<{ message: { id: string } }>>().map((entry) => entry.message.id);
}

describe("extractRoleMentions — khớp tên role", () => {
  const roles = [
    { id: "1", name: "QA", isEveryone: false },
    { id: "2", name: "Đội QA", isEveryone: false },
    { id: "3", name: "@everyone", isEveryone: true },
  ];

  it("khớp tên có dấu và khoảng trắng, dài trước ngắn", () => {
    const hits = extractRoleMentions("nhờ @Đội QA xem giúp", roles);
    expect(hits.map((role) => role.id)).toEqual(["2"]);
  });

  it("không cắt giữa từ: `@QAs` không khớp role `@QA`", () => {
    expect(extractRoleMentions("@QAs ơi", roles)).toEqual([]);
    expect(extractRoleMentions("@QA ơi", roles).map((role) => role.id)).toEqual(["1"]);
  });

  it("@everyone nhận được (chặn ở tầng quyền, không phải tầng khớp)", () => {
    expect(extractRoleMentions("@everyone họp nhé", roles).map((role) => role.id)).toEqual(["3"]);
  });

  it("`a@QA` là email/dính chữ, không phải nhắc", () => {
    expect(extractRoleMentions("mail a@QA nhé", roles)).toEqual([]);
  });
});

describe("nhắc role trong tin nhắn", () => {
  it("người trong role nhận được, người ngoài role thì không", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, "@QA ơi kiểm tra giúp");
    expect(await mentionsOf(bob)).toContain(sent.id);
    expect(await mentionsOf(carol)).not.toContain(sent.id);
    expect(await mentionsOf(dave)).not.toContain(sent.id);
    // Người gửi (Alice, cũng không có role QA) không tự nhận.
    expect(await mentionsOf(alice)).not.toContain(sent.id);
  });

  it("tên dài thắng tên ngắn: `@Đội QA` chỉ ping người của role đó", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, "@Đội QA họp lúc 3h");
    expect(await mentionsOf(carol)).toContain(sent.id);
    expect(await mentionsOf(bob)).not.toContain(sent.id);
  });

  it("@everyone: thành viên thường không ping được", async () => {
    const sent = await sendMessage(ctx, bob.token, channelId, "@everyone vào họp");
    expect(await mentionsOf(carol)).not.toContain(sent.id);
    expect(await mentionsOf(dave)).not.toContain(sent.id);
  });

  it("@everyone: người có MANAGE_MESSAGES ping được cả server", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, "@everyone họp toàn server");
    expect(await mentionsOf(bob)).toContain(sent.id);
    expect(await mentionsOf(carol)).toContain(sent.id);
    expect(await mentionsOf(dave)).toContain(sent.id);
  });

  it("sửa tin thì danh sách nhắc được ghi lại (bỏ role cũ, thêm role mới)", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, "@QA xem nhé");
    expect(await mentionsOf(bob)).toContain(sent.id);

    const edited = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/messages/${sent.id}`,
      headers: auth(alice.token),
      payload: { content: "@Đội QA xem nhé" },
    });
    expect(edited.statusCode).toBe(200);
    expect(await mentionsOf(bob)).not.toContain(sent.id);
    expect(await mentionsOf(carol)).toContain(sent.id);
  });

  it("không nhắc ai thì không ghi dòng nào", async () => {
    const sent = await sendMessage(ctx, alice.token, channelId, "không nhắc ai cả");
    for (const user of [bob, carol, dave]) {
      expect(await mentionsOf(user)).not.toContain(sent.id);
    }
  });
});

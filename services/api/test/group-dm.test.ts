import { MAX_GROUP_DM_MEMBERS } from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  createTestContext,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

interface SummaryBody {
  channel: { id: string; type: string; guildId: string | null; name: string | null };
  recipient: { userId: string; displayName: string } | null;
  recipients: { userId: string; displayName: string }[];
  ownerId: string | null;
  name: string | null;
}

describe("group DM", () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  let carol: RegisteredUser;
  let dave: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await registerUser(ctx, "grp_alice");
    bob = await registerUser(ctx, "grp_bob");
    carol = await registerUser(ctx, "grp_carol");
    dave = await registerUser(ctx, "grp_dave");
  });

  afterAll(async () => {
    await ctx.close();
  });

  const createGroup = (token: string, recipientIds: string[], name?: string) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(token),
      payload: name === undefined ? { recipientIds } : { recipientIds, name },
    });

  const listChannels = async (token: string): Promise<SummaryBody[]> => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/channels",
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json<SummaryBody[]>();
  };

  const addMember = (token: string, channelId: string, userId: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/recipients`,
      headers: auth(token),
      payload: { userId },
    });

  const removeMember = (token: string, channelId: string, userId: string) =>
    ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${channelId}/recipients/${userId}`,
      headers: auth(token),
    });

  it("tạo nhóm 3 người: type group_dm, ownerId là người tạo, chưa có tên", async () => {
    const response = await createGroup(alice.token, [bob.id, carol.id]);
    expect(response.statusCode).toBe(201);
    const summary = response.json<SummaryBody>();

    expect(summary.channel.type).toBe("group_dm");
    expect(summary.channel.guildId).toBeNull();
    expect(summary.ownerId).toBe(alice.id);
    expect(summary.name).toBeNull();
    // Góc nhìn của người tạo: hai người còn lại, không có chính mình.
    expect(summary.recipients.map((entry) => entry.userId).sort()).toEqual(
      [bob.id, carol.id].sort(),
    );
    // Group DM không có `recipient` đơn (khác DM 1-1).
    expect(summary.recipient).toBeNull();
  });

  it("mỗi thành viên thấy nhóm với recipients loại trừ chính mình", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;

    const forBob = (await listChannels(bob.token)).find(
      (dm) => dm.channel.id === channelId,
    );
    expect(forBob?.recipients.map((entry) => entry.userId).sort()).toEqual(
      [alice.id, carol.id].sort(),
    );
    expect(forBob?.ownerId).toBe(alice.id);
  });

  it("DM 1-1 cũ vẫn trả recipient + recipients có đúng 1 người", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: dave.id },
    });
    expect(response.statusCode).toBe(201);
    const summary = response.json<SummaryBody>();
    expect(summary.channel.type).toBe("dm");
    expect(summary.recipient?.userId).toBe(dave.id);
    expect(summary.recipients.map((entry) => entry.userId)).toEqual([dave.id]);
    expect(summary.ownerId).toBeNull();
  });

  it("tạo nhóm kèm tên ngay từ đầu", async () => {
    const response = await createGroup(alice.token, [bob.id, carol.id], "Nhóm dự án");
    expect(response.statusCode).toBe(201);
    const summary = response.json<SummaryBody>();
    expect(summary.name).toBe("Nhóm dự án");
    // `channels.name` và `group_dms.name` phải khớp nhau.
    expect(summary.channel.name).toBe("Nhóm dự án");
    const listed = (await listChannels(bob.token)).find(
      (dm) => dm.channel.id === summary.channel.id,
    );
    expect(listed?.name).toBe("Nhóm dự án");
  });

  it("cần ít nhất 2 người khác; 1 người thì dùng recipientId", async () => {
    const response = await createGroup(alice.token, [bob.id]);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("2 người");
  });

  it("tối đa 10 người trong nhóm", async () => {
    const extras: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      extras.push((await registerUser(ctx, `grp_bulk_${index}`)).id);
    }
    // 9 người khác + mình = 10 → hợp lệ.
    expect((await createGroup(alice.token, extras.slice(0, 9))).statusCode).toBe(201);
    // 10 người khác + mình = 11 → quá trần.
    const tooMany = await createGroup(alice.token, [...extras.slice(0, 8), dave.id, bob.id]);
    expect(tooMany.statusCode).toBeGreaterThanOrEqual(400);
    expect(MAX_GROUP_DM_MEMBERS).toBe(10);
  });

  it("id trùng được gộp, không tự thêm mình, người lạ → 404", async () => {
    const duplicated = await createGroup(alice.token, [bob.id, bob.id, carol.id]);
    expect(duplicated.statusCode).toBe(201);
    expect(duplicated.json<SummaryBody>().recipients).toHaveLength(2);

    const self = await createGroup(alice.token, [bob.id, alice.id, carol.id]);
    expect(self.statusCode).toBe(400);

    const ghost = await createGroup(alice.token, [bob.id, "999999999999999999", carol.id]);
    expect(ghost.statusCode).toBe(404);
  });

  it("mọi thành viên đều mời được người mới; người mới thấy nhóm ngay", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;

    const added = await addMember(bob.token, channelId, dave.id);
    expect(added.statusCode).toBe(201);

    const forDave = (await listChannels(dave.token)).find((dm) => dm.channel.id === channelId);
    expect(forDave?.recipients.map((entry) => entry.userId).sort()).toEqual(
      [alice.id, bob.id, carol.id].sort(),
    );
    // Thêm lại người đã ở trong nhóm → 201, không nhân đôi.
    const again = await addMember(bob.token, channelId, dave.id);
    expect(again.statusCode).toBe(201);
    const after = (await listChannels(dave.token)).find((dm) => dm.channel.id === channelId);
    expect(after?.recipients).toHaveLength(3);
  });

  it("nhóm đủ 10 người thì không thêm được nữa (400)", async () => {
    const members: RegisteredUser[] = [];
    for (let index = 0; index < 9; index += 1) {
      members.push(await registerUser(ctx, `grp_full_${index}`));
    }
    const created = (
      await createGroup(
        alice.token,
        members.map((member) => member.id),
      )
    ).json<SummaryBody>();
    const outsider = await registerUser(ctx, "grp_full_extra");

    const response = await addMember(alice.token, created.channel.id, outsider.id);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain(String(MAX_GROUP_DM_MEMBERS));
  });

  it("không thêm được người đang chặn mình (403)", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const blocked = await registerUser(ctx, "grp_blocked");
    const block = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${blocked.id}`,
      headers: auth(alice.token),
    });
    expect(block.statusCode).toBeLessThan(300);

    expect((await addMember(alice.token, created.channel.id, blocked.id)).statusCode).toBe(403);
  });

  it("tự rời nhóm: 204, biến khỏi danh sách của mình nhưng nhóm còn với người khác", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;

    const left = await removeMember(carol.token, channelId, "@me");
    expect(left.statusCode).toBe(204);

    expect((await listChannels(carol.token)).some((dm) => dm.channel.id === channelId)).toBe(
      false,
    );
    const forAlice = (await listChannels(alice.token)).find(
      (dm) => dm.channel.id === channelId,
    );
    expect(forAlice?.recipients.map((entry) => entry.userId).sort()).toEqual(
      [bob.id].sort(),
    );
  });

  it("chủ nhóm mời người khác ra; người thường thì 403", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id, dave.id])).json<SummaryBody>();
    const channelId = created.channel.id;

    expect((await removeMember(bob.token, channelId, carol.id)).statusCode).toBe(403);
    expect((await removeMember(alice.token, channelId, carol.id)).statusCode).toBe(204);

    const forDave = (await listChannels(dave.token)).find((dm) => dm.channel.id === channelId);
    expect(forDave?.recipients.map((entry) => entry.userId).sort()).toEqual(
      [alice.id, bob.id].sort(),
    );
  });

  it("đổi tên nhóm: mọi thành viên, tối đa 100 ký tự, rỗng = bỏ tên", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;

    const renamed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${channelId}`,
      headers: auth(bob.token),
      payload: { name: "  Nhóm dự án  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<SummaryBody>().name).toBe("Nhóm dự án");
    expect(renamed.json<SummaryBody>().channel.name).toBe("Nhóm dự án");

    const tooLong = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${channelId}`,
      headers: auth(bob.token),
      payload: { name: "x".repeat(101) },
    });
    expect(tooLong.statusCode).toBe(400);

    const cleared = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${channelId}`,
      headers: auth(bob.token),
      payload: { name: "" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<SummaryBody>().name).toBeNull();
  });

  it("gửi tin trong nhóm: mọi thành viên đọc được; người ngoài → 404", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;

    await sendMessage(ctx, bob.token, channelId, "chào cả nhóm");
    const read = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(carol.token),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ content: string }[]>()[0]?.content).toBe("chào cả nhóm");

    const outsider = await registerUser(ctx, "grp_outsider");
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(outsider.token),
    });
    expect(denied.statusCode).toBe(404);
    // Người ngoài cũng không mời/đá được ai.
    expect((await addMember(outsider.token, channelId, dave.id)).statusCode).toBe(404);
    expect((await removeMember(outsider.token, channelId, "@me")).statusCode).toBe(404);
  });

  it("người cuối cùng còn lại vẫn thấy nhóm trong danh sách và rời được", async () => {
    // Hồi quy: `loadDms` từng INNER JOIN người bên kia nên khi mọi người khác đã
    // rời, nhóm biến mất khỏi sidebar của người cuối cùng → họ không rời nốt được
    // và kênh thành rác vĩnh viễn trong DB.
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;
    for (const member of [bob, carol]) {
      expect((await removeMember(member.token, channelId, "@me")).statusCode).toBe(204);
    }

    const listed = await listChannels(alice.token);
    const alone = listed.find((dm) => dm.channel.id === channelId);
    expect(alone).toBeDefined();
    expect(alone?.recipients).toEqual([]);
    expect(alone?.ownerId).toBe(alice.id);

    expect((await removeMember(alice.token, channelId, "@me")).statusCode).toBe(204);
    const channels = await ctx.pool.query("SELECT 1 FROM channels WHERE id = $1", [channelId]);
    expect(channels.rowCount).toBe(0);
    // Bảng group_dms xoá theo FK — không để lại dòng mồ côi.
    const groups = await ctx.pool.query("SELECT 1 FROM group_dms WHERE channel_id = $1", [channelId]);
    expect(groups.rowCount).toBe(0);
  });

  it("người cuối cùng rời nhóm → kênh bị xoá (kèm tin nhắn)", async () => {
    const created = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();
    const channelId = created.channel.id;
    const message = await sendMessage(ctx, alice.token, channelId, "tin sẽ bị xoá cùng nhóm");

    for (const member of [alice, bob, carol]) {
      expect((await removeMember(member.token, channelId, "@me")).statusCode).toBe(204);
    }

    // Không còn ai là thành viên: kênh và tin nhắn đã bị xoá khỏi DB.
    const channels = await ctx.pool.query("SELECT 1 FROM channels WHERE id = $1", [channelId]);
    expect(channels.rowCount).toBe(0);
    const messages = await ctx.pool.query("SELECT 1 FROM messages WHERE id = $1", [message.id]);
    expect(messages.rowCount).toBe(0);
  });

  it("DM 1-1 vẫn ẩn khi bị chặn (kể cả sau khi đổi sang LEFT JOIN), group DM thì không", async () => {
    const dm = (await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    })).json<SummaryBody>();
    const group = (await createGroup(alice.token, [bob.id, carol.id])).json<SummaryBody>();

    // Chặn một chiều là đủ để cả hai bên không thấy cuộc trò chuyện 1-1.
    expect((await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/users/@me/blocks/${bob.id}`,
      headers: auth(alice.token),
    })).statusCode).toBe(204);

    for (const who of [alice, bob]) {
      const listed = await listChannels(who.token);
      expect(listed.some((item) => item.channel.id === dm.channel.id)).toBe(false);
      // Nhưng nhóm chung vẫn còn — chặn là chuyện giữa hai người.
      expect(listed.some((item) => item.channel.id === group.channel.id)).toBe(true);
    }

    // Dọn: bỏ chặn để các test sau (tạo DM với bob) không bị 403.
    expect((await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/users/@me/blocks/${bob.id}`,
      headers: auth(alice.token),
    })).statusCode).toBe(204);
  });

  it("không đổi tên được DM 1-1 (chỉ group DM mới có tên)", async () => {
    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const channelId = dm.json<SummaryBody>().channel.id;
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${channelId}`,
      headers: auth(alice.token),
      payload: { name: "không được" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("chưa đăng nhập → 401", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      payload: { recipientIds: ["1", "2"] },
    });
    expect(response.statusCode).toBe(401);
  });
});

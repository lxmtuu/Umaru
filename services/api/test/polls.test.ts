import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
 * Bình chọn trong tin nhắn (poll).
 *
 * Những chỗ dễ hỏng mà test này canh:
 *  - poll "chọn một" mà người dùng có **hai** phiếu (thay phiếu phải nguyên tử);
 *  - `totalVotes` cộng dồn số phiếu thay vì số **người** khi cho chọn nhiều;
 *  - `me` tính theo người xem — hai người đọc cùng tin phải thấy khác nhau;
 *  - poll hết hạn vẫn cho bỏ phiếu (client ẩn nút, nhưng API là cửa thật);
 *  - tin chỉ có poll, không có chữ, bị từ chối.
 */

let ctx: TestContext;
let owner: { token: string; userId: string };
let other: { token: string; userId: string };
let channelId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const alice: RegisteredUser = await registerUser(ctx, "poll_owner");
  const bob: RegisteredUser = await registerUser(ctx, "poll_other");
  owner = { token: alice.token, userId: alice.id };
  other = { token: bob.token, userId: bob.id };
  // Alice tạo server + lấy kênh chữ mặc định, rồi mời Bob vào.
  const guildId = await createGuild(ctx, alice.token, "Poll Server");
  channelId = listChannelsOf(await listChannels(ctx, alice.token, guildId));

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
  });
  const code = invite.json<{ code: string }>().code;
  const join = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}`,
    headers: auth(bob.token),
  });
  // Tham gia invite trả 200 (đã là thành viên thì 200, không phải 201).
  expect([200, 201]).toContain(join.statusCode);
});

function listChannelsOf(channels: Array<{ id: string; type: string }>): string {
  return channels.find((channel) => channel.type === "guild_text")!.id;
}

afterAll(async () => {
  await ctx.close();
});

async function sendPoll(
  token: string,
  poll: Record<string, unknown>,
  content = "",
): Promise<{ status: number; body: { id?: string; poll?: Record<string, unknown>; error?: { code: string } } }> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/messages`,
    headers: auth(token),
    payload: { content, poll },
  });
  return { status: response.statusCode, body: response.json() };
}

async function vote(
  token: string,
  messageId: string,
  optionIds: string[],
): Promise<{ status: number; body: { poll?: { options: Array<{ id: string; votes: number; me: boolean }>; totalVotes: number }; error?: { code: string } } }> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/messages/${messageId}/poll/votes`,
    headers: auth(token),
    payload: { optionIds },
  });
  return { status: response.statusCode, body: response.json() };
}

const BASIC = { question: "Ăn gì trưa nay?", options: ["Phở", "Cơm tấm", "Bún chả"] };

describe("Poll — tạo", () => {
  it("gửi tin chỉ có poll (không có chữ) và trả poll kèm 0 phiếu", async () => {
    const created = await sendPoll(owner.token, BASIC);
    expect(created.status).toBe(201);
    const poll = created.body.poll as { question: string; options: Array<{ label: string; votes: number; me: boolean }>; totalVotes: number; ended: boolean };
    expect(poll.question).toBe("Ăn gì trưa nay?");
    expect(poll.options.map((option) => option.label)).toEqual(["Phở", "Cơm tấm", "Bún chả"]);
    expect(poll.options.every((option) => option.votes === 0 && option.me === false)).toBe(true);
    expect(poll.totalVotes).toBe(0);
    expect(poll.ended).toBe(false);
  });

  it("tin không có chữ, không có tệp, không có poll vẫn bị từ chối", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(owner.token),
      payload: { content: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("kiểm số lựa chọn, nhãn rỗng, nhãn trùng và nhãn quá dài", async () => {
    expect((await sendPoll(owner.token, { question: "Một?", options: ["Chỉ một"] })).status).toBe(400);
    expect(
      (await sendPoll(owner.token, { question: "Mười một?", options: Array.from({ length: 11 }, (_, i) => `L${i}`) })).status,
    ).toBe(400);
    expect(
      (await sendPoll(owner.token, { question: "Rỗng?", options: ["Phở", "   "] })).status,
    ).toBe(400);
    expect(
      (await sendPoll(owner.token, { question: "Trùng?", options: ["Phở", "Phở"] })).status,
    ).toBe(400);
    expect(
      (await sendPoll(owner.token, { question: "Dài?", options: ["a".repeat(56), "b"] })).status,
    ).toBe(400);
    expect((await sendPoll(owner.token, { question: "", options: ["a", "b"] })).status).toBe(400);
    expect((await sendPoll(owner.token, BASIC, "kèm chữ")).body.poll).toBeDefined();
  });

  it("thời lượng: 1–168 giờ, số nguyên", async () => {
    expect((await sendPoll(owner.token, { ...BASIC, durationHours: 0 })).status).toBe(400);
    expect((await sendPoll(owner.token, { ...BASIC, durationHours: 200 })).status).toBe(400);
    expect((await sendPoll(owner.token, { ...BASIC, durationHours: 1.5 })).status).toBe(400);
    const ok = await sendPoll(owner.token, { ...BASIC, durationHours: 2 });
    expect(ok.status).toBe(201);
    expect(ok.body.poll).toMatchObject({ ended: false });
    expect(typeof (ok.body.poll as { expiresAt?: string }).expiresAt).toBe("string");
  });
});

describe("Poll — bỏ phiếu", () => {
  it("chọn một: người thứ hai bỏ phiếu thì phiếu cũ mất, không thành hai phiếu", async () => {
    const created = await sendPoll(owner.token, { ...BASIC, allowMultiple: false });
    const messageId = created.body.id as string;
    const [first, second] = (created.body.poll as { options: Array<{ id: string }> }).options;

    const one = await vote(owner.token, messageId, [first!.id]);
    expect(one.status).toBe(200);
    expect(one.body.poll?.options.find((option) => option.id === first!.id)).toMatchObject({
      votes: 1,
      me: true,
    });

    const two = await vote(owner.token, messageId, [second!.id]);
    expect(two.status).toBe(200);
    const options = two.body.poll!.options;
    expect(options.find((option) => option.id === first!.id)).toMatchObject({ votes: 0, me: false });
    expect(options.find((option) => option.id === second!.id)).toMatchObject({ votes: 1, me: true });
    expect(two.body.poll!.totalVotes).toBe(1);
  });

  it("gửi hai lựa chọn cho poll chọn một bị từ chối; poll nhiều lựa chọn thì được", async () => {
    const single = await sendPoll(owner.token, BASIC);
    const singleOptions = (single.body.poll as { options: Array<{ id: string }> }).options;
    const rejected = await vote(owner.token, single.body.id as string, [
      singleOptions[0]!.id,
      singleOptions[1]!.id,
    ]);
    expect(rejected.status).toBe(400);

    const multi = await sendPoll(owner.token, { ...BASIC, allowMultiple: true });
    const multiOptions = (multi.body.poll as { options: Array<{ id: string }> }).options;
    const accepted = await vote(owner.token, multi.body.id as string, [
      multiOptions[0]!.id,
      multiOptions[1]!.id,
    ]);
    expect(accepted.status).toBe(200);
    // Hai phiếu nhưng **một** người: `totalVotes` phải là 1, nếu cộng dồn thì
    // hiện "2 phiếu" cho một người bấm — sai ngay ở lần dùng thật.
    expect(accepted.body.poll!.totalVotes).toBe(1);
    expect(accepted.body.poll!.options.filter((option) => option.me)).toHaveLength(2);
  });

  it("mảng rỗng = rút phiếu", async () => {
    const created = await sendPoll(owner.token, BASIC);
    const messageId = created.body.id as string;
    const optionId = (created.body.poll as { options: Array<{ id: string }> }).options[0]!.id;
    await vote(owner.token, messageId, [optionId]);
    const cleared = await vote(owner.token, messageId, []);
    expect(cleared.status).toBe(200);
    expect(cleared.body.poll!.totalVotes).toBe(0);
    expect(cleared.body.poll!.options.every((option) => option.votes === 0)).toBe(true);
  });

  it("`me` tính theo người xem: hai người đọc cùng tin thấy khác nhau", async () => {
    const created = await sendPoll(owner.token, { ...BASIC, allowMultiple: true });
    const messageId = created.body.id as string;
    const optionId = (created.body.poll as { options: Array<{ id: string }> }).options[0]!.id;
    await vote(owner.token, messageId, [optionId]);

    const asOwner = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(owner.token),
    });
    const asOther = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(other.token),
    });
    const pick = (response: typeof asOwner) =>
      response
        .json<Array<{ id: string; poll: { options: Array<{ votes: number; me: boolean }> } | null }>>()
        .find((message) => message.id === messageId)!.poll!;
    expect(pick(asOwner).options[0]).toMatchObject({ votes: 1, me: true });
    expect(pick(asOther).options[0]).toMatchObject({ votes: 1, me: false });
  });

  it("người thứ hai bỏ phiếu cộng vào tổng, người đầu vẫn giữ phiếu của mình", async () => {
    const created = await sendPoll(owner.token, { ...BASIC, allowMultiple: true });
    const messageId = created.body.id as string;
    const [first, second] = (created.body.poll as { options: Array<{ id: string }> }).options;
    await vote(owner.token, messageId, [first!.id]);
    const both = await vote(other.token, messageId, [first!.id, second!.id]);
    expect(both.status).toBe(200);
    expect(both.body.poll!.totalVotes).toBe(2);
    expect(both.body.poll!.options.find((option) => option.id === first!.id)).toMatchObject({
      votes: 2,
      me: true,
    });
    expect(both.body.poll!.options.find((option) => option.id === second!.id)).toMatchObject({
      votes: 1,
      me: true,
    });
  });

  it("lựa chọn không thuộc poll này → 400; tin không có poll → 404", async () => {
    const created = await sendPoll(owner.token, BASIC);
    const messageId = created.body.id as string;
    const foreign = await sendPoll(owner.token, BASIC);
    const foreignOption = (foreign.body.poll as { options: Array<{ id: string }> }).options[0]!.id;
    expect((await vote(owner.token, messageId, [foreignOption])).status).toBe(400);

    const plain = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(owner.token),
      payload: { content: "tin thường" },
    });
    expect((await vote(owner.token, plain.json<{ id: string }>().id, [])).status).toBe(404);
  });

  it("poll hết hạn: chặn bỏ phiếu nhưng vẫn trả kết quả với `ended: true`", async () => {
    const created = await sendPoll(owner.token, BASIC);
    const messageId = created.body.id as string;
    const optionId = (created.body.poll as { options: Array<{ id: string }> }).options[0]!.id;
    await vote(owner.token, messageId, [optionId]);
    // Đẩy mốc hết hạn về quá khứ: server phải chặn, không phụ thuộc đồng hồ client.
    await ctx.pool.query(
      "UPDATE message_polls SET expires_at = now() - interval '1 minute' WHERE message_id = $1",
      [messageId],
    );

    const blocked = await vote(other.token, messageId, [optionId]);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error?.code).toBe("POLL_ENDED");

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(other.token),
    });
    const poll = list
      .json<Array<{ id: string; poll: { ended: boolean; totalVotes: number } | null }>>()
      .find((message) => message.id === messageId)!.poll!;
    expect(poll.ended).toBe(true);
    expect(poll.totalVotes).toBe(1);
  });

  it("người ngoài kênh không bỏ phiếu được (404 chứ không lộ sự tồn tại)", async () => {
    const outsider = await registerUser(ctx, "poll_outsider");
    const created = await sendPoll(owner.token, BASIC);
    const optionId = (created.body.poll as { options: Array<{ id: string }> }).options[0]!.id;
    const response = await vote(outsider.token, created.body.id as string, [optionId]);
    expect(response.status).toBe(404);
  });

  it("xoá tin thì poll và phiếu biến mất theo (CASCADE)", async () => {
    const created = await sendPoll(owner.token, BASIC);
    const messageId = created.body.id as string;
    const optionId = (created.body.poll as { options: Array<{ id: string }> }).options[0]!.id;
    await vote(owner.token, messageId, [optionId]);

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${messageId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);

    const polls = await ctx.pool.query("SELECT 1 FROM message_polls WHERE message_id = $1", [
      messageId,
    ]);
    const votes = await ctx.pool.query("SELECT 1 FROM poll_votes WHERE message_id = $1", [
      messageId,
    ]);
    expect(polls.rowCount).toBe(0);
    expect(votes.rowCount).toBe(0);
  });
});

describe("Poll — realtime", () => {
  let wsUrl = "";
  let clients: GatewayTestClient[] = [];

  beforeAll(async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const address = ctx.app.server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;
  });

  afterAll(() => {
    for (const client of clients) client.close();
    clients = [];
  });

  it("người khác bỏ phiếu → cả kênh nhận delta cho đúng lựa chọn đó", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: 2, d: { token: other.token } });
    await client.next((frame) => frame.op === 0 && frame.t === "READY");

    const created = await sendPoll(owner.token, { ...BASIC, allowMultiple: true });
    const messageId = created.body.id as string;
    const optionId = (created.body.poll as { options: Array<{ id: string }> }).options[0]!.id;

    await vote(owner.token, messageId, [optionId]);
    const event = await client.dispatch<{
      messageId: string;
      channelId: string;
      optionId: string;
      userId: string;
      added: boolean;
      votes: number;
      totalVotes: number;
    }>("POLL_VOTE_UPDATE");

    expect(event).toEqual({
      messageId,
      channelId,
      optionId,
      userId: owner.userId,
      added: true,
      votes: 1,
      totalVotes: 1,
    });
    // Không phát cả message: `me` trong đó tính theo người bấm, người nhận sẽ
    // thấy `me: true` ở lựa chọn họ chưa chọn.
    expect(Object.keys(event)).not.toContain("poll");
  });

  it("đổi đáp án trong poll chọn một phát hai delta: bỏ cái cũ, thêm cái mới", async () => {
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: 2, d: { token: other.token } });
    await client.next((frame) => frame.op === 0 && frame.t === "READY");

    const created = await sendPoll(owner.token, BASIC);
    const messageId = created.body.id as string;
    const [first, second] = (created.body.poll as { options: Array<{ id: string }> }).options;
    await vote(owner.token, messageId, [first!.id]);
    await client.dispatch("POLL_VOTE_UPDATE");

    await vote(owner.token, messageId, [second!.id]);
    const removed = await client.dispatch<{ optionId: string; added: boolean; votes: number }>(
      "POLL_VOTE_UPDATE",
    );
    const added = await client.dispatch<{ optionId: string; added: boolean; votes: number }>(
      "POLL_VOTE_UPDATE",
    );
    expect(removed).toMatchObject({ optionId: first!.id, added: false, votes: 0 });
    expect(added).toMatchObject({ optionId: second!.id, added: true, votes: 1 });
  });
});

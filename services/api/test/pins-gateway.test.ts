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

/** Ghim/bỏ ghim phải tới mọi client đang mở kênh, không cần F5. */

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let channelId: string;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "pin_gw_alice");
  bob = await registerUser(ctx, "pin_gw_bob");
  guildId = await createGuild(ctx, alice.token, "Pin GW");
  channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;

  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId },
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

async function connect(user: RegisteredUser): Promise<GatewayTestClient> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: 2, d: { token: user.token } });
  await client.next((frame) => frame.op === 0 && frame.t === "READY");
  return client;
}

interface PinBody {
  id: string;
  channelId: string;
  pinned: boolean;
}

describe("MESSAGE_PIN_UPDATE", () => {
  it("ghim và bỏ ghim đều phát sự kiện tới thành viên khác", async () => {
    const bobClient = await connect(bob);
    const message = await sendMessage(ctx, alice.token, channelId, "ghim rồi bỏ");

    const pinned = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/messages/${message.id}/pin`,
      headers: auth(alice.token),
    });
    expect(pinned.statusCode).toBe(200);

    const sawPin = await bobClient.dispatch<PinBody>("MESSAGE_PIN_UPDATE");
    expect(sawPin).toEqual({ id: message.id, channelId, pinned: true });

    const unpinned = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}/pin`,
      headers: auth(alice.token),
    });
    expect(unpinned.statusCode).toBe(200);

    const sawUnpin = await bobClient.dispatch<PinBody>("MESSAGE_PIN_UPDATE");
    expect(sawUnpin).toEqual({ id: message.id, channelId, pinned: false });
  });

  it("ghim lại tin đã ghim không phát event trùng", async () => {
    const bobClient = await connect(bob);
    const message = await sendMessage(ctx, alice.token, channelId, "ghim hai lần");

    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/messages/${message.id}/pin`,
      headers: auth(alice.token),
    });
    await bobClient.dispatch<PinBody>("MESSAGE_PIN_UPDATE");

    await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/messages/${message.id}/pin`,
      headers: auth(alice.token),
    });

    // Frame kế tiếp phải là của thao tác bỏ ghim, không phải ghim lặp.
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}/pin`,
      headers: auth(alice.token),
    });
    const next = await bobClient.next(
      (frame) =>
        frame.op === 0 &&
        frame.t === "MESSAGE_PIN_UPDATE" &&
        (frame.d as PinBody).id === message.id,
    );
    expect((next.d as PinBody).pinned).toBe(false);
    void bobClient;
  });
});

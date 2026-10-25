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
 * Avatar phải đổi ngay ở mọi client đang mở (không F5): server phát
 * `USER_UPDATE` tới các server mà người đó là thành viên **và** tới mọi session
 * của chính họ (tab/thiết bị khác).
 */

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const BOUNDARY = "----umaruAvatarGw";

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
const clients: GatewayTestClient[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "avatar_gw_alice");
  bob = await registerUser(ctx, "avatar_gw_bob");
  const guildId = await createGuild(ctx, alice.token, "Avatar GW");
  const channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
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

function avatarPayload(data: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const chunks = [
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ];
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

interface UserUpdateBody {
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
}

describe("USER_UPDATE khi đổi avatar", () => {
  it("thành viên khác trong server và session khác của chính mình đều nhận", async () => {
    const bobClient = await connect(bob);
    const aliceTabA = await connect(alice);
    const aliceTabB = await connect(alice);

    const body = avatarPayload(PNG_1x1);
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(200);

    const seenByBob = await bobClient.dispatch<UserUpdateBody>("USER_UPDATE");
    expect(seenByBob.user.id).toBe(alice.id);
    expect(seenByBob.user.avatarUrl).toMatch(/\/avatar\/\d+$/);
    // Không đẩy trạng thái presence giả qua kênh này.
    expect(seenByBob.user).not.toHaveProperty("status");

    for (const tab of [aliceTabA, aliceTabB]) {
      const seen = await tab.dispatch<UserUpdateBody>("USER_UPDATE");
      expect(seen.user.avatarUrl).toBe(seenByBob.user.avatarUrl);
    }
  });

  it("gỡ avatar cũng phát USER_UPDATE với avatarUrl null", async () => {
    const bobClient = await connect(bob);
    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/avatar",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);

    const seen = await bobClient.dispatch<UserUpdateBody>("USER_UPDATE");
    expect(seen.user.id).toBe(alice.id);
    expect(seen.user.avatarUrl).toBeNull();
  });
});

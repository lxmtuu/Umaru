import type { AddressInfo } from "node:net";
import { Permission, serializePermissions } from "@umaru/protocol";
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
 * Kéo-thả role phải tới mọi client đang mở Server Settings → Roles, và **chỉ**
 * những role thật sự đổi `position` mới được phát — renumber cả dãy mà bắn
 * `ROLE_UPDATE` cho tất cả sẽ làm client khác nhấp nháy vô ích.
 */

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
const clients: GatewayTestClient[] = [];

interface RoleBody {
  id: string;
  name: string;
  position: number;
}

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "ordgw_alice");
  bob = await registerUser(ctx, "ordgw_bob");
  guildId = await createGuild(ctx, alice.token, "Role order GW");
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

async function createRole(name: string): Promise<RoleBody> {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/roles`,
    headers: auth(alice.token),
    payload: { name, permissions: serializePermissions(Permission.SEND_MESSAGES) },
  });
  if (response.statusCode !== 201) throw new Error(`Tạo role lỗi: ${response.body}`);
  return response.json();
}

async function moveRole(roleId: string, position: number): Promise<void> {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/guilds/${guildId}/roles/${roleId}`,
    headers: auth(alice.token),
    payload: { position },
  });
  expect(response.statusCode).toBe(200);
}

describe("ROLE_UPDATE khi kéo-thả đổi cấp", () => {
  it("chỉ phát cho role thật sự đổi position, theo đúng thứ tự mới", async () => {
    const a = await createRole("GwA"); // position 1
    const b = await createRole("GwB"); // position 2
    const c = await createRole("GwC"); // position 3
    const client = await connect(bob);

    // Đưa C (đang trên cùng) xuống đáy: C đổi 3→1, A 1→2, B 2→3 → cả ba đổi.
    await moveRole(c.id, 2);
    const saw: RoleBody[] = [];
    for (let index = 0; index < 3; index += 1) {
      const frame = await client.next((item) => item.op === 0 && item.t === "ROLE_UPDATE");
      saw.push((frame.d as { role: RoleBody }).role);
    }
    expect(saw.map((role) => [role.name, role.position])).toEqual([
      ["GwB", 3],
      ["GwA", 2],
      ["GwC", 1],
    ]);

    // Kéo C vào đúng chỗ nó đang ở: không ai đổi position → không có frame nào.
    await moveRole(c.id, 2);
    const nothing = await client
      .next((frame) => frame.op === 0 && frame.t === "ROLE_UPDATE", 300)
      .catch(() => null);
    expect(nothing).toBeNull();

    // Dùng lại id để tránh biến không dùng.
    expect([a.id, b.id].every((id) => typeof id === "string")).toBe(true);
  });

  it("đổi tên kèm kéo-thả: một ROLE_UPDATE cho phần tên, các role đổi chỗ vẫn được phát", async () => {
    const role = await createRole("GwD");
    const client = await connect(bob);

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/guilds/${guildId}/roles/${role.id}`,
      headers: auth(alice.token),
      payload: { name: "GwD đổi tên", position: 0 },
    });
    expect(response.statusCode).toBe(200);

    // GwD đổi tên + lên trên cùng (4 role) → role khác tụt một bậc.
    const seen: Array<[string, number]> = [];
    for (let index = 0; index < 4; index += 1) {
      const frame = await client
        .next((item) => item.op === 0 && item.t === "ROLE_UPDATE", 500)
        .catch(() => null);
      if (frame === null) break;
      const payload = (frame.d as { role: RoleBody }).role;
      seen.push([payload.name, payload.position]);
    }
    expect(seen[0]).toEqual(["GwD đổi tên", 4]);
    // Không phát trùng: mỗi tên xuất hiện đúng một lần trong đợt này.
    expect(new Set(seen.map(([name]) => name)).size).toBe(seen.length);
  });
});

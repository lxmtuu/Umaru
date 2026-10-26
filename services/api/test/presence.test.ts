import type { AddressInfo } from "node:net";
import { GatewayOpcode } from "@umaru/protocol";
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
 * Presence — chấm online thật trong danh sách thành viên.
 *
 * Trước đây chỉ có `PRESENCE_UPDATE` phát khi ai đó kết nối/ngắt kết nối, và
 * **không có snapshot trong READY**: người vào sau không biết ai đang online
 * (không có event nào tới họ), nên chấm trạng thái gần như luôn trống.
 *
 * Bộ test này khoá: snapshot trong READY, trạng thái tự chọn (idle/dnd/ẩn),
 * đồng bộ giữa hai thiết bị của cùng một người, và việc **không lộ** người
 * online ngoài guild mình.
 */

let ctx: TestContext;
let wsUrl: string;
let alice: RegisteredUser;
let bob: RegisteredUser;
let stranger: RegisteredUser;
const clients: GatewayTestClient[] = [];

interface PresenceEntry {
  userId: string;
  status: string;
}

interface ReadyBody {
  user: { id: string; username: string };
  sessionId: string;
  presences: PresenceEntry[];
  guilds: Array<{ guild: { id: string } }>;
}

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  // Người không có guild chung: chỉ dùng để kiểm "không lộ presence".
  stranger = await registerUser(ctx, "stranger");

  const guildId = await createGuild(ctx, alice.token);
  const generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
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

async function connect(user: RegisteredUser): Promise<{ client: GatewayTestClient; ready: ReadyBody }> {
  const { client } = await GatewayTestClient.connect(wsUrl);
  clients.push(client);
  client.send({ op: GatewayOpcode.Identify, d: { token: user.token } });
  const ready = await client.dispatch<ReadyBody>("READY");
  return { client, ready };
}

/** Đợi PRESENCE_UPDATE của một user cụ thể (bỏ qua event của người khác). */
async function waitPresence(
  client: GatewayTestClient,
  userId: string,
  status: string,
): Promise<PresenceEntry> {
  const frame = await client.next(
    (f) =>
      f.op === 0 &&
      f.t === "PRESENCE_UPDATE" &&
      (f.d as PresenceEntry).userId === userId &&
      (f.d as PresenceEntry).status === status,
  );
  return frame.d as PresenceEntry;
}

describe("presence", () => {
  it("READY kèm snapshot người đang online cùng guild", async () => {
    const { client: aliceClient } = await connect(alice);
    await connect(bob);

    // Vào lại lần nữa để có READY mới (session cũ vẫn sống → vẫn tính online).
    const { ready } = await connect(alice);
    const entry = ready.presences.find((item) => item.userId === bob.id);
    expect(entry?.status).toBe("online");
    expect(ready.presences.some((item) => item.userId === ready.user.id)).toBe(false);

    aliceClient.close();
  });

  it("đổi sang không làm phiền → người khác nhận đúng trạng thái", async () => {
    const { client: aliceClient } = await connect(alice);
    const { client: bobClient } = await connect(bob);

    bobClient.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "dnd" } });
    const received = await waitPresence(aliceClient, bob.id, "dnd");
    expect(received.status).toBe("dnd");

    bobClient.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "idle" } });
    expect((await waitPresence(aliceClient, bob.id, "idle")).status).toBe("idle");

    bobClient.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "online" } });
    expect((await waitPresence(aliceClient, bob.id, "online")).status).toBe("online");
  });

  it("chọn ẩn (offline) → người khác thấy offline dù vẫn kết nối", async () => {
    const { client: aliceClient } = await connect(alice);
    const { client: bobClient } = await connect(bob);

    bobClient.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "offline" } });
    expect((await waitPresence(aliceClient, bob.id, "offline")).status).toBe("offline");

    // Vẫn là thành viên đang kết nối: heartbeat vẫn được ack, tức "ẩn" chỉ là
    // cách hiển thị chứ không phải đăng xuất.
    bobClient.send({ op: GatewayOpcode.Heartbeat, d: bobClient.lastSeq });
    const ack = await bobClient.next((frame) => frame.op === GatewayOpcode.HeartbeatAck);
    expect(ack.op).toBe(11);
  });

  it("trạng thái ẩn vẫn nằm trong snapshot của người vào sau", async () => {
    await connect(alice);
    const { client: bobClient } = await connect(bob);
    bobClient.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "offline" } });
    // Đợi frame này được xử lý xong trước khi có người vào sau.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { ready } = await connect(alice);
    const entry = ready.presences.find((item) => item.userId === bob.id);
    expect(entry?.status).toBe("offline");
  });

  it("ngắt kết nối → thành viên chung thấy offline", async () => {
    const { client: aliceClient } = await connect(alice);
    const { client: bobClient } = await connect(bob);
    bobClient.close();
    await bobClient.waitClose();
    expect((await waitPresence(aliceClient, bob.id, "offline")).status).toBe("offline");
  });

  it("không lộ presence của người ngoài guild", async () => {
    const { client: strangerClient } = await connect(stranger);
    await connect(alice);

    const { ready } = await connect(stranger);
    const ids = ready.presences.map((item) => item.userId);
    expect(ids).not.toContain(alice.id);
    strangerClient.close();
  });

  it("frame trạng thái rác bị bỏ qua, không đóng kết nối", async () => {
    const { client: aliceClient } = await connect(alice);
    const { client: bobClient } = await connect(bob);

    bobClient.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "khong-hop-le" } });
    // Kết nối vẫn sống: heartbeat vẫn được ack.
    bobClient.send({ op: GatewayOpcode.Heartbeat, d: bobClient.lastSeq });
    const ack = await bobClient.next((frame) => frame.op === GatewayOpcode.HeartbeatAck);
    expect(ack.op).toBe(11);
    expect(aliceClient.closeCode).toBeNull();
  });

  it("hai thiết bị của cùng một người đồng bộ trạng thái", async () => {
    const { client: deviceOne } = await connect(alice);
    const { client: deviceTwo } = await connect(alice);

    deviceOne.send({ op: GatewayOpcode.PresenceUpdate, d: { status: "idle" } });
    const mirrored = await waitPresence(deviceTwo, alice.id, "idle");
    expect(mirrored.status).toBe("idle");
  });
});

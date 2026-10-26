import { createECDH, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { GatewayOpcode } from "@umaru/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import webPush from "web-push";
// `http_ece` là thư viện mã hoá mà chính web-push dùng; có mặt ở đây để test
// **giải mã** payload thật thay vì tin rằng nó đúng.
import ece from "http_ece";
import type { PushTransport } from "../src/push/sender.js";
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

/**
 * Thông báo đẩy. Test này kiểm cả **mã hoá thật**: subscription được tạo bằng
 * một cặp khoá P-256 thật, transport giả dùng `webPush.generateRequestDetails`
 * (đúng đoạn mã mà web-push dùng khi gửi) rồi giải mã lại bằng `http_ece` với
 * khoá riêng tư của "trình duyệt". Nhờ vậy nội dung test khẳng định được là
 * **cái mà điện thoại thật sẽ nhận**, không phải JSON nội bộ của server.
 */

interface BrowserSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  ecdh: ReturnType<typeof createECDH>;
}

let endpointCounter = 0;

/** Giả lập "trình duyệt đăng ký": sinh cặp khoá như PushManager thật. */
function createBrowserSubscription(): BrowserSubscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  endpointCounter += 1;
  return {
    endpoint: `https://push.example.test/sub/${endpointCounter}`,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    ecdh,
  };
}

interface SentPush {
  endpoint: string;
  payload: {
    title: string;
    body: string;
    tag: string;
    channelId: string;
    url: string;
  };
  authorization: string;
}

interface FakePushService {
  transport: PushTransport;
  sent: SentPush[];
  /** Endpoint sẽ trả mã lỗi (mô phỏng subscription đã chết). */
  failWith: Map<string, number>;
  byEndpoint: Map<string, BrowserSubscription>;
}

function createFakePushService(vapid: { publicKey: string; privateKey: string }): FakePushService {
  webPush.setVapidDetails("mailto:test@example.com", vapid.publicKey, vapid.privateKey);
  const sent: SentPush[] = [];
  const failWith = new Map<string, number>();
  const byEndpoint = new Map<string, BrowserSubscription>();
  return {
    sent,
    failWith,
    byEndpoint,
    transport: {
      async send(subscription, payload) {
        const failure = failWith.get(subscription.endpoint);
        if (failure !== undefined) {
          throw Object.assign(new Error(`push service trả ${failure}`), { statusCode: failure });
        }
        const record = byEndpoint.get(subscription.endpoint);
        if (record === undefined) throw new Error("endpoint lạ trong test");
        const details = webPush.generateRequestDetails(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
        );
        // Giải mã bằng khoá riêng tư của "trình duyệt" — sai khoá là ném.
        const decrypted = ece.decrypt(details.body, {
          version: "aes128gcm",
          privateKey: record.ecdh,
          authSecret: subscription.auth,
        });
        sent.push({
          endpoint: subscription.endpoint,
          payload: JSON.parse(decrypted.toString()) as SentPush["payload"],
          authorization: String(details.headers.Authorization ?? ""),
        });
      },
    },
  };
}

const vapid = webPush.generateVAPIDKeys();

let ctx: TestContext;
let wsUrl: string;
let push: FakePushService;
let alice: RegisteredUser;
let bob: RegisteredUser;
let guildId: string;
let generalId: string;
const clients: GatewayTestClient[] = [];

async function subscribe(user: RegisteredUser, subscription: BrowserSubscription): Promise<void> {
  push.byEndpoint.set(subscription.endpoint, subscription);
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/push/subscriptions",
    headers: auth(user.token),
    payload: {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
  });
  expect(response.statusCode).toBe(204);
}

async function settle(): Promise<void> {
  await ctx.pushSender.whenIdle();
}

/**
 * Số push đã tới **một** endpoint cụ thể. Không đếm toàn bộ `push.sent`: một
 * người dùng tích nhiều subscription qua các test, nên "đếm tổng" là đếm cả
 * những trình duyệt khác và test sẽ phụ thuộc thứ tự chạy.
 */
function deliveredTo(endpoint: string): SentPush[] {
  return push.sent.filter((entry) => entry.endpoint === endpoint);
}

beforeAll(async () => {
  push = createFakePushService(vapid);
  ctx = await createTestContext(
    {
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:test@example.com",
      // Cooldown tắt trong hầu hết test: nó là hành vi riêng, có test riêng ở
      // cuối (đặt 10 giây để quan sát), và để nguyên sẽ làm mọi test khác phụ
      // thuộc thứ tự chạy — đúng loại test "xanh ở máy này, đỏ ở máy khác".
      PUSH_COOLDOWN_SEC: "0",
    },
    { pushTransport: push.transport },
  );
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/api/v1/gateway/ws`;

  alice = await registerUser(ctx, "alice");
  bob = await registerUser(ctx, "bob");
  guildId = await createGuild(ctx, alice.token, "Push Guild");
  generalId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(alice.token),
    payload: { channelId: generalId },
  });
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
    headers: auth(bob.token),
  });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await ctx.close();
});

describe("đăng ký subscription", () => {
  it("trả khoá công khai VAPID cho client", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/push/public-key",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ publicKey: string }>().publicKey).toBe(vapid.publicKey);
  });

  it("chặn endpoint không phải https (chống biến server thành proxy gửi request nội bộ)", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: auth(alice.token),
      payload: {
        endpoint: "http://169.254.169.254/latest/meta-data",
        keys: { p256dh: randomBytes(65).toString("base64url"), auth: randomBytes(16).toString("base64url") },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("chặn khoá sai kích thước ngay lúc đăng ký (không để lỗi nổ lúc gửi tin)", async () => {
    const good = createBrowserSubscription();
    const badAuth = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: auth(alice.token),
      payload: {
        endpoint: good.endpoint,
        keys: { p256dh: good.p256dh, auth: randomBytes(8).toString("base64url") },
      },
    });
    expect(badAuth.statusCode).toBe(400);

    const badPoint = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: auth(alice.token),
      payload: {
        endpoint: good.endpoint,
        keys: { p256dh: randomBytes(32).toString("base64url"), auth: good.auth },
      },
    });
    expect(badPoint.statusCode).toBe(400);
  });

  it("đăng ký lặp cùng endpoint không tạo dòng thứ hai", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);
    await subscribe(bob, subscription);
    const rows = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM push_subscriptions WHERE endpoint = $1",
      [subscription.endpoint],
    );
    expect(rows.rows[0].count).toBe(1);
  });

  it("huỷ đăng ký là idempotent (không có cũng vẫn 204)", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);
    const first = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/push/subscriptions",
      headers: auth(bob.token),
      payload: { endpoint: subscription.endpoint },
    });
    expect(first.statusCode).toBe(204);
    const second = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/push/subscriptions",
      headers: auth(bob.token),
      payload: { endpoint: subscription.endpoint },
    });
    expect(second.statusCode).toBe(204);
  });

  it("không cho huỷ subscription của người khác", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);
    await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/push/subscriptions",
      headers: auth(alice.token),
      payload: { endpoint: subscription.endpoint },
    });
    const rows = await ctx.pool.query(
      "SELECT 1 FROM push_subscriptions WHERE endpoint = $1",
      [subscription.endpoint],
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe("gửi thông báo đẩy", () => {
  it("DM: người nhận offline nhận push đã mã hoá đúng, tiêu đề là tên người gửi", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);

    const dm = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(alice.token),
      payload: { recipientId: bob.id },
    });
    const channelId = dm.json<{ channel: { id: string } }>().channel.id;
    await sendMessage(ctx, alice.token, channelId, "gặp nhau ở thư viện nhé");
    await settle();

    const delivered = push.sent.filter((entry) => entry.endpoint === subscription.endpoint);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload.title).toBe("alice");
    expect(delivered[0]!.payload.body).toBe("gặp nhau ở thư viện nhé");
    expect(delivered[0]!.payload.url).toBe(`/?channel=${channelId}`);
    // Chữ ký VAPID trên header: thiếu nó thì dịch vụ push thật sẽ từ chối.
    expect(delivered[0]!.authorization.startsWith("vapid t=")).toBe(true);
  });

  it("kênh server: chỉ @mention mới đẩy, tiêu đề kèm tên kênh", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);

    await sendMessage(ctx, alice.token, generalId, "không ai được gọi tên");
    await settle();
    expect(deliveredTo(subscription.endpoint)).toHaveLength(0);

    await sendMessage(ctx, alice.token, generalId, "@bob xem cái này");
    await settle();
    const delivered = deliveredTo(subscription.endpoint);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload.title).toBe("alice · #general");
    expect(delivered[0]!.payload.body).toBe("@bob xem cái này");
    expect(delivered[0]!.payload.tag).toBe(`channel-${generalId}`);
  });

  it("người đang mở app (có session gateway) thì KHÔNG đẩy — tránh hai thông báo cho một tin", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);
    const { client } = await GatewayTestClient.connect(wsUrl);
    clients.push(client);
    client.send({ op: GatewayOpcode.Identify, d: { token: bob.token } });
    await client.dispatch("READY");

    try {
      await sendMessage(ctx, alice.token, generalId, "@bob cậu đang mở app mà");
      await settle();
      expect(deliveredTo(subscription.endpoint)).toHaveLength(0);
    } finally {
      // Đóng session → lần sau lại nhận push (không phải tắt vĩnh viễn). Dọn
      // trong `finally`: một assertion hỏng không được để session treo lại và
      // làm đỏ mọi test sau đó.
      client.close();
      await client.waitClose();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await sendMessage(ctx, alice.token, generalId, "@bob giờ mình đã đóng tab");
    await settle();
    const delivered = deliveredTo(subscription.endpoint);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload.body).toBe("@bob giờ mình đã đóng tab");
  });

  it("endpoint đã chết (410) bị xoá khỏi DB, không gửi lại ở tin sau", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);
    push.failWith.set(subscription.endpoint, 410);

    await sendMessage(ctx, alice.token, generalId, "@bob tin vào endpoint chết");
    await settle();

    const rows = await ctx.pool.query(
      "SELECT 1 FROM push_subscriptions WHERE endpoint = $1",
      [subscription.endpoint],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("lỗi 5xx thì đếm số lần và bỏ sau ngưỡng, không xoá ngay", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(bob, subscription);
    push.failWith.set(subscription.endpoint, 500);

    await sendMessage(ctx, alice.token, generalId, "@bob thử lần một");
    await settle();
    expect(push.failWith.get(subscription.endpoint)).toBe(500);
    const afterOne = await ctx.pool.query<{ failure_count: number }>(
      "SELECT failure_count FROM push_subscriptions WHERE endpoint = $1",
      [subscription.endpoint],
    );
    expect(afterOne.rows[0]?.failure_count).toBe(1);
  });

  it("gửi thử tới chính mình trả số đã gửi", async () => {
    const subscription = createBrowserSubscription();
    await subscribe(alice, subscription);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/push/test",
      headers: auth(alice.token),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ delivered: number }>().delivered).toBe(1);
  });
});

describe("cooldown (bối cảnh riêng)", () => {
  /**
   * Bối cảnh riêng vì cooldown là **thời gian thật** trong bộ nhớ; để lẫn với
   * test khác thì kết quả phụ thuộc thứ tự chạy. Đặt cuối file vì `createTestContext`
   * truncate DB dùng chung.
   */
  it("hai tin liên tiếp chỉ một push; hết cooldown thì đẩy tiếp", async () => {
    const slowPush = createFakePushService(vapid);
    const slowCtx = await createTestContext(
      {
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: vapid.privateKey,
        VAPID_SUBJECT: "mailto:test@example.com",
        PUSH_COOLDOWN_SEC: "10",
      },
      { pushTransport: slowPush.transport },
    );
    try {
      const sender = await registerUser(slowCtx, "sender");
      const recipient = await registerUser(slowCtx, "recipient");
      const slowGuild = await createGuild(slowCtx, sender.token, "Slow Guild");
      const channelId = (await listChannels(slowCtx, sender.token, slowGuild))[0]!.id;
      const invite = await slowCtx.app.inject({
        method: "POST",
        url: `/api/v1/guilds/${slowGuild}/invites`,
        headers: auth(sender.token),
        payload: { channelId },
      });
      await slowCtx.app.inject({
        method: "POST",
        url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
        headers: auth(recipient.token),
      });

      const subscription = createBrowserSubscription();
      slowPush.byEndpoint.set(subscription.endpoint, subscription);
      const registered = await slowCtx.app.inject({
        method: "POST",
        url: "/api/v1/push/subscriptions",
        headers: auth(recipient.token),
        payload: {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
      });
      expect(registered.statusCode).toBe(204);

      await sendMessage(slowCtx, sender.token, channelId, "@recipient tin một");
      await slowCtx.pushSender.whenIdle();
      await sendMessage(slowCtx, sender.token, channelId, "@recipient tin hai");
      await slowCtx.pushSender.whenIdle();
      expect(slowPush.sent).toHaveLength(1);
      expect(slowPush.sent[0]!.payload.body).toBe("@recipient tin một");
    } finally {
      await slowCtx.close();
    }
  });
});

describe("chưa cấu hình VAPID", () => {
  it("mọi route push trả 503 để client phân biệt 'server chưa bật' với 'bị chặn quyền'", async () => {
    const offCtx = await createTestContext({}, { pushTransport: null });
    try {
      const user = await registerUser(offCtx, "carol");
      const key = await offCtx.app.inject({
        method: "GET",
        url: "/api/v1/push/public-key",
        headers: auth(user.token),
      });
      expect(key.statusCode).toBe(503);
      const register = await offCtx.app.inject({
        method: "POST",
        url: "/api/v1/push/subscriptions",
        headers: auth(user.token),
        payload: {
          endpoint: "https://push.example.test/x",
          keys: {
            p256dh: randomBytes(65).toString("base64url"),
            auth: randomBytes(16).toString("base64url"),
          },
        },
      });
      expect(register.statusCode).toBe(503);
      const test = await offCtx.app.inject({
        method: "POST",
        url: "/api/v1/push/test",
        headers: auth(user.token),
        payload: {},
      });
      expect(test.statusCode).toBe(503);
    } finally {
      await offCtx.close();
    }
  });
});

import webPush from "web-push";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import {
  MAX_FAILURES,
  deleteEndpoint,
  listSubscriptions,
  noteDeliveryFailure,
  noteDeliverySuccess,
  type PushSubscriptionInput,
} from "./subscriptions.js";

/**
 * Gửi thông báo đẩy (Web Push / VAPID).
 *
 * **Chỉ gửi cho người đang KHÔNG có session gateway nào.** Người đang mở app đã
 * nhận tin qua WebSocket và đã có thông báo của trình duyệt — gửi push thêm là
 * hai thông báo cho một tin, và tệ hơn: push đến trễ (qua dịch vụ của Google/
 * Mozilla) nên nó thành thông báo "tin cũ" nhảy ra sau khi người ta đã đọc.
 *
 * Vận chuyển tách khỏi quyết định (`PushTransport`): test bơm transport giả để
 * kiểm *ai* được gửi, *nội dung gì*, và dọn dẹp khi endpoint chết — không cần
 * mạng ra dịch vụ push thật.
 */

export interface PushTransport {
  send(subscription: PushSubscriptionInput, payload: string): Promise<void>;
}

export interface PushSenderDeps {
  pool: Pool;
  config: Config;
  /** Chỉ cần đúng một khả năng: người này có socket gateway đang mở không. */
  hub: { hasLiveSessionsFor(userId: string): boolean };
  /** Bơm transport giả trong test; mặc định là web-push thật. */
  transport?: PushTransport | null;
  write?: (line: string) => void;
  /** Đồng hồ cho test (cooldown). */
  now?: () => number;
}

/** Trần người nhận cho một tin — chặn fan-out bất thường làm nghẽn event loop. */
export const MAX_PUSH_RECIPIENTS = 50;

/** Body hiển thị trên điện thoại bị cắt ngắn; phần còn lại phải mở app mới đọc. */
export const PUSH_BODY_MAX = 140;

/**
 * Nội dung JSON gửi cho service worker. Hàm thuần để test được hình dạng
 * payload — đây là hợp đồng với `public/sw.js`, sai một khoá là push im lặng
 * (service worker vẫn nhận, chỉ hiện thông báo trống).
 */
export function buildPushPayload(input: {
  authorName: string;
  /** `null` = DM (tên kênh không có nghĩa với người nhận). */
  channelLabel: string | null;
  content: string;
  attachmentCount: number;
  channelId: string;
}): string {
  const collapsed = input.content.replace(/\s+/g, " ").trim();
  const body =
    collapsed.length > 0
      ? collapsed.length > PUSH_BODY_MAX
        ? `${collapsed.slice(0, PUSH_BODY_MAX - 1)}…`
        : collapsed
      : input.attachmentCount > 0
        ? "📎 Tệp đính kèm"
        : "Tin nhắn mới";
  const title =
    input.channelLabel === null
      ? input.authorName
      : `${input.authorName} · #${input.channelLabel}`;
  return JSON.stringify({
    title,
    body,
    // `tag` theo kênh: 10 tin liên tiếp trong một kênh thay thế nhau trên khay
    // thông báo thay vì xếp thành 10 dòng (và bấm vào dòng nào cũng đúng kênh).
    tag: `channel-${input.channelId}`,
    channelId: input.channelId,
    url: `/?channel=${input.channelId}`,
  });
}

/**
 * VAPID: khoá công khai/riêng tư + subject. Trả `null` khi chưa cấu hình — mọi
 * đường gửi sau đó là no-op (và route đăng ký trả 503), không phải "gửi với
 * khoá rỗng" rồi lỗi mờ ở đâu đó.
 */
function createWebPushTransport(config: Config): PushTransport | null {
  if (config.push === null) return null;
  webPush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
  return {
    async send(subscription, payload) {
      await webPush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        { TTL: 3600, urgency: "high" },
      );
    },
  };
}

interface ErrorWithStatus {
  statusCode?: unknown;
}

export class PushSender {
  private readonly transport: PushTransport | null;
  private readonly deps: PushSenderDeps;
  private readonly pending = new Set<Promise<unknown>>();
  /** Chống dội: một người nhận tối đa một push mỗi `pushCooldownSec`. */
  private readonly lastSentAt = new Map<string, number>();

  constructor(deps: PushSenderDeps) {
    this.deps = deps;
    this.transport =
      deps.transport === undefined ? createWebPushTransport(deps.config) : deps.transport;
  }

  get enabled(): boolean {
    return this.transport !== null;
  }

  /** Khoá công khai để client đăng ký — `null` khi server chưa cấu hình. */
  get publicKey(): string | null {
    return this.deps.config.push?.publicKey ?? null;
  }

  private log(line: string): void {
    this.deps.write?.(line);
  }

  /**
   * Ai nhận push cho tin này: DM → mọi thành viên khác trong kênh; kênh server
   * → chỉ người được **@mention**.
   *
   * Kênh server cố ý không đẩy cho cả server: đó là cách biến một server 500
   * người thành 500 thông báo cho một câu "ok". Người không bị gọi tên sẽ thấy
   * tin khi mở app, đúng như trước giờ.
   */
  private async resolveRecipients(input: {
    channelId: string;
    messageId: string;
    authorId: string;
    isDm: boolean;
  }): Promise<string[]> {
    const { pool } = this.deps;
    const query = input.isDm
      ? `SELECT user_id::text AS user_id FROM channel_members
          WHERE channel_id = $1 AND user_id <> $2`
      : `SELECT user_id::text AS user_id FROM message_mentions
          WHERE message_id = $1 AND user_id <> $2`;
    const result = await pool.query<{ user_id: string }>(query, [
      input.isDm ? input.channelId : input.messageId,
      input.authorId,
    ]);
    return result.rows.map((row) => row.user_id).slice(0, MAX_PUSH_RECIPIENTS);
  }

  private async deliverToUser(userId: string, payload: string): Promise<void> {
    const transport = this.transport;
    if (transport === null) return;
    const subscriptions = await listSubscriptions(this.deps.pool, userId);
    for (const subscription of subscriptions) {
      try {
        await transport.send(subscription, payload);
        await noteDeliverySuccess(this.deps.pool, subscription.endpoint);
      } catch (error) {
        const status = (error as ErrorWithStatus).statusCode;
        if (status === 404 || status === 410) {
          // Endpoint đã chết (gỡ app, xoá dữ liệu trình duyệt) — xoá luôn.
          await deleteEndpoint(this.deps.pool, subscription.endpoint);
          continue;
        }
        this.log(
          `[push] gửi lỗi (status=${String(status ?? "?")}) cho ${subscription.endpoint.slice(0, 40)}…`,
        );
        await noteDeliveryFailure(this.deps.pool, subscription.endpoint);
        if ((error as ErrorWithStatus).statusCode === undefined) {
          // Lỗi mạng/throw: không nên thử tiếp các subscription khác của cùng
          // người trong cùng một vòng — nhưng vẫn đi tiếp để không chặn người
          // khác. Chỉ ghi log, `noteDeliveryFailure` đã đếm.
          this.log(`[push] lỗi không có statusCode: ${String(error)}`.slice(0, 200));
        }
      }
    }
  }

  /**
   * Đẩy thông báo cho một tin nhắn mới. Không bao giờ ném: push là hiệu ứng
   * phụ, tuyệt đối không được làm hỏng đường gửi tin.
   */
  async notifyMessage(input: {
    messageId: string;
    channelId: string;
    authorId: string;
    authorName: string;
    channelLabel: string | null;
    content: string;
    attachmentCount: number;
    isDm: boolean;
  }): Promise<void> {
    if (this.transport === null) return;
    const task = this.runNotify(input).catch((error: unknown) => {
      this.log(`[push] bỏ qua tin ${input.messageId}: ${String(error)}`.slice(0, 200));
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private async runNotify(input: {
    messageId: string;
    channelId: string;
    authorId: string;
    authorName: string;
    channelLabel: string | null;
    content: string;
    attachmentCount: number;
    isDm: boolean;
  }): Promise<void> {
    const recipients = await this.resolveRecipients({
      channelId: input.channelId,
      messageId: input.messageId,
      authorId: input.authorId,
      isDm: input.isDm,
    });
    if (recipients.length === 0) return;

    const now = this.deps.now?.() ?? Date.now();
    const cooldownMs = this.deps.config.pushCooldownSec * 1000;
    const payload = buildPushPayload(input);
    const targets: string[] = [];
    for (const userId of recipients) {
      // Đang mở app ở đâu đó → đã nhận qua gateway, không đẩy nữa.
      if (this.deps.hub.hasLiveSessionsFor(userId)) continue;
      const last = this.lastSentAt.get(userId) ?? -Infinity;
      if (now - last < cooldownMs) continue;
      this.lastSentAt.set(userId, now);
      targets.push(userId);
    }
    for (const userId of targets) {
      await this.deliverToUser(userId, payload);
    }
  }

  /**
   * Gửi thử cho chính mình — nút "Gửi thử" trong hồ sơ. Trả về số đã gửi được
   * để UI nói thật là "đã gửi" thay vì im lặng.
   */
  async sendTest(userId: string, channelId: string | null): Promise<{ delivered: number; failed: number }> {
    const transport = this.transport;
    if (transport === null) return { delivered: 0, failed: 0 };
    const payload = buildPushPayload({
      authorName: "Umaru",
      channelLabel: null,
      content: "Thông báo đẩy đang hoạt động — bạn sẽ nhận tin mới ngay cả khi đã đóng tab.",
      attachmentCount: 0,
      channelId: channelId ?? "test",
    });
    const subscriptions = await listSubscriptions(this.deps.pool, userId);
    let delivered = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await transport.send(subscription, payload);
        await noteDeliverySuccess(this.deps.pool, subscription.endpoint);
        delivered += 1;
      } catch (error) {
        const status = (error as ErrorWithStatus).statusCode;
        if (status === 404 || status === 410) await deleteEndpoint(this.deps.pool, subscription.endpoint);
        else await noteDeliveryFailure(this.deps.pool, subscription.endpoint);
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  /** Chờ mọi lần gửi đang chạy xong (test dùng; server không cần). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /** Chỉ để test kiểm ngưỡng dọn dẹp. */
  static get maxFailures(): number {
    return MAX_FAILURES;
  }
}

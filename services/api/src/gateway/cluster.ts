import type {
  GatewayEventMap,
  GatewayEventName,
  PresenceStatus,
  VoiceStateUpdate,
} from "@umaru/protocol";
import type { EventPublisher } from "../events.js";
import {
  CONTROL_PRESENCE,
  CONTROL_PRESENCE_STATE,
  CONTROL_PRESENCE_SYNC,
  CONTROL_REFRESH_FRIENDS,
  CONTROL_SESSION_CLAIM,
  isBusMessage,
  type BusMessage,
  type EventBus,
} from "./bus.js";
import type { GatewayHub, PresenceState } from "./hub.js";

/**
 * `EventPublisher` cho nhiều node: phát **tại chỗ** rồi đẩy lên bus cho các node
 * khác, và nhận bus của node khác để phát tại chỗ.
 *
 * Điều quan trọng là thứ tự: fan-out tại chỗ **trước**, publish sau. Nếu publish
 * trước, node khác (nhanh hơn) có thể gửi cho người dùng trước khi chính node
 * này kịp gửi cho người đang nối ở đây — hai người ngồi cạnh nhau trong cùng
 * phòng thoại sẽ nghe lệch thứ tự.
 */
export class ClusterPublisher implements EventPublisher {
  constructor(
    private readonly hub: GatewayHub,
    private readonly bus: EventBus,
    private readonly origin: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    // Presence không phát qua `publish*` (nó là phản ứng của hub khi có người
    // đổi trạng thái), nên nối thẳng vào hub bằng relay.
    hub.setPresenceRelay((userId, status, guildIds) => {
      this.emit("control", userId, CONTROL_PRESENCE, { status, guildIds });
    });
    hub.setSessionRelay((sessionId) => {
      this.emit("control", sessionId, CONTROL_SESSION_CLAIM, {});
    });
    this.bus.subscribe((message) => {
      // Message của chính mình: đã fan-out tại chỗ rồi.
      if (message.origin === this.origin) return;
      this.apply(message);
    });
    // Node mới vào chưa biết ai đang online ở các node khác — hỏi ngay.
    this.emit("control", "", CONTROL_PRESENCE_SYNC, {});
  }

  publishToChannel<E extends GatewayEventName>(
    channelId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    this.hub.deliverToChannel(channelId, event, data);
    this.emit("channel", channelId, event, data);
  }

  publishToGuild<E extends GatewayEventName>(
    guildId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    this.hub.deliverToGuild(guildId, event, data);
    this.emit("guild", guildId, event, data);
  }

  publishVoiceState(channelId: string, data: VoiceStateUpdate): void {
    this.hub.deliverVoiceState(channelId, data);
    this.emit("voice", channelId, "VOICE_STATE_UPDATE", data);
  }

  publishToUser<E extends GatewayEventName>(
    userId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void {
    this.hub.deliverToUser(userId, event, data);
    this.emit("user", userId, event, data);
  }

  // Các thao tác dưới đây là **trạng thái của node**, không phải sự kiện chung:
  // `grantChannelAccess` chỉ có nghĩa với session đang nằm trên node này (node
  // khác tự tính lại khi người dùng reconnect). Vì vậy chuyển thẳng cho hub.
  grantChannelAccess(channelId: string, userIds: string[]): void {
    this.hub.grantChannelAccess(channelId, userIds);
  }

  revokeChannelAccess(channelId: string, userIds: string[]): void {
    this.hub.revokeChannelAccess(channelId, userIds);
  }

  async refreshGuildVisibility(guildId: string): Promise<void> {
    await this.hub.refreshGuildVisibility(guildId);
  }

  async refreshUserVisibility(userId: string): Promise<void> {
    await this.hub.refreshUserVisibility(userId);
  }

  /**
   * Danh sách bạn là thứ **phải** đồng bộ chéo node: kết bạn xong, bạn mới phải
   * hiện "đang online" ngay chứ không đợi reconnect. Tính tại chỗ rồi báo node
   * khác tính lại cho session của user đó.
   */
  async refreshFriendAudience(userId: string): Promise<void> {
    await this.hub.refreshFriendAudience(userId);
    this.emit("control", userId, CONTROL_REFRESH_FRIENDS, {});
  }

  private emit(
    scope: BusMessage["scope"],
    target: string,
    /** Tên sự kiện, hoặc lệnh điều khiển `__REFRESH_FRIENDS`. */
    event: string,
    data: unknown,
  ): void {
    this.bus.publish({ origin: this.origin, scope, target, event, data });
  }

  private apply(message: BusMessage): void {
    switch (message.scope) {
      case "channel":
        this.hub.deliverToChannel(
          message.target,
          message.event as GatewayEventName,
          message.data as never,
        );
        return;
      case "guild":
        this.hub.deliverToGuild(
          message.target,
          message.event as GatewayEventName,
          message.data as never,
        );
        return;
      case "user":
        this.hub.deliverToUser(
          message.target,
          message.event as GatewayEventName,
          message.data as never,
        );
        return;
      case "voice":
        this.hub.deliverVoiceState(message.target, message.data as VoiceStateUpdate);
        return;
      case "control":
        if (message.event === CONTROL_PRESENCE) {
          const payload = message.data as { status?: PresenceStatus; guildIds?: string[] };
          if (payload?.status === undefined) return;
          this.hub.deliverPresence(message.target, payload.status, payload.guildIds ?? []);
          return;
        }
        if (message.event === CONTROL_PRESENCE_SYNC) {
          // Trả lời bằng **toàn bộ** presence node này biết. Kèm cả phần nghe được
          // từ node khác để node mới không phải hỏi vòng nhiều lần.
          this.emit("control", "", CONTROL_PRESENCE_STATE, this.hub.localPresenceState());
          return;
        }
        if (message.event === CONTROL_PRESENCE_STATE) {
          const entries = message.data as PresenceState[];
          if (Array.isArray(entries)) this.hub.applyRemotePresence(entries);
          return;
        }
        if (message.event === CONTROL_SESSION_CLAIM) {
          this.hub.dropClaimedSession(message.target);
          return;
        }
        if (message.event === CONTROL_REFRESH_FRIENDS) {
          void this.hub.refreshFriendAudience(message.target).catch((error: unknown) => {
            this.log(`Bus: không tính lại được danh sách bạn cho ${message.target}: ${String(error)}`);
          });
          return;
        }
        this.log(`Bus: bỏ qua lệnh điều khiển lạ ${message.event}`);
        return;
      default:
        this.log(`Bus: bỏ qua message với scope lạ ${String(message.scope)}`);
    }
  }
}

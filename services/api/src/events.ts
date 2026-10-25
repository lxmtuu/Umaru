import type { GatewayEventMap, GatewayEventName } from "@umaru/protocol";

/** Cổng phát sự kiện realtime — gateway implement, REST handler chỉ gọi. */
export interface EventPublisher {
  publishToChannel<E extends GatewayEventName>(
    channelId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void;
  publishToGuild<E extends GatewayEventName>(
    guildId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void;
  /** Phát tới mọi session đang mở của một user (DM, thông báo riêng). */
  publishToUser<E extends GatewayEventName>(
    userId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void;
  /** Cho phép session nhận fan-out của kênh mới (DM tạo lúc user đang online). */
  grantChannelAccess(channelId: string, userIds: string[]): void;
  /** Tính lại tập kênh hiển thị cho mọi session đang mở của một guild. */
  refreshGuildVisibility(guildId: string): Promise<void>;
  /** Tính lại guild + kênh cho mọi session của một user (tạo guild, join invite). */
  refreshUserVisibility(userId: string): Promise<void>;
}

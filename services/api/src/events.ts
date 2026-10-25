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
  /**
   * `VOICE_STATE_UPDATE`: gửi cho người **xem được** kênh thoại + chính người
   * liên quan (kể cả khi họ vừa mất quyền xem kênh — họ vẫn phải biết mình đã bị
   * đưa ra khỏi phòng). Không dùng `publishToChannel` trực tiếp vì hàm đó lọc
   * theo `visibleChannels` và sẽ bỏ sót đúng người cần biết.
   */
  publishVoiceState(channelId: string, data: GatewayEventMap["VOICE_STATE_UPDATE"]): void;
  /** Phát tới mọi session đang mở của một user (DM, thông báo riêng). */
  publishToUser<E extends GatewayEventName>(
    userId: string,
    event: E,
    data: GatewayEventMap[E],
  ): void;
  /** Cho phép session nhận fan-out của kênh mới (DM tạo lúc user đang online). */
  grantChannelAccess(channelId: string, userIds: string[]): void;
  /**
   * Ngược lại `grantChannelAccess`: ngừng fan-out + phát `CHANNEL_DELETE`
   * (`guildId: null`) để client bỏ kênh khỏi sidebar. Dùng khi từ chối yêu cầu
   * nhắn tin (kênh bị xoá) — session đang mở sẽ không thấy kênh ma.
   */
  revokeChannelAccess(channelId: string, userIds: string[]): void;
  /** Tính lại tập kênh hiển thị cho mọi session đang mở của một guild. */
  refreshGuildVisibility(guildId: string): Promise<void>;
  /** Tính lại guild + kênh cho mọi session của một user (tạo guild, join invite). */
  refreshUserVisibility(userId: string): Promise<void>;
}

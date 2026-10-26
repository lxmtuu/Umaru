import { ApiError } from "@umaru/sdk";

/**
 * Âm thanh kênh thoại — lớp mỏng bọc `livekit-client`.
 *
 * Tách khỏi store để phần **quyết định** (báo lỗi gì, khi nào thử lại, thứ tự
 * gắn thẻ audio) test được mà không cần WebRTC thật: môi trường test không có
 * `RTCPeerConnection` và mạng ra LiveKit cũng không mở.
 *
 * Nguyên tắc: **âm thanh hỏng không được làm hỏng phòng thoại**. Trạng thái
 * (ai ở phòng nào) đi qua gateway và vẫn đúng dù SFU không kết nối được — chỉ
 * là không có tiếng, và UI phải nói rõ như vậy thay vì im lặng.
 */

export type VoiceAudioStatus = "idle" | "connecting" | "connected" | "unavailable" | "error";

export interface VoiceAudioState {
  channelId: string | null;
  status: VoiceAudioStatus;
  /** Khoá i18n của lỗi (không phải câu tiếng Việt) — UI tự dịch. */
  errorKey: VoiceAudioErrorKey | null;
  /**
   * Có quyền nói trong phòng này không — lấy từ `canPublish` của token server
   * cấp (tức quyền `SPEAK`). Client phải tôn trọng cờ này: bật mic khi server
   * đã từ chối chỉ tạo ra luồng media bị SFU chặn, người dùng tưởng mình nói được.
   */
  canPublish: boolean;
}

export type VoiceAudioErrorKey =
  | "voiceErrorNotConfigured"
  | "voiceErrorNotInChannel"
  | "voiceErrorMicDenied"
  | "voiceErrorConnect"
  | "voiceErrorUnknown";

/**
 * Dịch lỗi thành khoá i18n. Phân biệt rất quan trọng:
 * - **503** = server chưa cấu hình SFU → không phải lỗi của người dùng.
 * - **404** = chưa join phòng → gọi sai thứ tự, không phải "phòng hỏng".
 * - `NotAllowedError` = người dùng chưa cho quyền mic → chỉ cần bấm cho phép.
 * - còn lại = lỗi mạng/SFU → thử lại.
 */
export function classifyVoiceError(error: unknown): VoiceAudioErrorKey {
  if (error instanceof ApiError) {
    if (error.status === 503) return "voiceErrorNotConfigured";
    if (error.status === 404) return "voiceErrorNotInChannel";
    return "voiceErrorConnect";
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "voiceErrorMicDenied";
  if (name === "NotSupportedError") return "voiceErrorConnect";
  return "voiceErrorUnknown";
}

/**
 * Có nên thử kết nối lại không. Lỗi cấu hình/quyền thì thử lại chỉ tổ spam log và
 * xin quyền nhiều lần (trình duyệt sẽ chặn hẳn); lỗi mạng thì nên thử.
 */
export function shouldRetryVoice(errorKey: VoiceAudioErrorKey): boolean {
  return errorKey === "voiceErrorConnect" || errorKey === "voiceErrorUnknown";
}

/** Trạng thái audio khởi tạo cho một lần vào phòng. */
export function beginVoiceAudio(channelId: string): VoiceAudioState {
  return { channelId, status: "connecting", errorKey: null, canPublish: false };
}

export function voiceAudioError(
  channelId: string | null,
  errorKey: VoiceAudioErrorKey,
): VoiceAudioState {
  return { channelId, status: "error", errorKey, canPublish: false };
}

/**
 * Mic có được bật không: phải còn quyền nói (`canPublish`) **và** không tự mute
 * **và** không deafen. Deafen tự mute luôn mic giống Discord — người không nghe
 * được gì mà vẫn nói thì họ không biết mình đang nói một mình.
 */
export function shouldPublishMicrophone(input: {
  canPublish: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
}): boolean {
  return input.canPublish && !input.selfMute && !input.selfDeaf;
}

/**
 * Nguồn phát của người khác có nên kêu không: deafen là tắt hết, kể cả khi
 * người kia không mute.
 */
export function shouldPlayRemote(selfDeaf: boolean): boolean {
  return !selfDeaf;
}

/**
 * Một phiên âm thanh sống. Chỉ tạo được sau khi đã `PUT /channels/:id/voice`
 * thành công và đã có token từ server.
 *
 * `import("livekit-client")` là **động**: người chỉ chat chữ không phải tải
 * ~300KB WebRTC client, và nếu gói đó lỗi thì app vẫn dùng được.
 */
export class VoiceAudioSession {
  private room: {
    connect: (url: string, token: string) => Promise<void>;
    disconnect: () => Promise<void> | void;
    localParticipant: { setMicrophoneEnabled: (enabled: boolean) => Promise<unknown> };
    remoteParticipants: Map<
      string,
      { audioTrackPublications: Map<string, { track?: { attach: () => HTMLMediaElement | undefined } }> }
    >;
    on: (event: string, handler: (payload: unknown) => void) => void;
  } | null = null;
  /** Thẻ <audio> của người khác, giữ để deafen/mute toàn bộ một lần. */
  private readonly elements = new Set<HTMLMediaElement>();

  async connect(input: {
    url: string;
    token: string;
    canPublish: boolean;
    selfMute: boolean;
    selfDeaf: boolean;
  }): Promise<void> {
    const { Room, RoomEvent, Track } = await import("livekit-client");
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room as unknown as VoiceAudioSession["room"];

    // Người khác vào/ra: gắn hoặc bỏ thẻ audio ngay, không đợi gateway.
    room.on(RoomEvent.TrackSubscribed, (track, _publication, _participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      // Không đưa vào layout: chỉ để phát tiếng. `playsInline` cho iOS.
      element.style.display = "none";
      document.body.append(element);
      this.elements.add(element);
      void element.play().catch(() => undefined);
      element.muted = !shouldPlayRemote(input.selfDeaf);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) {
        element.remove();
        this.elements.delete(element);
      }
    });

    await room.connect(input.url, input.token);
    await room.localParticipant.setMicrophoneEnabled(
      shouldPublishMicrophone({
        canPublish: input.canPublish,
        selfMute: input.selfMute,
        selfDeaf: input.selfDeaf,
      }),
    );
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    if (this.room === null) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(enabled);
    } catch {
      // Mất quyền mic giữa cuộc (rút tai nghe, thu hồi quyền): không ném lỗi —
      // người dùng vẫn nghe được, chỉ không nói được.
    }
  }

  setDeafened(deafened: boolean): void {
    for (const element of this.elements) element.muted = !shouldPlayRemote(deafened);
  }

  async disconnect(): Promise<void> {
    for (const element of this.elements) element.remove();
    this.elements.clear();
    const room = this.room;
    this.room = null;
    if (room === null) return;
    try {
      await room.disconnect();
    } catch {
      // Đóng phiên đã chết không phải lỗi người dùng cần thấy.
    }
  }
}

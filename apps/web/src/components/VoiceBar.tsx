import { canShareScreen, isSpeaking, type VoiceAudioState } from "../lib/voice.js";
import { useT } from "../lib/i18n.js";

/**
 * Thanh thoại ở đáy sidebar: ai đang ở phòng nào, mic/tai nghe, chia sẻ màn hình
 * và **trạng thái âm thanh thật**.
 *
 * Tách khỏi `ChatScreen` (2000+ dòng) vì hai lý do: nó là chỗ dễ sai nhất của
 * tính năng thoại (nút nào bấm được, chữ nào hiện), và tách ra thì render được
 * trong test mà không cần dựng cả app + store.
 *
 * Component **không đọc store**: mọi thứ vào qua props, mọi hành động ra qua
 * callback. Nhờ vậy test khẳng định được "bấm nút gọi đúng hàm" thay vì chỉ
 * khẳng định "có chữ".
 */
export interface VoiceBarProps {
  channelName: string;
  selfMute: boolean;
  selfDeaf: boolean;
  voiceAudio: VoiceAudioState | null;
  speakers: readonly string[];
  meId: string | null;
  screenSharing: boolean;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onRetry: () => void;
}

export function VoiceBar(props: VoiceBarProps) {
  const t = useT();
  const { voiceAudio } = props;
  const sharingAllowed = canShareScreen({
    canPublish: voiceAudio?.canPublish ?? false,
    status: voiceAudio?.status ?? "idle",
  });
  const speaking = isSpeaking(props.speakers, props.meId);

  return (
    <div className="border-t border-white/5 bg-emerald-400/5 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] font-semibold text-emerald-200">
          🔊 {props.channelName}
        </span>
        <button
          type="button"
          onClick={props.onLeave}
          className="shrink-0 rounded px-1 text-[11px] text-slate-400 hover:bg-white/5 hover:text-rose-300"
          title={t("voiceLeave")}
          aria-label={t("voiceLeave")}
        >
          ✕
        </button>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={props.onToggleMute}
          aria-pressed={props.selfMute}
          title={props.selfMute ? t("voiceUnmute") : t("voiceMute")}
          aria-label={props.selfMute ? t("voiceUnmute") : t("voiceMute")}
          data-speaking={speaking ? "true" : undefined}
          className={`rounded px-2 py-0.5 text-xs ring-2 hover:bg-white/5 ${
            speaking ? "ring-emerald-400" : "ring-transparent"
          } ${props.selfMute ? "bg-rose-400/20 text-rose-200" : "text-slate-300"}`}
        >
          {props.selfMute ? "🔇" : "🎙"}
        </button>
        <button
          type="button"
          onClick={props.onToggleDeafen}
          aria-pressed={props.selfDeaf}
          title={props.selfDeaf ? t("voiceUndeafen") : t("voiceDeafen")}
          aria-label={props.selfDeaf ? t("voiceUndeafen") : t("voiceDeafen")}
          className={`rounded px-2 py-0.5 text-xs hover:bg-white/5 ${
            props.selfDeaf ? "bg-rose-400/20 text-rose-200" : "text-slate-300"
          }`}
        >
          🎧
        </button>
        <button
          type="button"
          onClick={props.onToggleScreenShare}
          aria-pressed={props.screenSharing}
          disabled={!sharingAllowed}
          title={
            props.screenSharing
              ? t("voiceStopShare")
              : voiceAudio?.canPublish === true
                ? t("voiceShareScreen")
                : t("voiceShareBlocked")
          }
          aria-label={props.screenSharing ? t("voiceStopShare") : t("voiceShareScreen")}
          className={`rounded px-2 py-0.5 text-xs hover:bg-white/5 disabled:opacity-40 ${
            props.screenSharing ? "bg-emerald-400/20 text-emerald-200" : "text-slate-300"
          }`}
        >
          {props.screenSharing ? "⏹" : "🖥"}
        </button>
        <VoiceAudioStatus audio={voiceAudio} speaking={speaking} onRetry={props.onRetry} />
      </div>
    </div>
  );
}

/**
 * Nhãn trạng thái âm thanh. Người dùng phải phân biệt được ba thứ rất khác nhau:
 * đang thông, chỉ nghe được (thiếu `SPEAK`), và **vì sao** không có tiếng —
 * "phòng câm" và "micro của tôi bị chặn" chữa theo hai cách khác hẳn.
 */
function VoiceAudioStatus(props: {
  audio: VoiceAudioState | null;
  speaking: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  const audio = props.audio;

  if (audio === null || audio.status === "connecting" || audio.status === "reconnecting") {
    return (
      <span className="ml-auto text-[10px] text-amber-300/80" data-testid="voice-status">
        {audio?.status === "reconnecting" ? t("voiceAudioReconnecting") : t("voiceAudioConnecting")}
      </span>
    );
  }

  if (audio.status === "connected") {
    return (
      <span
        className={`ml-auto text-[10px] ${audio.canPublish ? "text-emerald-300" : "text-amber-300"}`}
        title={audio.canPublish ? t("voiceAudioLive") : t("voiceAudioNoSpeaker")}
        data-testid="voice-status"
      >
        {audio.canPublish
          ? props.speaking
            ? `● ${t("voiceSpeaking")}`
            : `● ${t("voiceAudioLive")}`
          : `👂 ${t("voiceAudioNoSpeaker")}`}
      </span>
    );
  }

  return (
    <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-300">
      <span
        title={t(audio.errorKey ?? "voiceErrorUnknown")}
        className="max-w-[10rem] truncate"
        data-testid="voice-status"
      >
        {audio.status === "unavailable"
          ? t("voiceAudioUnavailable")
          : t(audio.errorKey ?? "voiceErrorUnknown")}
      </span>
      {/*
        "Server chưa bật âm thanh" không có gì để thử lại — nút Thử lại chỉ làm
        người dùng bấm mãi. Lỗi mạng/mic thì đúng là thử lại được.
      */}
      {audio.status !== "unavailable" && (
        <button
          type="button"
          onClick={props.onRetry}
          className="rounded border border-amber-300/40 px-1 py-0.5 hover:bg-amber-300/10"
        >
          {t("voiceRetry")}
        </button>
      )}
    </span>
  );
}

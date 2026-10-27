import { ApiError } from "@umaru/sdk";
import { describe, expect, it } from "vitest";
import {
  MAX_SPEAKERS,
  MAX_VOICE_RECONNECT_ATTEMPTS,
  canShareScreen,
  decideVoiceDrop,
  screenShareOptions,
  shouldRetryVoiceConnection,
  voiceReconnectDelayMs,
  voiceStatusAfterConnectionEvent,
  beginVoiceAudio,
  classifyVoiceError,
  isSpeaking,
  normalizeSpeakers,
  sameSpeakers,
  shouldPlayRemote,
  shouldPublishMicrophone,
  shouldRetryVoice,
  voiceAudioError,
} from "./voice.js";

/**
 * Phần quyết định của lớp âm thanh. Không test `VoiceAudioSession` ở đây: nó cần
 * `RTCPeerConnection` thật và mạng tới LiveKit — thứ không có trong môi trường
 * test. Thay vào đó khoá lại đúng những chỗ dễ sai: mic bật/tắt theo ba cờ, và
 * lỗi nào thì thử lại (thử lại lỗi quyền mic chỉ làm trình duyệt chặn hẳn).
 */

function apiError(status: number): ApiError {
  return new ApiError(status, "lỗi từ server", { error: { code: "X", message: "lỗi từ server" } });
}

describe("classifyVoiceError", () => {
  it("503 = server chưa cấu hình SFU, 404 = chưa vào phòng", () => {
    expect(classifyVoiceError(apiError(503))).toBe("voiceErrorNotConfigured");
    expect(classifyVoiceError(apiError(404))).toBe("voiceErrorNotInChannel");
  });

  it("lỗi HTTP khác (401/429/500) là lỗi kết nối, không phải 'chưa cấu hình'", () => {
    for (const status of [401, 403, 429, 500]) {
      expect(classifyVoiceError(apiError(status))).toBe("voiceErrorConnect");
    }
  });

  it("trình duyệt chặn mic → nhắc cho quyền, không phải lỗi mạng", () => {
    expect(classifyVoiceError({ name: "NotAllowedError" })).toBe("voiceErrorMicDenied");
    expect(classifyVoiceError({ name: "PermissionDeniedError" })).toBe("voiceErrorMicDenied");
  });

  it("lỗi lạ / null / chuỗi vẫn không ném", () => {
    expect(classifyVoiceError(null)).toBe("voiceErrorUnknown");
    expect(classifyVoiceError("hỏng")).toBe("voiceErrorUnknown");
    expect(classifyVoiceError(new Error("x"))).toBe("voiceErrorUnknown");
  });
});

describe("shouldRetryVoice", () => {
  it("chỉ thử lại lỗi mạng; lỗi cấu hình/quyền thì không", () => {
    expect(shouldRetryVoice("voiceErrorConnect")).toBe(true);
    expect(shouldRetryVoice("voiceErrorUnknown")).toBe(true);
    expect(shouldRetryVoice("voiceErrorNotConfigured")).toBe(false);
    expect(shouldRetryVoice("voiceErrorNotInChannel")).toBe(false);
    expect(shouldRetryVoice("voiceErrorMicDenied")).toBe(false);
  });
});

describe("shouldPublishMicrophone", () => {
  const base = { canPublish: true, selfMute: false, selfDeaf: false };

  it("bật khi có quyền nói và không mute/deafen", () => {
    expect(shouldPublishMicrophone(base)).toBe(true);
  });

  it("thiếu SPEAK → không bao giờ bật, kể cả đã bấm bỏ mute", () => {
    expect(shouldPublishMicrophone({ ...base, canPublish: false })).toBe(false);
  });

  it("deafen tự mute mic (không nghe được mà vẫn nói là nói một mình)", () => {
    expect(shouldPublishMicrophone({ ...base, selfDeaf: true })).toBe(false);
  });

  it("tự mute thì tắt mic dù chưa deafen", () => {
    expect(shouldPublishMicrophone({ ...base, selfMute: true })).toBe(false);
  });
});

describe("shouldPlayRemote", () => {
  it("deafen là tắt hết tiếng người khác", () => {
    expect(shouldPlayRemote(false)).toBe(true);
    expect(shouldPlayRemote(true)).toBe(false);
  });
});

describe("trạng thái audio", () => {
  it("bắt đầu ở 'connecting' không có lỗi; lỗi thì giữ channelId để UI biết phòng nào", () => {
    expect(beginVoiceAudio("c1")).toEqual({
      channelId: "c1",
      status: "connecting",
      errorKey: null,
      canPublish: false,
    });
    expect(voiceAudioError("c1", "voiceErrorMicDenied")).toEqual({
      channelId: "c1",
      status: "error",
      errorKey: "voiceErrorMicDenied",
      canPublish: false,
    });
  });
});

describe("normalizeSpeakers", () => {
  it("bỏ rỗng, bỏ trùng, và sắp xếp để thứ tự âm lượng không gây re-render", () => {
    // LiveKit xếp theo độ to nên hai lần phát cùng một tập người vẫn khác thứ tự.
    expect(normalizeSpeakers(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeSpeakers(["a", "b"])).toEqual(normalizeSpeakers(["b", "a"]));
  });

  it("payload mạng không tin được: bỏ phần tử không phải chuỗi, chuỗi rỗng, khoảng trắng", () => {
    expect(normalizeSpeakers([null, 42, {}, "", "   ", " u1 "])).toEqual(["u1"]);
    expect(normalizeSpeakers([])).toEqual([]);
  });

  it("chặn trần số người nói để phòng đông không làm phình state", () => {
    const many = Array.from({ length: MAX_SPEAKERS + 10 }, (_, i) => `u${i}`);
    expect(normalizeSpeakers(many)).toHaveLength(MAX_SPEAKERS);
  });
});

describe("sameSpeakers", () => {
  it("khác độ dài hoặc khác phần tử là khác; cùng nội dung cùng thứ tự là như nhau", () => {
    expect(sameSpeakers([], [])).toBe(true);
    expect(sameSpeakers(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSpeakers(["a"], ["a", "b"])).toBe(false);
    expect(sameSpeakers(["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("isSpeaking", () => {
  it("chỉ đúng khi có id thật và id đó đang nói", () => {
    expect(isSpeaking(["u1"], "u1")).toBe(true);
    expect(isSpeaking(["u1"], "u2")).toBe(false);
  });

  it("`me` chưa tải xong (null/undefined/rỗng) thì không ai sáng đèn", () => {
    // Nếu trả true ở đây thì mọi avatar cùng sáng trong lúc `READY` chưa tới.
    expect(isSpeaking(["u1"], null)).toBe(false);
    expect(isSpeaking(["u1"], undefined)).toBe(false);
    expect(isSpeaking(["u1"], "")).toBe(false);
    expect(isSpeaking([], "")).toBe(false);
  });
});

describe("nối lại khi mất kết nối SFU", () => {
  it("nhịp thử lại tăng dần nhưng có trần, để cả phòng rớt mạng không dồn lên server", () => {
    const at = (attempt: number, random = () => 0.5) => voiceReconnectDelayMs(attempt, random);
    expect(at(0)).toBeGreaterThanOrEqual(800);
    expect(at(0)).toBeLessThanOrEqual(1_200);
    expect(at(1)).toBeGreaterThan(at(0));
    expect(at(2)).toBeGreaterThan(at(1));
    // Trần 15s: dù thử lần thứ 20 cũng không chờ dài hơn.
    expect(at(20)).toBeLessThanOrEqual(15_000 * 1.0);
    expect(at(20)).toBeGreaterThanOrEqual(12_000);
  });

  it("jitter nằm trong biên: random 0 và 1 lệch nhau nhưng cùng một bậc", () => {
    const low = voiceReconnectDelayMs(1, () => 0);
    const high = voiceReconnectDelayMs(1, () => 1);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(1_600);
    expect(high).toBeLessThanOrEqual(2_400);
  });

  it("chỉ tự thử lại trong số lượt cho phép, hết lượt thì để người dùng bấm", () => {
    for (let attempt = 0; attempt < MAX_VOICE_RECONNECT_ATTEMPTS; attempt += 1) {
      expect(shouldRetryVoiceConnection(attempt)).toBe(true);
    }
    expect(shouldRetryVoiceConnection(MAX_VOICE_RECONNECT_ATTEMPTS)).toBe(false);
  });

  it("'reconnecting'/'reconnected' đổi được thành trạng thái; ngắt hẳn thì trả null để store quyết", () => {
    expect(voiceStatusAfterConnectionEvent("reconnecting")).toBe("reconnecting");
    expect(voiceStatusAfterConnectionEvent("reconnected")).toBe("connected");
    expect(voiceStatusAfterConnectionEvent("disconnected")).toBeNull();
  });
});

describe("decideVoiceDrop", () => {
  it("không còn trong phòng (tab khác rời / mất quyền) → dọn, không hồi sinh", () => {
    expect(decideVoiceDrop({ inChannel: false, attempt: 0 })).toEqual({ kind: "cleanup" });
  });

  it("còn lượt → nối lại với backoff, và mỗi lần đếm thêm một", () => {
    const first = decideVoiceDrop({ inChannel: true, attempt: 0, random: () => 0.5 });
    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") throw new Error("phải là retry");
    expect(first.attempt).toBe(0);
    expect(first.delayMs).toBeGreaterThan(0);
  });

  it("hết lượt → báo lỗi cho người dùng bấm, không thử tiếp trong im lặng", () => {
    expect(decideVoiceDrop({ inChannel: true, attempt: MAX_VOICE_RECONNECT_ATTEMPTS })).toEqual({
      kind: "giveup",
    });
    // Vẫn giữ nguyên tắc: đã rời phòng thì dọn, kể cả khi hết lượt.
    expect(decideVoiceDrop({ inChannel: false, attempt: 99 })).toEqual({ kind: "cleanup" });
  });
});

describe("chia sẻ màn hình", () => {
  it("chỉ bật được khi có quyền nói và phiên đã kết nối (hoặc đang nối lại)", () => {
    expect(canShareScreen({ canPublish: true, status: "connected" })).toBe(true);
    // Đang nối lại thì vẫn cho bấm: phiên chưa chết, chỉ là mạng đang chập.
    expect(canShareScreen({ canPublish: true, status: "reconnecting" })).toBe(true);
  });

  it("thiếu SPEAK hoặc phiên chưa sẵn sàng thì không cho bật", () => {
    expect(canShareScreen({ canPublish: false, status: "connected" })).toBe(false);
    expect(canShareScreen({ canPublish: true, status: "connecting" })).toBe(false);
    expect(canShareScreen({ canPublish: true, status: "error" })).toBe(false);
    expect(canShareScreen({ canPublish: true, status: "unavailable" })).toBe(false);
  });

  it("lựa chọn chia sẻ: có tiếng tab, chặn chia sẻ chính tab Umaru, trần 1080p30", () => {
    const options = screenShareOptions();
    expect(options.audio).toBe(true);
    // Chia sẻ chính tab Umaru = màn hình lồng chính nó, chỉ tốn băng thông.
    expect(options.selfBrowserSurface).toBe("exclude");
    expect(options.video).toEqual({
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { max: 30 },
    });
  });
});

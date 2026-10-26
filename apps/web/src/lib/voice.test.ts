import { ApiError } from "@umaru/sdk";
import { describe, expect, it } from "vitest";
import {
  MAX_SPEAKERS,
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

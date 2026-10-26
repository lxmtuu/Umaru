import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phần "đèn đang nói" của `VoiceAudioSession`. Test bằng một `Room` giả thay cho
 * `livekit-client` thật: ở đây điều cần khoá là **sổ sách** (ai đang nói, ai vừa
 * rời, khi nào không được báo lại), không phải WebRTC. Môi trường test không có
 * `RTCPeerConnection` và mạng tới LiveKit cũng không mở.
 *
 * Đã từng có một lỗi đúng ở đây: khi một người rời phòng, sự kiện mang **một**
 * người, nếu gán thẳng vào danh sách thì cả phòng tắt đèn chỉ còn người vừa rời.
 */

type Handler = (...args: unknown[]) => void;

class FakeRoom {
  static last: FakeRoom | null = null;
  readonly handlers = new Map<string, Handler[]>();
  readonly connected: string[] = [];
  readonly micCalls: boolean[] = [];
  readonly screenCalls: Array<{ enabled: boolean; options: unknown }> = [];
  /** Ném khi người dùng đóng hộp chọn màn hình ("share bị huỷ"). */
  failScreenShare = false;
  readonly localParticipant = {
    setMicrophoneEnabled: async (enabled: boolean) => {
      this.micCalls.push(enabled);
    },
    setScreenShareEnabled: async (enabled: boolean, options?: unknown) => {
      if (this.failScreenShare) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
      this.screenCalls.push({ enabled, options });
    },
  };
  readonly remoteParticipants = new Map<string, unknown>();

  constructor() {
    FakeRoom.last = this;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  /** LiveKit truyền nhiều tham số cho một số sự kiện (track, publication, participant). */
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async connect(url: string, token: string): Promise<void> {
    this.connected.push(`${url}|${token}`);
  }

  async disconnect(): Promise<void> {
    this.connected.push("disconnect");
  }
}

const ROOM_EVENTS = {
  TrackSubscribed: "trackSubscribed",
  LocalTrackUnpublished: "localTrackUnpublished",
  Reconnecting: "reconnecting",
  SignalReconnecting: "signalReconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  ActiveSpeakersChanged: "activeSpeakers",
  ParticipantDisconnected: "participantDisconnected",
  TrackUnsubscribed: "trackUnsubscribed",
};

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: ROOM_EVENTS,
  Track: { Kind: { Audio: "audio", Video: "video" } },
}));

const { VoiceAudioSession } = await import("./voice.js");

function session(): {
  session: InstanceType<typeof VoiceAudioSession>;
  room: () => FakeRoom;
  spoken: string[][];
} {
  const spoken: string[][] = [];
  return {
    session: new VoiceAudioSession(),
    // `Room` chỉ được tạo bên trong `connect`, nên phải hỏi lại sau khi connect.
    room: () => FakeRoom.last as FakeRoom,
    spoken,
  };
}

const base = { url: "wss://example", token: "tok", canPublish: true, selfMute: false, selfDeaf: false };

describe("VoiceAudioSession — đèn đang nói", () => {
  beforeEach(() => {
    FakeRoom.last = null;
  });

  it("phát danh sách người nói đã chuẩn hoá (bỏ trùng, sắp xếp)", async () => {
    const t = session();
    await t.session.connect({ ...base, onSpeakers: (ids) => t.spoken.push(ids) });
    t.room().emit(ROOM_EVENTS.ActiveSpeakersChanged, [{ identity: "u2" }, { identity: "u1" }, { identity: "u2" }]);
    expect(t.spoken.at(-1)).toEqual(["u1", "u2"]);
  });

  it("không báo lại khi tập người nói không đổi (chỉ khác thứ tự âm lượng)", async () => {
    const t = session();
    await t.session.connect({ ...base, onSpeakers: (ids) => t.spoken.push(ids) });
    t.room().emit(ROOM_EVENTS.ActiveSpeakersChanged, [{ identity: "u1" }, { identity: "u2" }]);
    const before = t.spoken.length;
    t.room().emit(ROOM_EVENTS.ActiveSpeakersChanged, [{ identity: "u2" }, { identity: "u1" }]);
    expect(t.spoken.length).toBe(before);
  });

  it("một người rời phòng thì chỉ người đó tắt đèn", async () => {
    const t = session();
    await t.session.connect({ ...base, onSpeakers: (ids) => t.spoken.push(ids) });
    t.room().emit(ROOM_EVENTS.ActiveSpeakersChanged, [{ identity: "u1" }, { identity: "u2" }]);
    t.room().emit(ROOM_EVENTS.ParticipantDisconnected, { identity: "u1" });
    expect(t.spoken.at(-1)).toEqual(["u2"]);
  });

  it("người lạ (không có identity) không chen được vào danh sách", async () => {
    const t = session();
    await t.session.connect({ ...base, onSpeakers: (ids) => t.spoken.push(ids) });
    t.room().emit(ROOM_EVENTS.ActiveSpeakersChanged, [{ identity: "u1" }]);
    t.room().emit(ROOM_EVENTS.ParticipantDisconnected, {});
    expect(t.spoken.at(-1)).toEqual(["u1"]);
  });

  it("ngắt kết nối là tắt hết đèn", async () => {
    const t = session();
    await t.session.connect({ ...base, onSpeakers: (ids) => t.spoken.push(ids) });
    t.room().emit(ROOM_EVENTS.ActiveSpeakersChanged, [{ identity: "u1" }]);
    await t.session.disconnect();
    expect(t.spoken.at(-1)).toEqual([]);
  });

  it("mic chỉ bật khi có quyền nói và không mute/deafen; đổi sau đó vẫn áp được", async () => {
    const t = session();
    await t.session.connect({ ...base, selfMute: true });
    expect(t.room().micCalls).toEqual([false]);
    await t.session.setMicrophone(true);
    expect(t.room().micCalls).toEqual([false, true]);
  });

  it("không có mic (thiếu SPEAK) thì kết nối vẫn thành công, chỉ không bật mic", async () => {
    const t = session();
    await t.session.connect({ ...base, canPublish: false });
    expect(t.room().connected).toHaveLength(1);
    expect(t.room().micCalls).toEqual([false]);
  });
});

describe("VoiceAudioSession — mất kết nối", () => {
  beforeEach(() => {
    FakeRoom.last = null;
  });

  it("báo 'reconnecting' đúng một lần dù LiveKit phát cả signal rồi media", async () => {
    const events: string[] = [];
    const t = session();
    await t.session.connect({ ...base, onConnection: (e) => events.push(e) });
    t.room().emit(ROOM_EVENTS.Reconnecting, {});
    t.room().emit(ROOM_EVENTS.SignalReconnecting, {});
    expect(events).toEqual(["reconnecting"]);
  });

  it("nối lại được thì báo 'reconnected', và lần mất sau lại báo tiếp", async () => {
    const events: string[] = [];
    const t = session();
    await t.session.connect({ ...base, onConnection: (e) => events.push(e) });
    t.room().emit(ROOM_EVENTS.Reconnecting, {});
    t.room().emit(ROOM_EVENTS.Reconnected, {});
    t.room().emit(ROOM_EVENTS.Reconnecting, {});
    expect(events).toEqual(["reconnecting", "reconnected", "reconnecting"]);
  });

  it("ngắt hẳn thì báo 'disconnected' — store mới quyết định nối lại hay báo lỗi", async () => {
    const events: string[] = [];
    const t = session();
    await t.session.connect({ ...base, onConnection: (e) => events.push(e) });
    t.room().emit(ROOM_EVENTS.Disconnected, {});
    expect(events).toEqual(["disconnected"]);
  });

  it("người dùng tự rời phòng thì KHÔNG báo 'disconnected' (không hồi sinh phiên đã đóng)", async () => {
    const events: string[] = [];
    const t = session();
    await t.session.connect({ ...base, onConnection: (e) => events.push(e) });
    await t.session.disconnect();
    t.room().emit(ROOM_EVENTS.Disconnected, {});
    expect(events).toEqual([]);
  });
});

/** Thẻ media giả — test không có DOM thật (môi trường vitest là node). */
function fakeMediaElement(kind: "audio" | "video"): {
  kind: "audio" | "video";
  autoplay: boolean;
  playsInline: boolean;
  muted: boolean;
  style: Record<string, string>;
  removed: boolean;
  play: () => Promise<void>;
  remove: () => void;
  detach: () => fakeElement[];
} {
  return {
    kind,
    autoplay: false,
    playsInline: false,
    muted: false,
    style: {},
    removed: false,
    play: async () => undefined,
    remove() {
      this.removed = true;
    },
    detach: () => [],
  };
}
type fakeElement = ReturnType<typeof fakeMediaElement>;

function fakeTrack(kind: "audio" | "video"): {
  kind: string;
  element: fakeElement;
  attach: () => fakeElement;
  detach: () => fakeElement[];
} {
  const element = fakeMediaElement(kind);
  return {
    kind,
    element,
    attach: () => element,
    detach: () => [element],
  };
}

describe("VoiceAudioSession — chia sẻ màn hình", () => {
  beforeEach(() => {
    FakeRoom.last = null;
  });

  it("nhận chia sẻ màn hình của người khác kèm tên hiển thị", async () => {
    const screens: Array<Array<{ id: string; userId: string; label: string }>> = [];
    const t = session();
    await t.session.connect({ ...base, onScreens: (list) => screens.push(list) });
    const track = fakeTrack("video");
    t.room().emit(ROOM_EVENTS.TrackSubscribed, track, { source: "screen_share", trackSid: "TR_1" }, { identity: "u1", name: "An" });
    expect(screens.at(-1)).toEqual([{ id: "u1:TR_1", userId: "u1", label: "An", element: track.element }]);
  });

  it("bỏ qua video không phải chia sẻ màn hình (camera không được cấp trong token)", async () => {
    const screens: unknown[] = [];
    const t = session();
    await t.session.connect({ ...base, onScreens: (list) => screens.push(...list) });
    t.room().emit(ROOM_EVENTS.TrackSubscribed, fakeTrack("video"), { source: "camera" }, { identity: "u1" });
    expect(screens).toHaveLength(0);
  });

  it("người chia sẻ dừng → khung xem biến mất", async () => {
    const screens: Array<Array<unknown>> = [];
    const t = session();
    await t.session.connect({ ...base, onScreens: (list) => screens.push(list) });
    const track = fakeTrack("video");
    t.room().emit(ROOM_EVENTS.TrackSubscribed, track, { source: "screen_share", trackSid: "TR_1" }, { identity: "u1" });
    t.room().emit(ROOM_EVENTS.TrackUnsubscribed, track);
    expect(screens.at(-1)).toEqual([]);
  });

  it("bật chia sẻ gửi lựa chọn an toàn (có tiếng tab, không chia sẻ chính tab Umaru)", async () => {
    const t = session();
    await t.session.connect({ ...base });
    expect(await t.session.setScreenShare(true)).toBe(true);
    const call = t.room().screenCalls.at(-1);
    expect(call?.enabled).toBe(true);
    expect(call?.options).toMatchObject({ audio: true, selfBrowserSurface: "exclude" });
  });

  it("người dùng đóng hộp chọn màn hình → trả false, không ném", async () => {
    const t = session();
    await t.session.connect({ ...base });
    t.room().failScreenShare = true;
    expect(await t.session.setScreenShare(true)).toBe(false);
  });

  it("dừng bằng thanh nổi của trình duyệt vẫn báo về để nút bấm trở lại", async () => {
    let ended = 0;
    const t = session();
    await t.session.connect({ ...base, onScreenShareEnded: () => (ended += 1) });
    t.room().emit(ROOM_EVENTS.LocalTrackUnpublished, { source: "screen_share" });
    expect(ended).toBe(1);
    // Track khác (micro) không được làm nút chia sẻ nhảy trạng thái.
    t.room().emit(ROOM_EVENTS.LocalTrackUnpublished, { source: "microphone" });
    expect(ended).toBe(1);
  });

  it("rời phòng là bỏ hết khung xem", async () => {
    const screens: Array<Array<unknown>> = [];
    const t = session();
    await t.session.connect({ ...base, onScreens: (list) => screens.push(list) });
    t.room().emit(ROOM_EVENTS.TrackSubscribed, fakeTrack("video"), { source: "screen_share", trackSid: "TR_1" }, { identity: "u1" });
    await t.session.disconnect();
    expect(screens.at(-1)).toEqual([]);
  });
});

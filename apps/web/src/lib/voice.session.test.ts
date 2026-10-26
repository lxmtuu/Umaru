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

type Handler = (payload: unknown) => void;

class FakeRoom {
  static last: FakeRoom | null = null;
  readonly handlers = new Map<string, Handler[]>();
  readonly connected: string[] = [];
  readonly micCalls: boolean[] = [];
  readonly localParticipant = {
    setMicrophoneEnabled: async (enabled: boolean) => {
      this.micCalls.push(enabled);
    },
  };
  readonly remoteParticipants = new Map<string, unknown>();

  constructor() {
    FakeRoom.last = this;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  async connect(url: string, token: string): Promise<void> {
    this.connected.push(`${url}|${token}`);
  }

  async disconnect(): Promise<void> {
    this.connected.push("disconnect");
  }
}

const ROOM_EVENTS = {
  Reconnecting: "reconnecting",
  SignalReconnecting: "signalReconnecting",
  Reconnected: "reconnected",
  Disconnected: "disconnected",
  ActiveSpeakersChanged: "activeSpeakers",
  ParticipantDisconnected: "participantDisconnected",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
};

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: ROOM_EVENTS,
  Track: { Kind: { Audio: "audio" } },
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

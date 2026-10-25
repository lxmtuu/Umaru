import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  decodeGatewayPayload,
  encodeGatewayPayload,
  isDispatch,
} from "./codec.js";
import { GatewayOpcode, type IdentifyPayload } from "./gateway.js";

describe("gateway codec", () => {
  it("decode Hello hợp lệ", () => {
    const payload = decodeGatewayPayload(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    expect(payload.op).toBe(GatewayOpcode.Hello);
    if (payload.op === GatewayOpcode.Hello) {
      expect(payload.d.heartbeat_interval).toBe(45_000);
    }
  });

  it("decode Dispatch hợp lệ + isDispatch narrow", () => {
    const payload = decodeGatewayPayload({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 7,
      d: { id: "100", channelId: "5" },
    });
    expect(isDispatch(payload)).toBe(true);
    if (isDispatch(payload)) {
      expect(payload.t).toBe("MESSAGE_CREATE");
      expect(payload.s).toBe(7);
    }
  });

  it("encode identify → JSON hợp lệ (client → server, không đi qua decode server-frame)", () => {
    const identify: IdentifyPayload = {
      op: 2,
      d: { token: "tok", properties: { os: "linux", browser: "umaru", device: "umaru" } },
    };
    // decodeGatewayPayload chỉ dành cho frame server → client (opcode 2 không thuộc SERVER_OPCODES)
    expect(JSON.parse(encodeGatewayPayload(identify))).toEqual(identify);
    expect(() => decodeGatewayPayload(encodeGatewayPayload(identify))).toThrow(ProtocolError);
  });

  it("JSON rác ném ProtocolError", () => {
    expect(() => decodeGatewayPayload("{oops")).toThrow(ProtocolError);
    expect(() => decodeGatewayPayload(123)).toThrow(ProtocolError);
    expect(() => decodeGatewayPayload(null)).toThrow(ProtocolError);
  });

  it("opcode lạ ném ProtocolError", () => {
    expect(() => decodeGatewayPayload({ op: 99, d: null })).toThrow(ProtocolError);
  });

  it("Dispatch thiếu t / s / d ném ProtocolError", () => {
    expect(() => decodeGatewayPayload({ op: 0, s: 1, d: {} })).toThrow(ProtocolError);
    expect(() => decodeGatewayPayload({ op: 0, t: "READY", d: {} })).toThrow(ProtocolError);
    expect(() => decodeGatewayPayload({ op: 0, t: "READY", s: 1 })).toThrow(ProtocolError);
  });

  it("decode ArrayBuffer", () => {
    const json = JSON.stringify({ op: 11, d: null });
    const buffer = new TextEncoder().encode(json).buffer as ArrayBuffer;
    expect(decodeGatewayPayload(buffer).op).toBe(GatewayOpcode.HeartbeatAck);
  });
});

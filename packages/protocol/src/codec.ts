import { GatewayOpcode } from "./gateway.js";
import type { DispatchPayload, GatewayReceivePayload, GatewaySendPayload } from "./gateway.js";

/** Lỗi protocol: payload sai cấu trúc hoặc sai định dạng. */
export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(message: string, readonly raw?: unknown) {
    super(message);
  }
}

/** Opcode server được phép gửi về client. */
const SERVER_OPCODES = new Set<number>([0, 1, 7, 9, 10, 11]);

export function encodeGatewayPayload(payload: GatewaySendPayload): string {
  return JSON.stringify(payload);
}

/**
 * Giải mã frame từ gateway. Nhận string / ArrayBuffer / object (object tiện cho test),
 * ném ProtocolError nếu khung sai — caller (SDK) sẽ đóng kết nối để reconnect.
 */
export function decodeGatewayPayload(raw: unknown): GatewayReceivePayload {
  const parsed = parseRaw(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("Gateway payload phải là object", raw);
  }
  const { op } = parsed as { op?: unknown };
  if (typeof op !== "number" || !SERVER_OPCODES.has(op)) {
    throw new ProtocolError(`Opcode không hợp lệ: ${String(op)}`, parsed);
  }
  if (op === GatewayOpcode.Dispatch) {
    const { t, s } = parsed as { t?: unknown; s?: unknown };
    if (typeof t !== "string" || t.length === 0) {
      throw new ProtocolError("Dispatch thiếu tên sự kiện (t)", parsed);
    }
    if (typeof s !== "number") {
      throw new ProtocolError("Dispatch thiếu sequence (s)", parsed);
    }
    if (!("d" in parsed)) {
      throw new ProtocolError("Dispatch thiếu dữ liệu (d)", parsed);
    }
  }
  return parsed as GatewayReceivePayload;
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ProtocolError("Gateway payload không phải JSON hợp lệ", raw);
    }
  }
  if (raw instanceof ArrayBuffer) {
    return parseRaw(new TextDecoder().decode(raw));
  }
  return raw;
}

export function isDispatch(payload: GatewayReceivePayload): payload is DispatchPayload {
  return payload.op === GatewayOpcode.Dispatch;
}

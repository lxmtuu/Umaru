import { createHmac } from "node:crypto";

/**
 * Token truy cập phòng LiveKit (SFU) — phần âm thanh của kênh thoại.
 *
 * **Vì sao tự ký JWT thay vì dùng `livekit-server-sdk`:** token này chỉ là một
 * JWT HS256 với vài trường cố định; tự ký bằng `node:crypto` (đã có sẵn) giữ
 * được đường phụ thuộc của server gần như bằng không, và — quan trọng hơn —
 * **kiểm chứng được** bằng cách giải mã lại token trong test, thay vì tin vào
 * một thư viện mạng.
 *
 * `LIVEKIT_API_SECRET` **chỉ** nằm ở server. Client chỉ nhận token đã ký, hết
 * hạn sau 1 giờ, và chỉ mở được **một** phòng (room = id kênh thoại). Nhờ vậy
 * lộ token của một người không kéo theo được phòng khác.
 */

export interface LiveKitConfig {
  /** `wss://…livekit.cloud` — client nối thẳng tới đây. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface VoiceTokenInput {
  config: LiveKitConfig;
  /** Tên phòng — dùng chính id kênh thoại để khỏi phải map thêm. */
  room: string;
  /** Danh tính trong phòng; dùng snowflake user để log/audit khớp DB. */
  identity: string;
  displayName: string;
  /** `SPEAK` — không có quyền nói thì vẫn nghe được (canPublish = false). */
  canPublish: boolean;
  canSubscribe: boolean;
  ttlSec: number;
  /** Mốc hiện tại, cho test bơm thời gian. */
  now?: number;
}

export interface VoiceToken {
  /** URL SFU để client kết nối (`wss://…`). */
  url: string;
  /** JWT đã ký — coi như mật khẩu tạm của phòng. */
  token: string;
  room: string;
  identity: string;
  /** ISO-8601 — client chủ động xin token mới **trước** mốc này. */
  expiresAt: string;
  canPublish: boolean;
  canSubscribe: boolean;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Ký JWT HS256 theo đúng các grant LiveKit đọc (`video.roomJoin`, `video.room`,
 * `video.canPublish`, `video.canSubscribe`).
 *
 * `nbf = now - 10s`: server SFU và API có thể lệch giờ vài giây; token vừa tạo
 * mà bị từ chối vì "not yet valid" là lỗi rất khó đoán.
 */
export function createLiveKitToken(input: VoiceTokenInput): VoiceToken {
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const exp = nowSec + input.ttlSec;
  const payload = {
    iss: input.config.apiKey,
    sub: input.identity,
    name: input.displayName,
    nbf: nowSec - 10,
    iat: nowSec,
    exp,
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: input.canPublish,
      canSubscribe: input.canSubscribe,
      // Chỉ giữ luồng media: không cho publish data packet (chat đi qua gateway).
      canPublishData: false,
    },
  };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", input.config.apiSecret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return {
    url: input.config.url,
    token: `${header}.${body}.${signature}`,
    room: input.room,
    identity: input.identity,
    expiresAt: new Date(exp * 1000).toISOString(),
    canPublish: input.canPublish,
    canSubscribe: input.canSubscribe,
  };
}

/** Giải mã + xác thực chữ ký. Dùng trong test (và có thể cho endpoint debug sau này). */
export function verifyLiveKitToken(
  token: string,
  apiSecret: string,
): { valid: boolean; payload: Record<string, unknown> | null } {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, payload: null };
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", apiSecret).update(`${header}.${body}`).digest("base64url");
  // So sánh độ dài trước để `timingSafeEqual` không ném (độ dài khác nhau là
  // chữ ký sai, không phải chuyện bí mật).
  const valid = signature.length === expected.length && signature === expected;
  if (!valid) return { valid: false, payload: null };
  try {
    return { valid: true, payload: JSON.parse(Buffer.from(body, "base64url").toString()) };
  } catch {
    return { valid: false, payload: null };
  }
}

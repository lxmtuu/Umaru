import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) tự viết — không thêm dependency.
 *
 * Cả thuật toán chỉ là HMAC-SHA1 rồi cắt 4 bit thấp; gói `otplib` kéo theo cả
 * cây phụ thuộc cho ~40 dòng code, và mọi chỗ sai (cửa sổ thời gian, base32,
 * độ dài mã) đều phải tự kiểm bằng test dù dùng gói nào.
 *
 * Thông số dùng đúng chuẩn mà Google Authenticator/Authy/1Password hỗ trợ:
 * SHA-1, 6 chữ số, bước 30 giây.
 */

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
/** Cho lệch ±1 bước (30 giây) — đồng hồ điện thoại hay lệch vài giây. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 chuẩn RFC 4648 (không padding) — định dạng mọi authenticator đọc được. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/u, "").replace(/\s+/gu, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Ký tự base32 không hợp lệ: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Sinh bí mật mới: 20 byte = 160 bit, đúng khuyến nghị RFC 4226. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Mã TOTP ở một thời điểm (ms). `step` là số bước 30 giây kể từ epoch. */
export function totpAt(secret: string, timeMs: number): { code: string; step: number } {
  const step = Math.floor(timeMs / 1000 / TOTP_STEP_SEC);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);
  return { code: String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0"), step };
}

export interface TotpCheck {
  ok: boolean;
  /** Bước thời gian của mã khớp (null khi sai) — dùng để chống replay. */
  step: number | null;
}

/**
 * Kiểm mã người dùng nhập.
 *
 * - Chỉ nhận đúng 6 chữ số (người dùng hay dán kèm khoảng trắng "123 456").
 * - Thử các bước trong cửa sổ ±1.
 * - So sánh **hằng thời gian** để không rò mã qua thời gian phản hồi.
 * - `lastStep`: mã đã dùng rồi thì từ chối, dù còn hạn (chống replay).
 */
export function verifyTotp(
  secret: string,
  input: string,
  options: { now?: number; lastStep?: number | null } = {},
): TotpCheck {
  const code = input.replace(/\s+/gu, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`, "u").test(code)) return { ok: false, step: null };

  const now = options.now ?? Date.now();
  const current = Math.floor(now / 1000 / TOTP_STEP_SEC);
  const expected = Buffer.from(code);
  let matched: number | null = null;
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    const candidate = Buffer.from(totpAt(secret, step * TOTP_STEP_SEC * 1000).code);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      matched = step;
      break;
    }
  }
  if (matched === null) return { ok: false, step: null };
  if (options.lastStep !== null && options.lastStep !== undefined && matched <= options.lastStep) {
    // Mã của bước đã dùng (hoặc cũ hơn) — coi như sai, không phải "đã dùng".
    return { ok: false, step: null };
  }
  return { ok: true, step: matched };
}

/** URI `otpauth://` để authenticator quét/đọc. `issuer` hiện thành tên trong app. */
export function otpauthUrl(secret: string, account: string, issuer = "Umaru"): string {
  // Dấu ":" giữa issuer và account phải để **nguyên** (mọi app đọc theo dạng
  // `Issuer:account`); encode từng phần rồi ghép, không encode cả label.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Mã khôi phục: 10 mã dạng `xxxxx-xxxxx`.
 *
 * Bảng chữ chỉ gồm ký tự không lẫn nhau khi đọc trên giấy (không `0/O`, `1/I/L`),
 * vì mã này thường được chép tay từ giấy hoặc ảnh chụp.
 */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const bytes = randomBytes(10);
    let code = "";
    for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.push(`${code.slice(0, 5)}-${code.slice(5, 10)}`);
  }
  return codes;
}

/** Mã khôi phục so khớp không phân biệt hoa/thường, bỏ gạch và khoảng trắng. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/gu, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

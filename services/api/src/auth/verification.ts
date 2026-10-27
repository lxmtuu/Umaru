import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { MailMessage, Mailer } from "../mail.js";

/**
 * Xác thực email: sinh token, lưu hash, gửi mail.
 *
 * Quy ước:
 * - Token thô 32 byte base64url (43 ký tự) — đủ entropy, không cần lưu plaintext.
 * - Chỉ lưu `sha256(token)` để lộ DB cũng không xác thực hộ được.
 * - Mỗi lần gửi lại: token cũ bị đánh dấu đã dùng để link trong hộp thư cũ
 *   không còn hiệu lực (tránh nhiều link sống song song).
 */

export interface VerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
}

/** Số byte ngẫu nhiên của token — 32 byte ≈ 256 bit. */
const TOKEN_BYTES = 32;

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createVerificationToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashVerificationToken(token) };
}

/** Link người dùng bấm trong mail — web app đọc `verifyToken` trên query string. */
export function buildVerificationLink(config: Config, token: string): string {
  const base = config.publicWebUrl.replace(/\/+$/, "");
  return `${base}/?verifyToken=${encodeURIComponent(token)}`;
}

export function buildVerificationMessage(input: {
  to: string;
  displayName: string;
  link: string;
  ttlHours: number;
}): MailMessage {
  const text = [
    `Chào ${input.displayName},`,
    "",
    "Cảm ơn bạn đã đăng ký Umaru. Bấm vào link dưới đây để xác thực email:",
    input.link,
    "",
    `Link hết hạn sau ${input.ttlHours} giờ và chỉ dùng được một lần.`,
    "Nếu bạn không tạo tài khoản này, cứ bỏ qua email — không cần làm gì thêm.",
    "",
    "— Umaru",
  ].join("\n");

  const html = `<!doctype html>
<html lang="vi"><body style="font-family:system-ui,sans-serif;line-height:1.5">
<p>Chào ${escapeHtml(input.displayName)},</p>
<p>Cảm ơn bạn đã đăng ký Umaru. Bấm nút dưới đây để xác thực email:</p>
<p><a href="${escapeHtml(input.link)}"
 style="display:inline-block;padding:10px 16px;border-radius:8px;background:#34d399;color:#052e16;text-decoration:none;font-weight:600">
 Xác thực email</a></p>
<p style="color:#64748b">Hoặc dán link này vào trình duyệt:<br>${escapeHtml(input.link)}</p>
<p style="color:#64748b">Link hết hạn sau ${input.ttlHours} giờ và chỉ dùng được một lần.
Nếu bạn không tạo tài khoản này, cứ bỏ qua email.</p>
<p>— Umaru</p>
</body></html>`;

  return { to: input.to, subject: "Xác thực email Umaru của bạn", text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface VerificationDeps {
  pool: Pool;
  config: Config;
  mailer: Mailer;
  /** Sinh id snowflake (truyền vào để tránh phụ thuộc vòng với config). */
  nextId: () => string;
  log?: (line: string) => void;
}

/**
 * Vô hiệu token cũ, tạo token mới, gửi mail.
 *
 * Trả token thô khi `emailVerificationEcho` bật (dev/test) — production trả
 * `null` để token chỉ tồn tại trong hộp thư của người dùng.
 */
export async function issueVerificationToken(
  deps: VerificationDeps,
  user: { id: string; email: string; displayName: string },
): Promise<string | null> {
  const { pool, config, mailer } = deps;
  const { token, hash } = createVerificationToken();
  const expiresAt = new Date(Date.now() + config.emailVerificationTtlHours * 3_600_000);

  await pool.query(
    `UPDATE email_verification_tokens SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  );
  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [deps.nextId(), user.id, hash, expiresAt],
  );

  const link = buildVerificationLink(config, token);
  const message = buildVerificationMessage({
    to: user.email,
    displayName: user.displayName,
    link,
    ttlHours: config.emailVerificationTtlHours,
  });

  try {
    await mailer.send(message);
  } catch (error) {
    // Không nuốt lỗi SMTP hoàn toàn: token vẫn sống, nhưng phải thấy trong log
    // vì người dùng sẽ không nhận được mail và cần gửi lại.
    deps.log?.(`Gửi mail xác thực thất bại (user ${user.id}): ${String(error)}`);
  }

  return config.emailVerificationEcho ? token : null;
}

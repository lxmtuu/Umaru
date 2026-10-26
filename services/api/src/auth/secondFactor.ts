import type { Pool } from "../db.js";
import { hashRecoveryCode, verifyTotp } from "./totp.js";

/**
 * Truy vấn 2FA ở tầng dữ liệu: trạng thái, xác thực mã, và tiêu thụ mã khôi phục.
 *
 * Tách khỏi route để `login` dùng lại được mà không import vòng.
 */

export interface TotpStatus {
  /** Tên trường khớp `SecurityStatus` của SDK — một hình dạng, một nơi đổi. */
  totpEnabled: boolean;
  /** Số mã khôi phục còn dùng được (0 khi chưa bật). */
  recoveryCodesLeft: number;
}

export async function loadTotpStatus(pool: Pool, userId: string): Promise<TotpStatus> {
  const totp = await pool.query<{ enabled_at: Date | null }>(
    "SELECT enabled_at FROM user_totp WHERE user_id = $1",
    [userId],
  );
  const enabled = totp.rows[0]?.enabled_at !== null && totp.rows[0]?.enabled_at !== undefined;
  if (!enabled) return { totpEnabled: false, recoveryCodesLeft: 0 };
  const left = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
    [userId],
  );
  return { totpEnabled: true, recoveryCodesLeft: Number(left.rows[0]?.count ?? "0") };
}

export interface SecondFactorInput {
  /** Mã 6 số từ authenticator. */
  code?: string | undefined;
  /** Hoặc mã khôi phục (dùng một lần). */
  recoveryCode?: string | undefined;
}

export type SecondFactorResult =
  | { ok: true; method: "totp" | "recovery" }
  | { ok: false; reason: "required" | "invalid" };

/**
 * Kiểm yếu tố thứ hai khi đăng nhập.
 *
 * Thứ tự cố ý: thử mã TOTP trước (đường thường ngày), rồi mã khôi phục. Mã khôi
 * phục bị đánh dấu đã dùng bằng `UPDATE ... WHERE used_at IS NULL` nên hai lần
 * gửi song song chỉ một lần thắng.
 */
export async function checkSecondFactor(
  pool: Pool,
  userId: string,
  input: SecondFactorInput,
): Promise<SecondFactorResult> {
  const totp = await pool.query<{ secret: string; enabled_at: Date | null; last_step: string | null }>(
    "SELECT secret, enabled_at, last_step FROM user_totp WHERE user_id = $1",
    [userId],
  );
  const row = totp.rows[0];
  if (row === undefined || row.enabled_at === null) return { ok: true, method: "totp" };

  const code = input.code?.trim() ?? "";
  const recovery = input.recoveryCode?.trim() ?? "";
  if (code === "" && recovery === "") return { ok: false, reason: "required" };

  if (code !== "") {
    const check = verifyTotp(row.secret, code, {
      lastStep: row.last_step === null ? null : Number(row.last_step),
    });
    if (check.ok && check.step !== null) {
      // Ghi bước đã dùng **có điều kiện** để hai request song song không cùng lọt.
      await pool.query(
        `UPDATE user_totp SET last_step = $2
          WHERE user_id = $1 AND (last_step IS NULL OR last_step < $2)`,
        [userId, String(check.step)],
      );
      return { ok: true, method: "totp" };
    }
  }

  if (recovery !== "") {
    const consumed = await pool.query(
      `UPDATE user_recovery_codes SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING code_hash`,
      [userId, hashRecoveryCode(recovery)],
    );
    if (consumed.rowCount === 1) return { ok: true, method: "recovery" };
  }

  return { ok: false, reason: "invalid" };
}

import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { forbidden } from "../http.js";

/**
 * Quyền "quản trị viên" của nền tảng (khác với chủ server / role trong guild).
 *
 * Ở giai đoạn này chưa có bảng phân quyền: admin khai báo qua env
 * `ADMIN_USER_IDS` (snowflake) hoặc `ADMIN_USERNAMES` (username, không phân
 * biệt hoa/thường). Để trống = không ai là admin.
 *
 * Vì sao không thêm cột `users.is_admin`: quyền này chỉ để xem hàng đợi báo
 * cáo; thêm cột là mở đường cho việc cấp quyền qua API/UI mà chưa có audit
 * log. Khi cần nhiều admin thật, thay bằng bảng `platform_admins` + audit.
 */
export function isAdmin(config: Config, user: { id: string; username: string }): boolean {
  if (config.adminUserIds.includes(user.id)) return true;
  return config.adminUsernames.includes(user.username.toLowerCase());
}

/** Có ít nhất một admin được cấu hình (dùng để log cảnh báo khi dev). */
export function hasAnyAdminConfigured(config: Config): boolean {
  return config.adminUserIds.length > 0 || config.adminUsernames.length > 0;
}

/**
 * Kiểm quyền admin cho user hiện tại. Ném 403 nếu không đủ quyền.
 *
 * Trả thông tin user để route khỏi phải truy vấn lại.
 */
export async function requireAdmin(
  pool: Pool,
  config: Config,
  userId: string,
): Promise<{ id: string; username: string }> {
  const result = await pool.query<{ id: string; username: string }>(
    "SELECT id, username FROM users WHERE id = $1",
    [userId],
  );
  const user = result.rows[0];
  if (user === undefined || !isAdmin(config, user)) {
    // 403 (không phải 404): người dùng đã đăng nhập, chỉ thiếu quyền — thông
    // báo rõ ràng giúp người vận hành phát hiện cấu hình sai.
    throw forbidden("Cần quyền quản trị viên");
  }
  return user;
}

/**
 * Nhận diện khu quản trị từ URL.
 *
 * Tách khỏi `legalRoute.ts` để hai khu vực độc lập: trang pháp lý **không cần
 * đăng nhập**, khu quản trị thì bắt buộc (server kiểm quyền, xem
 * `services/api/src/admin/access.ts`).
 */
export type AdminRoute = "reports";

export const ADMIN_REPORTS_PATH = "/admin/reports";

/** `/admin/reports` (chấp nhận dấu `/` cuối, không phân biệt hoa/thường). */
export function readAdminRoute(pathname: string): AdminRoute | null {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  if (normalized === ADMIN_REPORTS_PATH) return "reports";
  return null;
}

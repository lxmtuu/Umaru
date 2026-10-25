/**
 * Phiên bản văn bản pháp lý hiện hành.
 *
 * Dùng chung giữa API (ghi vào `users.terms_version`) và web (hiện "cập nhật
 * ngày ..."). Mỗi lần sửa nội dung Terms/Privacy phải đổi hằng số này — nhờ vậy
 * biết được tài khoản đã đồng ý bản nào, và có thể yêu cầu đồng ý lại khi cần.
 *
 * Định dạng: ngày hiệu lực `YYYY-MM-DD`.
 */
export const LEGAL_VERSION = "2026-10-26";

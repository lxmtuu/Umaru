-- Umaru — xác thực hai lớp (TOTP, kiểu Google Authenticator)
--
-- Mỗi user tối đa **một** bí mật TOTP. `enabled_at IS NULL` = đang trong quá
-- trình bật (đã sinh secret nhưng chưa xác nhận bằng mã đầu tiên) — trạng thái
-- này **không** chặn đăng nhập, nếu không người dùng đóng tab giữa lúc bật là tự
-- khoá mình ra ngoài.
--
-- `secret` là base32 (chuẩn của authenticator). Không mã hoá thêm ở đây vì khoá
-- mã hoá cũng phải nằm trong env của server — nó chỉ dời chỗ giấu, không thêm
-- bảo vệ thật. Bù lại: cột này **không** bao giờ trả ra API (xem `totp-routes`
-- và `mapUser` không đọc bảng này).
--
-- `last_step` chống **replay**: mã 6 số chỉ sống 30 giây, nên kẻ đọc được mã một
-- lần (vai ngang, log proxy) có thể dùng lại trong cùng cửa sổ. Ghi lại bước thời
-- gian đã dùng và chỉ chấp nhận bước lớn hơn.

BEGIN;

CREATE TABLE user_totp (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret      TEXT NOT NULL CHECK (char_length(secret) BETWEEN 16 AND 64),
  enabled_at  TIMESTAMPTZ,
  /** Bước 30 giây đã dùng gần nhất — chặn dùng lại cùng một mã. */
  last_step   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mã khôi phục: dùng một lần khi mất điện thoại. Lưu **sha256**, không lưu bản
-- rõ — cùng lý do với `refresh_hash`: lộ DB thì không đăng nhập được.
CREATE TABLE user_recovery_codes (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, code_hash)
);

COMMIT;

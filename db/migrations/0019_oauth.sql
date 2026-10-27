-- Umaru — đăng nhập qua nhà cung cấp OAuth2 (Google, GitHub)
--
-- Ba bảng, mỗi bảng một việc rõ ràng:
--   oauth_accounts     "tài khoản Google/GitHub này là user nào" (bảng tra lâu dài)
--   oauth_states       chống CSRF cho **một** lượt bấm đăng nhập (sống 10 phút)
--   oauth_login_codes  mã dùng-một-lần chuyển token từ server về SPA sau redirect
--
-- Vì sao mã trung gian thay vì nhét access token vào URL: URL nằm trong log của
-- proxy, lịch sử trình duyệt và header `Referer` của mọi request sau đó. Mã chỉ
-- sống 2 phút, dùng một lần, và đổi lấy token bằng POST.
--
-- `password_hash` phải cho phép NULL: tài khoản tạo bằng OAuth không có mật khẩu
-- (và **không** được đặt mật khẩu rỗng — rỗng là mật khẩu hợp lệ của một tài
-- khoản khác trong tương lai).

BEGIN;

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE oauth_accounts (
  provider         TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  -- ID bên nhà cung cấp (Google `sub`, GitHub `id`). Dùng TEXT vì GitHub trả số,
  -- Google trả chuỗi; chuẩn hoá ở app để không phụ thuộc kiểu của từng bên.
  provider_user_id TEXT NOT NULL,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Email lúc liên kết, chỉ để hiển thị/đối soát. Không dùng để đăng nhập.
  email            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ,
  PRIMARY KEY (provider, provider_user_id),
  -- Một user chỉ có tối đa một tài khoản mỗi nhà cung cấp: nếu không, "đăng nhập
  -- bằng Google" sẽ mơ hồ khi có hai dòng cùng trỏ về một người.
  UNIQUE (provider, user_id)
);

CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);

CREATE TABLE oauth_states (
  state          TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  -- Đường dẫn quay về trong SPA (`/`, `/invite/abc`…) — chỉ nhận đường dẫn nội
  -- bộ, kiểm ở app để không thành open redirect.
  redirect_path  TEXT,
  -- Người dùng đã tick đồng ý điều khoản **trước khi** sang nhà cung cấp; cần
  -- cho tài khoản tạo mới, nên phải sống sót qua vòng redirect.
  accepted_terms BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE oauth_login_codes (
  -- sha256 của mã, không lưu plaintext (cùng lý do với refresh token).
  code_hash  TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  -- Số lần nhập sai mã 2FA cho **mã này**. Mã 6 số mà sống 2 phút là dò được
  -- (10^6 phép thử), nên sau 5 lần sai là tiêu luôn mã và phải đăng nhập lại.
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_oauth_login_codes_expiry ON oauth_login_codes(expires_at);

COMMIT;

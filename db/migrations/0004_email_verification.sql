-- Umaru — xác thực email (P1)
--
-- Lý do lưu hash thay vì token thô: cùng lý do với refresh token — lộ bản dump
-- DB cũng không đăng nhập/chiếm tài khoản được. Token thô chỉ tồn tại trong
-- đường link gửi cho người dùng.
--
-- Token dùng một lần: `used_at` được set khi xác thực (UPDATE ... RETURNING
-- quyết định thắng/thua atomic, hai tab bấm cùng lúc cũng chỉ một bên thành công).

BEGIN;

CREATE TABLE email_verification_tokens (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,          -- sha256(token) dạng hex
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tra token khi người dùng bấm link (token_hash đã UNIQUE nên có sẵn index).
-- Index dưới phục vụ "token mới nhất của user" khi gửi lại (cooldown) và khi dọn cũ.
CREATE INDEX idx_email_verification_user
  ON email_verification_tokens(user_id, created_at DESC);

COMMIT;

-- Umaru — avatar người dùng (P0 hồ sơ)
--
-- Vì sao bảng riêng dù `users.avatar_url` đã có: cần biết **file nào, kiểu gì,
-- kích thước bao nhiêu** để phục vụ ảnh đúng `content-type` và để dọn file cũ
-- khi thay avatar. `users.avatar_url` vẫn là nguồn hiển thị (đã có sẵn trong
-- READY, member summary, DM) nên không phải sửa các truy vấn đó.
--
-- `upload_id` nằm trong URL (`/users/:id/avatar/:uploadId`) nên mỗi lần đổi
-- avatar là một URL mới → `cache-control: immutable` an toàn, không bị trình
-- duyệt giữ ảnh cũ.
--
-- Không FK tới bảng attachments (avatar không thuộc tin nhắn nào); file nằm ở
-- thư mục riêng (`<UPLOADS_DIR>/avatars`) để job dọn tệp của tin nhắn không
-- chạm nhầm.

BEGIN;

CREATE TABLE user_avatars (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  upload_id  BIGINT NOT NULL,
  mime_type  TEXT NOT NULL CHECK (mime_type LIKE 'image/%'),
  size       BIGINT NOT NULL CHECK (size > 0),
  width      INTEGER,
  height     INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

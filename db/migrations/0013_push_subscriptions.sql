-- Umaru — Web Push (VAPID)
--
-- Mỗi dòng là **một subscription của trình duyệt**, không phải một thiết bị của
-- người dùng: cùng một người có thể có nhiều (điện thoại, laptop, profile khác).
--
-- `endpoint` là PRIMARY KEY thay vì một cột id riêng: endpoint do dịch vụ push
-- của trình duyệt cấp và là duy nhất toàn cầu. Đăng nhập tài khoản khác trên
-- cùng trình duyệt sẽ **ghi đè** `user_id` — đúng ý (không thể có hai người cùng
-- nhận thông báo trên một endpoint, và nếu giữ dòng cũ thì người trước vẫn nhận
-- tin của kênh riêng tư sau khi đăng xuất).
--
-- `failure_count`: endpoint chết (gỡ app, xoá dữ liệu trình duyệt) thường trả
-- 404/410 và bị xoá ngay; nhưng lỗi mạng/5xx thì không nên xoá. Đếm để bỏ sau
-- vài lần thất bại liên tiếp, tránh gửi mãi vào hư không.

BEGIN;

CREATE TABLE push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

COMMIT;

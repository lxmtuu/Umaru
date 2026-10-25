-- Umaru — yêu cầu nhắn tin (message requests)
--
-- Khi người lạ mở DM với người đặt `dm_privacy = 'friends'`, bản trước trả 403
-- và cuộc trò chuyện **không tồn tại** → người gửi không có cách nào nói câu đầu
-- tiên (không giống Discord, nơi yêu cầu vẫn được gửi và người nhận tự quyết).
-- Bản này: vẫn tạo DM bình thường, nhưng đánh dấu là "đang chờ duyệt".
--
-- Bảng riêng thay vì cột trên `channels`: cột `pending` sẽ là NULL/false cho mọi
-- kênh server và mọi DM đã duyệt, trong khi bảng này trung bình chỉ có vài dòng
-- → index nhỏ, truy vấn "yêu cầu của tôi" không phải quét toàn bộ `channels`.
--
-- Hai chiều: `sender_id` là người mở cuộc, `recipient_id` là người phải đồng ý.
-- Không có cột `state`: mọi dòng đều là "đang chờ" — đồng ý thì xoá dòng, từ chối
-- thì xoá cả kênh (tin nhắn + tệp đính kèm đi theo FK CASCADE).

BEGIN;

CREATE TABLE dm_requests (
  channel_id   BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  sender_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);

-- Danh sách "yêu cầu chờ duyệt" của một người, mới nhất trước.
CREATE INDEX idx_dm_requests_recipient ON dm_requests(recipient_id, created_at DESC);
-- Trần số yêu cầu đang chờ của một người gửi (chống biến tài khoản thành máy spam).
CREATE INDEX idx_dm_requests_sender ON dm_requests(sender_id);

COMMIT;

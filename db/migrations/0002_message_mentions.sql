-- Umaru — @mention (P1, làm ngay để badge mention tách khỏi badge tin thường)
--
-- Lý do không parse nội dung mỗi lần tính badge: badge phải đếm được trong
-- một câu SQL khi load READY. Ghi lúc gửi/sửa tin nên chỉ mất một batch insert.
-- Counter KHÔNG lưu trong bảng này — số chưa đọc/mention luôn tính bằng count,
-- tránh phải update đồng bộ khi fan-out @everyone (xem docs/data-model.md §3).

BEGIN;

CREATE TABLE message_mentions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Badge mention: đếm cho một user trong một kênh, chỉ quét tin sau mốc đã đọc.
CREATE INDEX idx_message_mentions_user_channel
  ON message_mentions(user_id, channel_id, message_id DESC);

COMMIT;

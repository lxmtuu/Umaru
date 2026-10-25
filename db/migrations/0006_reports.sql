-- Umaru — báo cáo vi phạm (Trust & Safety, P0)
--
-- Vì sao snapshot: người bị báo cáo có thể sửa/xoá tin ngay sau khi bị report.
-- Nếu chỉ lưu `message_id` thì nội dung vi phạm biến mất trước khi admin xem.
-- Nên lưu bản sao nội dung + tác giả tại thời điểm báo cáo (đúng bằng chứng).
--
-- Vì sao không FK cứng tới messages: tin có thể bị xoá; báo cáo vẫn phải còn.
-- Cột `target_message_id` để NULL được và không có FK — cố ý.

BEGIN;

CREATE TABLE reports (
  id                BIGINT PRIMARY KEY,
  reporter_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Người bị báo cáo: lấy trực tiếp (report user) hoặc suy ra từ tin (report message).
  target_user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_message_id BIGINT,
  channel_id        BIGINT,                 -- ngữ cảnh, không FK (kênh có thể bị xoá)
  guild_id          BIGINT,
  reason            TEXT NOT NULL CHECK (reason IN (
                      'spam', 'harassment', 'hate', 'sexual_content',
                      'violence', 'self_harm', 'impersonation', 'other')),
  details           TEXT CHECK (details IS NULL OR char_length(details) <= 1000),
  -- Bản sao nội dung tại thời điểm báo cáo (tối đa 2000 ký tự như tin nhắn).
  snapshot_content  TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'reviewing', 'closed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reporter_id <> target_user_id)
);

-- Hàng đợi cho admin: báo cáo mới nhất trước, lọc theo trạng thái.
CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);
-- Chống lạm dụng: đếm số báo cáo của một người trong khoảng thời gian.
CREATE INDEX idx_reports_reporter_created ON reports(reporter_id, created_at DESC);

COMMIT;

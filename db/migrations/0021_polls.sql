-- Umaru — bình chọn trong tin nhắn (poll)
--
-- Ba bảng, cùng một lý do tách khỏi `messages`: poll là **dữ liệu sống** (người
-- khác bỏ phiếu liên tục) còn `messages` chỉ bị sửa khi tác giả sửa nội dung.
-- Để chung một cột JSON thì mỗi lượt bỏ phiếu phải ghi lại cả dòng tin, đụng
-- `edited_at`, và đẩy cả tin qua gateway thay vì chỉ phần poll.
--
-- `poll_votes.message_id` lặp lại (đã suy ra được từ `option_id`) là cố ý:
--   * đếm phiếu cho cả trang tin bằng một câu `GROUP BY message_id`;
--   * chọn "một đáp án" = xoá các phiếu khác **của cùng tin** trong một câu,
--     không phải join ngược lên `poll_options`;
--   * xoá tin thì CASCADE dọn sạch, không cần job.

BEGIN;

CREATE TABLE message_polls (
  message_id     BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  allow_multiple BOOLEAN NOT NULL DEFAULT false,
  -- `NULL` = không hết hạn. Có hạn thì server tự chặn bỏ phiếu, không cần cron.
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE poll_options (
  -- Snowflake sinh ở app: client bỏ phiếu theo id, nên id phải ổn định và không
  -- phụ thuộc thứ tự chèn.
  id         BIGINT PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES message_polls(message_id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  position   INTEGER NOT NULL
);

CREATE INDEX idx_poll_options_message ON poll_options(message_id, position);

CREATE TABLE poll_votes (
  option_id  BIGINT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bỏ phiếu hai lần cho cùng một đáp án là no-op ở tầng dữ liệu (ON CONFLICT),
  -- không cần SELECT trước rồi mới INSERT.
  PRIMARY KEY (option_id, user_id)
);

CREATE INDEX idx_poll_votes_message_user ON poll_votes(message_id, user_id);

COMMIT;

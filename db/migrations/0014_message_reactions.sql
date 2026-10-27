-- Umaru — reaction emoji trên tin nhắn
--
-- Mỗi dòng là "người A thả emoji E vào tin M". Khoá chính ba cột nên thả cùng
-- một emoji hai lần là **cùng một dòng** (idempotent, không cần kiểm trùng ở
-- route) và bỏ reaction = xoá đúng dòng đó.
--
-- `emoji` là chuỗi Unicode thô (không phải id): client gửi lên đúng ký tự người
-- dùng bấm. Trần 32 ký tự đủ cho cả emoji gia đình (👨‍👩‍👧‍👦 là 7 codepoint) và
-- skin-tone, mà vẫn chặn được việc nhét cả đoạn văn vào một reaction.
--
-- `ON DELETE CASCADE` từ `messages`: xoá tin là reaction biến mất, không để lại
-- dòng mồ côi. Cùng lý do với attachments.

BEGIN;

CREATE TABLE message_reactions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Truy vấn nóng nhất là "gom reaction của một trang tin" → index theo message_id.
CREATE INDEX idx_message_reactions_message ON message_reactions(message_id);

COMMIT;

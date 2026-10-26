-- Umaru — thread (luồng thảo luận con của một tin nhắn)
--
-- Vì sao thread là **một dòng `channels`** chứ không phải bảng riêng: mọi thứ
-- đã có đều dùng `channel_id` — tin nhắn, reaction, ghim, read state, tìm kiếm,
-- đánh máy, gateway fan-out. Làm bảng riêng nghĩa là nhân đôi toàn bộ đường đó.
--
-- `parent_id` của thread trỏ tới **kênh cha** (không phải category), nên phần
-- kế thừa quyền có sẵn áp đúng: thread thừa hưởng overwrite của kênh cha. Đó
-- cũng là lý do chỉ cần đổi CHECK, không cần bảng quyền mới.
--
-- Thread **không** hiện trên sidebar: mọi truy vấn dựng sidebar phải lọc
-- `type <> 'guild_thread'` (đã làm ở `access.ts` và `bootstrap.ts`).

BEGIN;

-- Thêm loại 'guild_thread'. Constraint cũ là inline (tên tự sinh) nên phải drop
-- theo tên thật, đã kiểm bằng `pg_get_constraintdef`.
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels DROP CONSTRAINT channels_check;

ALTER TABLE channels
  ADD CONSTRAINT channels_type_check
  CHECK (type IN ('guild_text', 'guild_voice', 'category', 'dm', 'group_dm', 'guild_thread'));

-- Thread cũng là kênh guild có tên (lấy từ tin gốc / người tạo đặt).
ALTER TABLE channels
  ADD CONSTRAINT channels_check
  CHECK (
    (type IN ('guild_text', 'guild_voice', 'category', 'guild_thread')
      AND guild_id IS NOT NULL AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 100)
    OR
    (type IN ('dm', 'group_dm') AND guild_id IS NULL)
  );

-- Tách khỏi `channels` vì chỉ thread mới có những cột này: để chung bảng thì
-- mọi kênh thường phải mang theo 5 cột NULL, và mọi SELECT kênh kéo theo rác.
CREATE TABLE channel_threads (
  channel_id        BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  -- Lặp lại `channels.parent_id` có chủ ý: index dưới đây cần cột này để liệt kê
  -- thread của một kênh mà không phải join `channels`.
  parent_channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- Tin gốc sinh ra thread. NULL được: thread tạo tay không gắn tin nào.
  root_message_id   BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  owner_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  message_count     INTEGER NOT NULL DEFAULT 0,
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Truy vấn nóng nhất: "thread đang mở của kênh này, mới hoạt động trước".
CREATE INDEX idx_channel_threads_parent
  ON channel_threads(parent_channel_id, archived_at, last_activity_at DESC);

-- Chỉ thread mới có dòng trong `channel_threads`; chặn dữ liệu rác ở tầng DB.
ALTER TABLE channel_threads
  ADD CONSTRAINT channel_threads_parent_is_thread
  CHECK (parent_channel_id <> channel_id);

COMMIT;

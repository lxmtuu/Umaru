-- Umaru — sticker theo server (mục 53)
--
-- Mô hình: **gói sticker thuộc một server** (`guild_id` NOT NULL). Sticker là
-- biểu cảm của cộng đồng đó, không phải tài sản toàn hệ thống: ai vào server
-- cũng dùng được, rời server là không còn thấy. Gói toàn cục (kiểu Nitro) cần
-- quy trình kiểm duyệt nội dung và bản quyền — chưa cần cho bản này.
--
-- Tin nhắn sticker: `messages.sticker_id` thay cho `content`. Không tách bảng
-- `message_stickers` vì quan hệ là 1–1 (một tin = tối đa một sticker, giống
-- Discord): cột trên `messages` cho phép tải cả trang tin bằng một JOIN.
--
-- `ON DELETE SET NULL` chỉ là lưới an toàn: API **từ chối** xoá sticker đang
-- được dùng (409) để không có tin "sticker ma" trên giao diện. Nếu vì lý do nào
-- đó vẫn bị xoá, tin còn lại vẫn đọc được (chỉ mất hình), không vỡ khoá ngoại.

BEGIN;

CREATE TABLE sticker_packs (
  id         BIGINT PRIMARY KEY,
  guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sticker_packs_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
  -- Tên gói là thứ người dùng gõ để tìm; hai gói trùng tên trong một server là
  -- không phân biệt được.
  CONSTRAINT sticker_packs_name_unique UNIQUE (guild_id, name)
);
CREATE INDEX idx_sticker_packs_guild ON sticker_packs(guild_id, created_at);

CREATE TABLE stickers (
  id         BIGINT PRIMARY KEY,
  pack_id    BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  upload_id  TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL CHECK (size > 0),
  width      INTEGER NOT NULL CHECK (width > 0),
  height     INTEGER NOT NULL CHECK (height > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stickers_name_length CHECK (char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT stickers_name_unique UNIQUE (pack_id, name),
  -- Sticker là ô vuông: lưới trong bảng chọn và bong bóng tin đều render theo
  -- tỉ lệ 1:1, nhận ảnh dài sẽ méo hoặc phải crop mất nội dung.
  CONSTRAINT stickers_square CHECK (width = height)
);
CREATE INDEX idx_stickers_pack ON stickers(pack_id, created_at);

ALTER TABLE messages ADD COLUMN sticker_id BIGINT REFERENCES stickers(id) ON DELETE SET NULL;
-- Index bộ phận: tin sticker là thiểu số, index đầy đủ chỉ tốn chỗ ghi.
CREATE INDEX idx_messages_sticker ON messages(sticker_id) WHERE sticker_id IS NOT NULL;

COMMIT;

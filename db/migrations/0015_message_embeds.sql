-- Umaru — embed xem trước liên kết (kiểu thẻ OG của Discord)
--
-- Mỗi tin nhắn có **tối đa một** embed: lấy URL đầu tiên trong nội dung, tải
-- trang đó một lần ở server, đọc các thẻ `og:*` rồi lưu lại đây. Khoá chính là
-- `message_id` nên ghi lại (sửa tin) chỉ là UPSERT, và xoá tin là CASCADE.
--
-- Vì sao lưu ở bảng riêng thay vì cột JSONB trên `messages`:
--   * nội dung trang bên ngoài đổi liên tục — tách ra thì xoá/tải lại một embed
--     không phải UPDATE dòng tin nhắn (không đụng `edited_at`).
--   * tin chưa có embed vẫn là dòng `messages` sạch, không cột NULL nào.
--
-- `title`/`description`/`site_name`/`image_url` đều nullable: trang thật thiếu
-- đủ kiểu thẻ, và embed chỉ có mỗi domain vẫn hữu ích hơn không có gì.

BEGIN;

CREATE TABLE message_embeds (
  message_id  BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  site_name   TEXT,
  image_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

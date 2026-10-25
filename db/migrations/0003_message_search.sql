-- Umaru — chỉ mục tìm kiếm tin nhắn (G1: search cơ bản)
--
-- Tìm kiếm dùng `content ILIKE '%q%'` (chấp nhận cả tiếng Việt có dấu, không
-- phụ thuộc cấu hình từ điển của to_tsvector). ILIKE mà không có chỉ mục là
-- quét tuần tự, nên khi `pg_trgm` có sẵn (Neon, Supabase, Postgres 16 dev) ta
-- tạo GIN trigram để tăng tốc.
--
-- Vì sao bọc DO/EXCEPTION: một số nhà cung cấp quản lý không cho CREATE EXTENSION
-- (thiếu quyền superuser). Trường hợp đó migration vẫn phải chạy xong — tìm kiếm
-- vẫn đúng kết quả, chỉ chậm hơn khi dữ liệu lớn.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm không khả dụng (%) — tìm kiếm vẫn chạy, không có chỉ mục trigram', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
      ON messages USING gin (content gin_trgm_ops);
  END IF;
END $$;

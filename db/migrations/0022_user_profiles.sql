-- Umaru — hồ sơ công khai: giới thiệu, đại từ, màu banner
--
-- Ba cột trên `users` (không tách bảng): chúng đi cùng hồ sơ trong **mọi** truy
-- vấn thành viên/người gửi tin, tách bảng chỉ thêm một lần JOIN để lấy ba chuỗi.
--
-- `banner_color` là màu hex 6 ký tự, **không** phải ảnh: ảnh banner cần upload,
-- resize và CDN — chưa cần cho một dải màu trang trí.
--
-- Ràng buộc nằm ở DB để dữ liệu rác không vào được kể cả khi có đường ghi mới:
--   * `bio` ≤ 190 ký tự (giới hạn Discord, đủ cho một đoạn giới thiệu);
--   * `pronouns` ≤ 40 ký tự;
--   * `banner_color` đúng `#rrggbb` chữ thường — client gán thẳng vào CSS, nhận
--     chuỗi tuỳ ý là mở đường cho `url(...)` hay `red;background:url(...)`.

BEGIN;

ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN pronouns TEXT;
ALTER TABLE users ADD COLUMN banner_color TEXT;

ALTER TABLE users ADD CONSTRAINT users_bio_length CHECK (bio IS NULL OR char_length(bio) <= 190);
ALTER TABLE users ADD CONSTRAINT users_pronouns_length
  CHECK (pronouns IS NULL OR char_length(pronouns) <= 40);
ALTER TABLE users ADD CONSTRAINT users_banner_color_format
  CHECK (banner_color IS NULL OR banner_color ~ '^#[0-9a-f]{6}$');

COMMIT;

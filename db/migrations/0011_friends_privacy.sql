-- Umaru — bạn bè + quyền riêng tư DM
--
-- Bảng `relationships` đã có từ 0001 với đủ bốn loại
-- (`friend`, `pending_out`, `pending_in`, `blocked`), nên **không cần bảng mới**
-- cho quan hệ bạn bè. Quy ước có hướng giữ nguyên như ghi chú trong 0001:
--
--   bạn bè      → HAI dòng `friend` (A→B và B→A)
--   lời mời     → `pending_out` ở người gửi, `pending_in` ở người nhận
--   chặn        → MỘT dòng `blocked` (hiệu lực hai chiều, xem src/blocks.ts)
--
-- Vì sao vẫn giữ hai dòng cho `friend` thay vì một dòng "hai chiều": mọi truy
-- vấn hiện có ("ai chặn tôi", "tôi chặn ai", danh sách bạn) đều đọc theo
-- `user_id`, một dòng hai chiều sẽ phải `OR` hai cột ở mọi chỗ và không dùng
-- được index `(user_id, type)`.
--
-- Phần mới duy nhất: quyền riêng tư DM. Mặc định `everyone` để không ai bị đổi
-- hành vi sau khi deploy — người dùng phải **tự chọn** "chỉ bạn bè".

BEGIN;

ALTER TABLE users
  ADD COLUMN dm_privacy TEXT NOT NULL DEFAULT 'everyone'
    CHECK (dm_privacy IN ('everyone', 'friends'));

-- Tra "quan hệ giữa hai người" luôn có một phía là `user_id` nên index sẵn có
-- `(user_id, target_id)` là đủ; `idx_relationships_target` phục vụ chiều ngược.

COMMIT;

-- Umaru — group DM (tối đa 10 người)
--
-- `channels.type = 'group_dm'` đã có sẵn từ 0001 (cùng ràng buộc `guild_id IS
-- NULL` như DM 1-1), `channel_members` cũng đã dùng chung cho cả hai loại. Chỉ
-- thiếu chỗ lưu **chủ nhóm** và **tên nhóm người dùng đặt**:
--
-- - `owner_id`: người tạo nhóm; chỉ chủ nhóm được mời người ra.
-- - `name`: NULL = ghép tên thành viên để hiển thị (giống Discord khi chưa đặt tên).
--
-- Bảng riêng (không thêm cột vào `channels`) để cột mới không phải NULL cho mọi
-- kênh server/DM và để ràng buộc "chỉ group DM mới có dòng ở đây" là tự nhiên.

BEGIN;

CREATE TABLE group_dms (
  channel_id BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `channel_members` không cần index mới: PK là (channel_id, user_id) nên tra theo
-- channel_id đã dùng được, còn `idx_channel_members_user` phục vụ tra theo user.

COMMIT;

-- Umaru — ghim tin nhắn (pin)
--
-- Cột `messages.pinned` đã có từ 0001 nhưng chưa từng được ghi. Danh sách ghim
-- luôn truy vấn theo `channel_id + pinned` và sắp mới nhất trước, nên thêm index
-- bộ phận: chỉ chứa tin đã ghim (vài chục dòng/kênh) và không phình theo lịch sử.
--
-- Trần số tin ghim mỗi kênh (50, giống Discord) được kiểm trong code — không
-- đặt CHECK ở đây vì đếm theo kênh không phải ràng buộc theo dòng.

CREATE INDEX IF NOT EXISTS messages_channel_pinned_idx
  ON messages (channel_id, id DESC)
  WHERE pinned;

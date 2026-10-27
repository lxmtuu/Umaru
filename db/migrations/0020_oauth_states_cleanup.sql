-- Umaru — dọn `oauth_states` hết hạn
--
-- `oauth_states` có một dòng cho **mỗi** lượt bấm "Đăng nhập bằng Google/GitHub"
-- và chỉ bị xoá khi người dùng quay về (state dùng một lần). Ai bấm rồi đóng tab
-- — hoặc bot dội `start` — để lại rác vĩnh viễn.
--
-- Không dùng cron: mỗi lần `start` xoá luôn các dòng đã hết hạn. Bảng chỉ có
-- vài nghìn dòng, và index dưới đây giữ cho `DELETE ... WHERE expires_at <= now()`
-- không phải quét cả bảng.
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);

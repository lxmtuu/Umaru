-- Umaru — trạng thái kênh thoại (G2, lớp state không cần SFU)
--
-- Đây **chưa phải** phần truyền âm thanh: bảng này chỉ ghi ai đang ở phòng
-- thoại nào, đang tự mute/deafen. Đúng lớp Discord tách riêng khỏi SFU: khi cắm
-- LiveKit Cloud vào thì token + audio chỉ việc dựa lên trạng thái có sẵn ở đây.
--
-- Vì sao khoá chính là `(user_id, guild_id)` chứ không phải `(user_id,
-- channel_id)`: mỗi người chỉ ở **một** kênh thoại trong một server tại một thời
-- điểm (giống Discord). Ràng buộc bằng PK nên không thể có trạng thái mâu thuẫn
-- do hai request join chạy song song — request sau ghi đè `channel_id`, không
-- tạo thêm dòng.
--
-- Không có cột `session_id`: trạng thái thoại tính **theo người**, không theo
-- thiết bị. Người dùng mở hai tab thì cả hai cùng thấy mình trong phòng, và
-- đóng tab này không đá tab kia ra — chỉ khi **hết mọi** session gateway của
-- người đó thì trạng thái mới bị dọn (xem `GatewayHub.sweepVoiceStates`).
--
-- Không lưu `speaking`: trạng thái đó đổi vài chục lần mỗi giây, chỉ có ý nghĩa
-- khi có audio thật; ghi xuống DB là ghi rác.

BEGIN;

CREATE TABLE voice_states (
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  self_mute   BOOLEAN NOT NULL DEFAULT false,
  self_deaf   BOOLEAN NOT NULL DEFAULT false,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, guild_id)
);

-- Đọc "ai đang trong kênh này" là truy vấn nóng nhất (mỗi lần READY, mỗi lần
-- join/leave của bất kỳ ai trong guild).
CREATE INDEX idx_voice_states_channel ON voice_states (channel_id);
-- Dọn theo thời gian khi người dùng không còn session gateway nào.
CREATE INDEX idx_voice_states_joined ON voice_states (joined_at);

-- Server có sẵn từ trước chưa có bit CONNECT/SPEAK (mặc định cũ chỉ có
-- VIEW_CHANNEL/SEND_MESSAGES/READ_HISTORY) → kênh thoại sẽ không dùng được cho
-- tới khi có người đi cấp quyền. Thêm đúng hai bit đó vào `@everyone` của mọi
-- server để hành vi khớp server tạo mới; **không** đụng role khác và không đụng
-- overwrite, nên ai đã bị deny ở cấp kênh vẫn bị chặn như cũ.
UPDATE roles
   SET permissions = (permissions::bigint | 512 | 1024)::text
 WHERE is_everyone = true;

COMMIT;

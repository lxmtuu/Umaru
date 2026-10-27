import type { DmPrivacy } from "@umaru/protocol";
import type { Pool } from "../db.js";

/**
 * Truy vấn quan hệ bạn bè — dùng chung cho route bạn bè và cổng kiểm DM privacy.
 *
 * Giữ ở một chỗ vì luật "hai dòng `friend`" rất dễ bị hiểu sai: nếu nơi kiểm
 * quyền chỉ xét `user_id = tôi` thì người bị hỏi (đang chờ tôi đồng ý) sẽ lọt
 * qua cổng privacy ở một chiều. Mọi hàm dưới đây đều xét **cả hai chiều**.
 */

/** Đã là bạn (một trong hai dòng `friend` là đủ — dữ liệu cũ có thể thiếu một dòng). */
export async function areFriends(pool: Pool, userA: string, userB: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM relationships
      WHERE type = 'friend'
        AND ((user_id = $1 AND target_id = $2) OR (user_id = $2 AND target_id = $1))
      LIMIT 1`,
    [userA, userB],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Quyền riêng tư DM của một người; không tìm thấy → `null` (route tự trả 404). */
export async function loadDmPrivacy(pool: Pool, userId: string): Promise<DmPrivacy | null> {
  const result = await pool.query<{ dm_privacy: DmPrivacy }>(
    "SELECT dm_privacy FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0]?.dm_privacy ?? null;
}

/**
 * `senderId` có được phép **mở DM mới** với `recipientId` không.
 *
 * Chỉ áp cho việc *tạo* cuộc trò chuyện. DM đã tồn tại thì vẫn mở lại và nhắn
 * tiếp được: hai người từng đồng ý nói chuyện, cắt ngang một cuộc đang có sẽ
 * làm mất lịch sử của cả hai bên và không ai xoá được tin đã gửi — cùng lý do
 * Discord để DM cũ tồn tại sau khi unfriend.
 *
 * Trả `null` = được phép; ngược lại là lý do để route dựng câu lỗi.
 */
export async function checkCanStartDm(
  pool: Pool,
  senderId: string,
  recipientId: string,
): Promise<"ok" | "friends_only"> {
  const privacy = await loadDmPrivacy(pool, recipientId);
  if (privacy === null || privacy === "everyone") return "ok";
  return (await areFriends(pool, senderId, recipientId)) ? "ok" : "friends_only";
}

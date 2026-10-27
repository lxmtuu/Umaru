import { MAX_GROUP_DM_MEMBERS, type DmChannelSummary, type Snowflake } from "@umaru/protocol";
import { loadDms } from "../bootstrap.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, notFound } from "../http.js";

/**
 * Tiện ích dùng chung cho group DM.
 *
 * Nằm riêng (không để trong `dms/routes.ts`) vì `PATCH /channels/:channelId` —
 * route đổi tên nhóm — do module guild đăng ký: không thể đăng ký trùng path
 * trong cùng scope Fastify, nên route đó gọi helper ở đây khi kênh là group DM.
 */

/** Trần số người trong một group DM (tính cả người tạo) — giống Discord. */
export const GROUP_MEMBER_LIMIT = MAX_GROUP_DM_MEMBERS;

export interface GroupChannelRow {
  id: string;
  type: "dm" | "group_dm";
  guild_id: string | null;
}

/**
 * Kênh phải là `group_dm` và người gọi phải là thành viên.
 * Không phải thành viên → 404 (không lộ sự tồn tại), giống các route DM khác.
 */
export async function loadGroupChannel(
  pool: Pool,
  channelId: string,
  userId: string,
): Promise<GroupChannelRow> {
  if (!/^\d{1,20}$/.test(channelId)) throw badRequest("channelId phải là snowflake");
  const result = await pool.query<GroupChannelRow & { member: string | null }>(
    `SELECT c.id, c.type, c.guild_id, cm.user_id AS member
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
      WHERE c.id = $1`,
    [channelId, userId],
  );
  const row = result.rows[0];
  if (row === undefined || row.member === null) throw notFound("Kênh không tồn tại");
  if (row.type !== "group_dm") throw badRequest("Kênh này không phải group DM");
  return row;
}

/**
 * Summary một cuộc trò chuyện riêng dưới góc nhìn của `userId` (`recipients` loại
 * trừ chính họ). Trả null nếu người đó không còn trong cuộc.
 */
export async function loadDmSummary(
  pool: Pool,
  channelId: string,
  userId: string,
): Promise<DmChannelSummary | null> {
  const dms = await loadDms(pool, userId as Snowflake);
  return dms.find((dm) => (dm.channel.id as string) === channelId) ?? null;
}

/** Gửi lại summary cho mọi thành viên còn lại (tên hoặc thành viên vừa đổi). */
export async function broadcastGroupUpdate(
  pool: Pool,
  publisher: EventPublisher,
  channelId: string,
): Promise<void> {
  const members = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM channel_members WHERE channel_id = $1",
    [channelId],
  );
  for (const row of members.rows) {
    const summary = await loadDmSummary(pool, channelId, row.user_id);
    if (summary !== null) publisher.publishToUser(row.user_id, "DM_CHANNEL_UPDATE", summary);
  }
}

/**
 * Đổi tên nhóm. Mọi thành viên đều đổi được (giống Discord); `null` hoặc chuỗi
 * rỗng = bỏ tên → client quay lại ghép tên thành viên.
 */
export async function renameGroupDm(
  pool: Pool,
  publisher: EventPublisher,
  channelId: string,
  rawName: unknown,
): Promise<void> {
  let name: string | null = null;
  if (typeof rawName === "string") {
    name = rawName.trim();
    if ([...name].length > 100) throw badRequest("Tên nhóm tối đa 100 ký tự");
    if (name.length === 0) name = null;
  }
  await pool.query("UPDATE group_dms SET name = $2 WHERE channel_id = $1", [channelId, name]);
  await pool.query("UPDATE channels SET name = $2, updated_at = now() WHERE id = $1", [
    channelId,
    name,
  ]);
  await broadcastGroupUpdate(pool, publisher, channelId);
}

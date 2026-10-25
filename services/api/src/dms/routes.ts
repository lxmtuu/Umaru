import {
  createSnowflake,
  MAX_GROUP_DM_MEMBERS,
  type DmChannelSummary,
  type GuildMemberSummary,
  type Snowflake,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { isBlockedBetween } from "../blocks.js";
import { checkCanStartDm } from "../friends/relations.js";
import { HttpError, badRequest, forbidden, notFound, readId } from "../http.js";
import { loadDms } from "../bootstrap.js";
import {
  broadcastGroupUpdate,
  loadDmSummary,
  loadGroupChannel,
} from "./group.js";

export interface DmDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

interface UserSummaryRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export function registerDmRoutes(app: FastifyInstance, deps: DmDeps): void {
  const { pool, config, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);

  /** Danh sách cuộc trò chuyện riêng của tôi (DM 1-1 + group DM), mới nhất trước. */
  app.get("/users/@me/channels", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    return reply.send(await loadDms(pool, userId as Snowflake));
  });

  /**
   * Mở DM/groups DM.
   *
   * - `{ recipientId }` → DM 1-1 (hành vi cũ, trả lại kênh nếu đã có).
   * - `{ recipientIds: [...] }` → **group DM** mới với những người này (kể cả
   *   mình: tối đa `MAX_GROUP_DM_MEMBERS`). Không "gộp" vào nhóm đang có vì
   *   người tạo muốn một cuộc mới; bấm lại với đúng nhóm cũ vẫn tạo nhóm mới —
   *   chấp nhận được, giống cách Discord không tự gộp.
   */
  app.post("/users/@me/channels", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = request.body as Record<string, unknown> | undefined;

    if (Array.isArray(body?.recipientIds)) {
      return reply.code(201).send(await createGroupDm(pool, config, publisher, userId, body));
    }

    const recipientId = readId(body, "recipientId");
    if (recipientId === null) throw badRequest("Thiếu recipientId (hoặc recipientIds)");
    if (recipientId === userId) throw badRequest("Không thể tự nhắn cho mình");
    // Chặn một chiều cũng đủ để cắt liên lạc hai chiều (xem src/blocks.ts).
    if (await isBlockedBetween(pool, userId, recipientId)) {
      throw forbidden("Không thể nhắn tin với người này");
    }

    const recipientRow = await loadUserRow(pool, recipientId);

    // Quyền riêng tư DM: chỉ chặn việc **mở cuộc mới**. Nếu kênh đã tồn tại thì
    // bên dưới trả lại kênh cũ — cắt ngang một cuộc đang có sẽ làm mất lịch sử
    // của cả hai bên, và tin đã gửi thì không ai thu hồi được (xem friends/relations.ts).
    const existingChannel = await findDmChannel(pool, userId, recipientId);
    if (existingChannel === null) {
      const verdict = await checkCanStartDm(pool, userId, recipientId);
      if (verdict === "friends_only") {
        throw forbidden("Người này chỉ nhận tin nhắn từ bạn bè");
      }
    }

    const client = await pool.connect();
    let channelId: string;
    let created: boolean;
    try {
      await client.query("BEGIN");
      // Khóa theo cặp (nhỏ trước, lớn sau) — mọi luồng mở DM cùng cặp đều xếp hàng.
      const pair = [userId, recipientId].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dm:${pair[0]}:${pair[1]}`]);

      const existing = await client.query<{ id: string }>(
        `SELECT c.id
           FROM channels c
           JOIN channel_members a ON a.channel_id = c.id AND a.user_id = $1
           JOIN channel_members b ON b.channel_id = c.id AND b.user_id = $2
          WHERE c.type = 'dm' AND c.guild_id IS NULL
          LIMIT 1`,
        [pair[0], pair[1]],
      );

      if (existing.rows[0] !== undefined) {
        channelId = existing.rows[0].id;
        created = false;
      } else {
        channelId = createSnowflake(config.workerId);
        await client.query(
          `INSERT INTO channels (id, guild_id, type, name, position) VALUES ($1, NULL, 'dm', NULL, 0)`,
          [channelId],
        );
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
          [channelId, userId, recipientId],
        );
        created = true;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const summary: DmChannelSummary = {
      channel: {
        id: channelId as Snowflake,
        guildId: null,
        type: "dm",
        name: null,
        topic: null,
        categoryId: null,
        position: 0,
      },
      recipient: toSummary(recipientRow),
      recipients: [toSummary(recipientRow)],
      ownerId: null,
      name: null,
    };

    if (created) {
      // Session hai bên phải được phép nhận fan-out ngay, kể cả khi vừa mở.
      publisher.grantChannelAccess(channelId, [userId, recipientId]);
      // Chỉ báo khi cuộc trò chuyện mới thật sự được tạo. Mở lại DM cũ mà vẫn
      // bắn event sẽ làm client bên kia nhảy vào cuộc (và xoá badge chưa đọc).
      publisher.publishToUser(recipientId, "DM_CHANNEL_CREATE", {
        ...summary,
        recipient: await loadSummary(pool, userId),
        recipients: [await loadSummary(pool, userId)],
      });
    }

    return reply.code(created ? 201 : 200).send(summary);
  });

  /** Thêm người vào group DM (mọi thành viên đều được mời, tối đa 10). */
  app.post<{ Params: { channelId: string } }>(
    "/channels/:channelId/recipients",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const group = await loadGroupChannel(pool, request.params.channelId, userId);

      const body = request.body as Record<string, unknown> | undefined;
      const targetId = readId(body, "userId");
      if (targetId === null) throw badRequest("Thiếu userId");
      if (targetId === userId) throw badRequest("Bạn đã ở trong nhóm này");

      // Không kéo người mà mình đang chặn (hoặc đang chặn mình) vào cùng nhóm.
      if (await isBlockedBetween(pool, userId, targetId)) {
        throw forbidden("Không thể thêm người này");
      }
      await loadUserRow(pool, targetId);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Khoá kênh để hai lời mời song song không vượt trần.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`group:${group.id}`]);
        const members = await client.query<{ user_id: string }>(
          "SELECT user_id FROM channel_members WHERE channel_id = $1",
          [group.id],
        );
        const already = members.rows.some((row) => row.user_id === targetId);
        if (!already && members.rows.length >= MAX_GROUP_DM_MEMBERS) {
          throw badRequest(`Nhóm đã đủ ${MAX_GROUP_DM_MEMBERS} người`);
        }
        if (!already) {
          await client.query(
            "INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)",
            [group.id, targetId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const summary = await loadDmSummary(pool, group.id, userId);
      if (summary === null) throw notFound("Nhóm không tồn tại");
      // Người mới phải nhận được fan-out ngay và thấy nhóm trong sidebar.
      publisher.grantChannelAccess(group.id, [targetId]);
      publisher.publishToUser(targetId, "DM_CHANNEL_CREATE", summary);
      await broadcastGroupUpdate(pool, publisher, group.id);
      return reply.code(201).send(summary);
    },
  );

  /**
   * Rời nhóm (`DELETE …/recipients/@me`) hoặc mời một người ra (chỉ chủ nhóm).
   *
   * Tham số tên `target` (không phải `userId`) vì hook `preValidation` toàn cục
   * đòi mọi `*Id` phải là snowflake số — `@me` sẽ bị chặn trước khi vào route.
   *
   * Người cuối cùng rời đi → xoá kênh (cascade xoá tin + channel_members) và bỏ
   * file đính kèm trên đĩa, vì không còn ai sở hữu nội dung đó.
   */
  app.delete<{ Params: { channelId: string; target: string } }>(
    "/channels/:channelId/recipients/:target",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const group = await loadGroupChannel(pool, request.params.channelId, userId);
      const targetId = request.params.target === "@me" ? userId : request.params.target;
      if (!/^\d{1,20}$/.test(targetId)) throw badRequest("userId phải là snowflake");

      if (targetId !== userId) {
        const owner = await pool.query<{ owner_id: string }>(
          "SELECT owner_id FROM group_dms WHERE channel_id = $1",
          [group.id],
        );
        if (owner.rows[0]?.owner_id !== userId) {
          throw forbidden("Chỉ chủ nhóm mới mời được người khác ra");
        }
      }

      const removed = await pool.query(
        "DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        [group.id, targetId],
      );
      if (removed.rowCount === 0) throw notFound("Người này không ở trong nhóm");

      const left = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM channel_members WHERE channel_id = $1",
        [group.id],
      );

      if (left.rows.length === 0) {
        const attachments = await pool.query<{ id: string }>(
          `SELECT a.id FROM attachments a
             JOIN messages m ON m.id = a.message_id
            WHERE m.channel_id = $1`,
          [group.id],
        );
        await pool.query("DELETE FROM channels WHERE id = $1", [group.id]);
        const { removeUpload } = await import("../uploads/storage.js");
        await Promise.all(attachments.rows.map((row) => removeUpload(config.uploadsDir, row.id)));
      } else {
        // Session của người bị mời ra phải thôi nhận message của kênh này ngay.
        // `refreshUserVisibility` tính lại từ DB nên đá luôn kênh khỏi
        // `visibleChannels` và phát CHANNEL_DELETE (guildId null → client hiểu
        // là bỏ DM khỏi sidebar).
        await publisher.refreshUserVisibility(targetId);
        await broadcastGroupUpdate(pool, publisher, group.id);
      }

      return reply.code(204).send();
    },
  );

  // ---------- nội bộ ----------

  /**
   * Tạo group DM: kiểm trần số người, chặn tự thêm mình hai lần / người không
   * tồn tại / người đang chặn mình, rồi ghi kênh + thành viên + group_dms trong
   * một transaction.
   */
  async function createGroupDm(
    pool: Pool,
    config: Config,
    publisher: EventPublisher,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<DmChannelSummary> {
    const raw = body.recipientIds as unknown[];
    const ids: string[] = [];
    for (const value of raw) {
      if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
        throw badRequest("recipientIds phải là mảng snowflake (chuỗi số)");
      }
      if (value === userId) throw badRequest("Không cần thêm chính mình vào nhóm");
      if (!ids.includes(value)) ids.push(value);
    }
    if (ids.length < 2) {
      throw badRequest("Group DM cần ít nhất 2 người khác (dùng recipientId cho DM 1-1)");
    }
    if (ids.length + 1 > MAX_GROUP_DM_MEMBERS) {
      throw badRequest(`Group DM tối đa ${MAX_GROUP_DM_MEMBERS} người`);
    }

    for (const id of ids) {
      await loadUserRow(pool, id);
      if (await isBlockedBetween(pool, userId, id)) {
        throw forbidden("Không thể thêm người đang chặn bạn (hoặc bạn đang chặn)");
      }
    }

    const channelId = createSnowflake(config.workerId);
    // Cùng một tên ghi vào cả `channels.name` (hiển thị) và `group_dms.name`
    // (nguồn của `summary.name`) — lệch nhau là sidebar và panel nói khác nhau.
    let name: string | null = null;
    if (typeof body.name === "string" && body.name.trim().length > 0) {
      name = body.name.trim().slice(0, 100);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO channels (id, guild_id, type, name, position) VALUES ($1, NULL, 'group_dm', $2, 0)`,
        [channelId, name],
      );
      await client.query(
        `INSERT INTO channel_members (channel_id, user_id)
         SELECT $1, u FROM unnest($2::bigint[]) AS u`,
        [channelId, [userId, ...ids]],
      );
      await client.query(
        "INSERT INTO group_dms (channel_id, owner_id, name) VALUES ($1, $2, $3)",
        [channelId, userId, name],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const summary = await loadDmSummary(pool, channelId, userId);
    if (summary === null) throw new Error("Không đọc được nhóm vừa tạo");

    publisher.grantChannelAccess(channelId, [userId, ...ids]);
    for (const id of ids) {
      // Mỗi người nhận summary theo góc nhìn của chính họ (recipients loại trừ mình).
      const theirs = await loadDmSummary(pool, channelId, id);
      if (theirs !== null) publisher.publishToUser(id, "DM_CHANNEL_CREATE", theirs);
    }
    return summary;
  }

}

/**
 * DM 1-1 đã tồn tại giữa hai người chưa (không khoá — chỉ để quyết định có áp
 * cổng privacy hay không; việc tạo kênh vẫn nằm trong transaction có advisory lock).
 */
async function findDmChannel(
  pool: Pool,
  userA: string,
  userB: string,
): Promise<{ id: string } | null> {
  const pair = [userA, userB].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const result = await pool.query<{ id: string }>(
    `SELECT c.id
       FROM channels c
       JOIN channel_members a2 ON a2.channel_id = c.id AND a2.user_id = $1
       JOIN channel_members b2 ON b2.channel_id = c.id AND b2.user_id = $2
      WHERE c.type = 'dm' AND c.guild_id IS NULL
      LIMIT 1`,
    [pair[0], pair[1]],
  );
  return result.rows[0] ?? null;
}

async function loadUserRow(pool: Pool, userId: string): Promise<UserSummaryRow> {
  const result = await pool.query<UserSummaryRow>(
    "SELECT id, username, display_name, avatar_url FROM users WHERE id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound("Người dùng không tồn tại");
  return row;
}

async function loadSummary(pool: Pool, userId: string): Promise<GuildMemberSummary> {
  return toSummary(await loadUserRow(pool, userId));
}

function toSummary(row: UserSummaryRow): GuildMemberSummary {
  return {
    userId: row.id as Snowflake,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    // DM không thuộc server nào → không có role để hiện.
    roleIds: [],
  };
}

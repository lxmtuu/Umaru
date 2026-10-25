import {
  createSnowflake,
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
import { badRequest, notFound, readId } from "../http.js";
import { loadDms } from "../bootstrap.js";

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

  /** Danh sách DM của tôi, mới nhất trước. */
  app.get("/users/@me/channels", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    return reply.send(await loadDms(pool, userId as Snowflake));
  });

  /**
   * Mở (hoặc lấy lại) DM 1-1 với một user. Advisory lock theo cặp id để hai
   * request song song không tạo hai kênh trùng cho cùng một cặp người.
   */
  app.post("/users/@me/channels", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = request.body as Record<string, unknown> | undefined;
    const recipientId = readId(body, "recipientId");
    if (recipientId === null) throw badRequest("Thiếu recipientId");
    if (recipientId === userId) throw badRequest("Không thể tự nhắn cho mình");

    const recipientResult = await pool.query<UserSummaryRow>(
      "SELECT id, username, display_name, avatar_url FROM users WHERE id = $1",
      [recipientId],
    );
    const recipientRow = recipientResult.rows[0];
    if (recipientRow === undefined) throw notFound("Người dùng không tồn tại");

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
    };

    if (created) {
      // Session hai bên phải được phép nhận fan-out ngay, kể cả khi vừa mở.
      publisher.grantChannelAccess(channelId, [userId, recipientId]);
      // Chỉ báo khi cuộc trò chuyện mới thật sự được tạo. Mở lại DM cũ mà vẫn
      // bắn event sẽ làm client bên kia nhảy vào cuộc (và xoá badge chưa đọc).
      publisher.publishToUser(recipientId, "DM_CHANNEL_CREATE", {
        channel: summary.channel,
        recipient: await loadSummary(pool, userId),
      });
    }

    return reply.code(created ? 201 : 200).send(summary);
  });
}

async function loadSummary(pool: Pool, userId: string): Promise<GuildMemberSummary> {
  const result = await pool.query<UserSummaryRow>(
    "SELECT id, username, display_name, avatar_url FROM users WHERE id = $1",
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound("Người dùng không tồn tại");
  return toSummary(row);
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

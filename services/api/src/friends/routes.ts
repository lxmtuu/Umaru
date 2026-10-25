import {
  type DmPrivacy,
  type FriendList,
  type FriendRequestSummary,
  type FriendSummary,
  type Snowflake,
  type UserProfile,
  type UserSettings,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import { isBlockedBetween } from "../blocks.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import { BucketStore } from "../rateLimit.js";

export interface FriendDeps {
  pool: Pool;
  tokens: TokenService;
  publisher: EventPublisher;
}

/** Trần lời mời đang chờ một người được giữ (chống biến tài khoản thành máy spam). */
export const MAX_OUTGOING_REQUESTS = 50;

interface ProfileRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

const PROFILE_COLUMNS = "u.id, u.username, u.display_name, u.avatar_url";

function toProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id as Snowflake,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

/**
 * Bạn bè + quyền riêng tư DM.
 *
 * Quan hệ nằm trong bảng `relationships` có sẵn (xem migration 0011): bạn bè =
 * **hai** dòng `friend`, lời mời = `pending_out` (người gửi) + `pending_in`
 * (người nhận). `blocked` đã có từ trước và **cắt luôn** quan hệ bạn bè — block
 * phải thắng friend, nếu không hai nguồn nói hai điều khác nhau.
 */
export function registerFriendRoutes(app: FastifyInstance, deps: FriendDeps): void {
  const { pool, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);
  /** 20 lời mời/phút — đủ cho thao tác thật, chặn được script dò username. */
  const requestBuckets = new BucketStore(20, 60_000);

  async function loadSettings(userId: string): Promise<UserSettings> {
    const result = await pool.query<{ dm_privacy: DmPrivacy }>(
      "SELECT dm_privacy FROM users WHERE id = $1",
      [userId],
    );
    return { dmPrivacy: result.rows[0]?.dm_privacy ?? "everyone" };
  }

  async function profileOf(id: string): Promise<UserProfile> {
    const result = await pool.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("Người dùng không tồn tại");
    return toProfile(row);
  }

  /** Toàn bộ trạng thái quan hệ của tôi: bạn bè + hai chiều lời mời + cài đặt. */
  async function loadFriendList(userId: string): Promise<FriendList> {
    const [friendsResult, incomingResult, outgoingResult, settings] = await Promise.all([
      pool.query<ProfileRow & { since: Date }>(
        `SELECT ${PROFILE_COLUMNS}, r.created_at AS since
           FROM relationships r
           JOIN users u ON u.id = r.target_id
          WHERE r.user_id = $1 AND r.type = 'friend'
          ORDER BY r.created_at DESC, u.id`,
        [userId],
      ),
      pool.query<ProfileRow & { created_at: Date }>(
        `SELECT ${PROFILE_COLUMNS}, r.created_at
           FROM relationships r
           JOIN users u ON u.id = r.target_id
          WHERE r.user_id = $1 AND r.type = 'pending_in'
          ORDER BY r.created_at DESC, u.id`,
        [userId],
      ),
      pool.query<ProfileRow & { created_at: Date }>(
        `SELECT ${PROFILE_COLUMNS}, r.created_at
           FROM relationships r
           JOIN users u ON u.id = r.target_id
          WHERE r.user_id = $1 AND r.type = 'pending_out'
          ORDER BY r.created_at DESC, u.id`,
        [userId],
      ),
      loadSettings(userId),
    ]);

    return {
      dmPrivacy: settings.dmPrivacy,
      friends: friendsResult.rows.map((row): FriendSummary => ({
        user: toProfile(row),
        since: row.since.toISOString(),
      })),
      incoming: incomingResult.rows.map((row): FriendRequestSummary => ({
        user: toProfile(row),
        createdAt: row.created_at.toISOString(),
      })),
      outgoing: outgoingResult.rows.map((row): FriendRequestSummary => ({
        user: toProfile(row),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  /** Ghi hai dòng `friend` trong một transaction — hai bên luôn khớp hoặc cùng lỗi. */
  async function makeFriends(a: string, b: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        await client.query(
          `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'friend')
           ON CONFLICT (user_id, target_id) DO UPDATE SET type = 'friend', created_at = now()`,
          [from, to],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  app.get("/users/@me/friends", { preHandler: guard }, async (request, reply) => {
    return reply.send(await loadFriendList(requireUserId(request)));
  });

  /**
   * Gửi lời mời kết bạn bằng **username** (không phải id): người dùng biết
   * `@username` của nhau chứ không biết snowflake.
   *
   * Nếu người kia **đã** mời mình trước thì gửi lại chính là đồng ý → kết bạn
   * luôn (200), tránh cảnh hai người gửi chéo rồi chờ vô vọng.
   */
  app.post("/users/@me/friends", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const wait = requestBuckets.take(userId);
    if (wait !== null) {
      return reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "Gửi lời mời quá nhanh" },
        retry_after: wait,
      });
    }

    const rawUsername = (request.body as { username?: unknown } | undefined)?.username;
    if (typeof rawUsername !== "string" || rawUsername.trim().length === 0) {
      throw badRequest("Thiếu username");
    }
    const username = rawUsername.trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) throw badRequest("Username không hợp lệ");

    const targetResult = await pool.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM users u WHERE u.username = $1`,
      [username],
    );
    const target = targetResult.rows[0];
    if (target === undefined) throw notFound("Không tìm thấy người dùng này");
    if (target.id === userId) throw badRequest("Không thể tự kết bạn với chính mình");
    if (await isBlockedBetween(pool, userId, target.id)) {
      // Không nói ai chặn ai — chỉ nói không gửi được.
      throw forbidden("Không thể kết bạn với người này");
    }

    const mine = await pool.query<{ type: string }>(
      "SELECT type FROM relationships WHERE user_id = $1 AND target_id = $2",
      [userId, target.id],
    );
    if (mine.rows[0]?.type === "friend") throw conflict("Hai bạn đã là bạn bè");

    if (mine.rows[0]?.type === "pending_out") throw conflict("Bạn đã gửi lời mời cho người này");

    // Dòng của **mình** là `pending_in` nghĩa là họ đã mời mình trước → gửi lại
    // chính là đồng ý. (Đọc dòng của họ sẽ sai: dòng `pending_in` ở phía họ là
    // "họ đang nhận lời mời", tức là mình mời trước.)
    if (mine.rows[0]?.type === "pending_in") {
      await makeFriends(userId, target.id);
      const since = new Date().toISOString();
      publisher.publishToUser(target.id, "FRIEND_ADD", {
        user: await profileOf(userId),
        since,
      });
      return reply.code(200).send({ user: toProfile(target), since } satisfies FriendSummary);
    }

    const pendingCount = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM relationships WHERE user_id = $1 AND type = 'pending_out'",
      [userId],
    );
    if (Number(pendingCount.rows[0]?.count ?? 0) >= MAX_OUTGOING_REQUESTS) {
      throw conflict("Bạn đang có quá nhiều lời mời chờ — hãy huỷ bớt trước");
    }

    const createdAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'pending_out')
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 'pending_out', created_at = now()`,
      [userId, target.id],
    );
    await pool.query(
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'pending_in')
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 'pending_in', created_at = now()`,
      [target.id, userId],
    );

    // Event cho người nhận phải mang **người gửi** (họ cần biết ai mời mình);
    // còn response cho người gửi mang **người được mời** để khớp tab "đã gửi".
    publisher.publishToUser(target.id, "FRIEND_REQUEST_CREATE", {
      user: await profileOf(userId),
      createdAt,
    } satisfies FriendRequestSummary);
    return reply.code(201).send({ user: toProfile(target), createdAt } satisfies FriendRequestSummary);
  });

  /**
   * Đồng ý lời mời. Phải có `pending_in` — nếu không thì người gọi đang cố tự
   * chấp nhận lời mời **mình** gửi, và hai bên sẽ lệch trạng thái.
   */
  app.post<{ Params: { userId: string } }>(
    "/users/@me/friends/:userId/accept",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const otherId = request.params.userId;
      if (otherId === userId) throw badRequest("Không thể tự kết bạn với chính mình");

      const pending = await pool.query(
        "SELECT 1 FROM relationships WHERE user_id = $1 AND target_id = $2 AND type = 'pending_in'",
        [userId, otherId],
      );
      if (pending.rowCount === 0) throw notFound("Không có lời mời kết bạn từ người này");
      if (await isBlockedBetween(pool, userId, otherId)) {
        throw forbidden("Không thể kết bạn với người này");
      }

      await makeFriends(userId, otherId);
      const since = new Date().toISOString();
      const [me, other] = await Promise.all([profileOf(userId), profileOf(otherId)]);
      publisher.publishToUser(otherId, "FRIEND_ADD", { user: me, since });
      return reply.send({ user: other, since } satisfies FriendSummary);
    },
  );

  /**
   * Xoá quan hệ một chiều: dùng cho **bốn** thao tác khác nhau vì kết quả cuối
   * cùng giống hệt — không còn dòng quan hệ nào giữa hai người:
   * huỷ kết bạn, từ chối lời mời, huỷ lời mời đã gửi, và (dự phòng) dọn lời mời
   * treo. Tách thành bốn route sẽ chỉ nhân bản cùng một câu `DELETE`.
   */
  app.delete<{ Params: { userId: string } }>(
    "/users/@me/friends/:userId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const otherId = request.params.userId;
      if (otherId === userId) throw badRequest("Không thể tự xoá quan hệ với chính mình");

      const existing = await pool.query<{ type: string }>(
        "SELECT type FROM relationships WHERE user_id = $1 AND target_id = $2",
        [userId, otherId],
      );
      const type = existing.rows[0]?.type;
      if (type === undefined) return reply.code(204).send(); // idempotent

      await pool.query(
        "DELETE FROM relationships WHERE (user_id = $1 AND target_id = $2) OR (user_id = $2 AND target_id = $1)",
        [userId, otherId],
      );
      // Chỉ báo khi thật sự có quan hệ bị xoá; xoá lại lần hai không bắn event rác.
      publisher.publishToUser(otherId, "FRIEND_REMOVE", { userId: userId as Snowflake });
      return reply.code(204).send();
    },
  );

  /**
   * Quyền riêng tư DM. Đổi xong phát `USER_SETTINGS_UPDATE` cho **mọi session của
   * chính mình** (tab khác, điện thoại) để UI đồng bộ mà không phải tải lại.
   */
  app.patch("/users/@me/settings", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const raw = (request.body as { dmPrivacy?: unknown } | undefined)?.dmPrivacy;
    if (raw === undefined) throw badRequest("Thiếu dmPrivacy");
    if (raw !== "everyone" && raw !== "friends") {
      throw badRequest('dmPrivacy phải là "everyone" hoặc "friends"');
    }

    await pool.query("UPDATE users SET dm_privacy = $2, updated_at = now() WHERE id = $1", [
      userId,
      raw,
    ]);
    const settings: UserSettings = { dmPrivacy: raw };
    publisher.publishToUser(userId, "USER_SETTINGS_UPDATE", settings);
    return reply.send(settings);
  });
}

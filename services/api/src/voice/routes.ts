import {
  Permission,
  hasPermission,
  type Snowflake,
  type VoiceState,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { loadChannelContext } from "../access.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, forbidden, notFound } from "../http.js";

export interface VoiceDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

interface VoiceStateRow {
  guild_id: string;
  channel_id: string;
  user_id: string;
  self_mute: boolean;
  self_deaf: boolean;
  joined_at: Date;
}

function mapVoiceState(row: VoiceStateRow): VoiceState {
  return {
    guildId: row.guild_id as Snowflake,
    channelId: row.channel_id as Snowflake,
    userId: row.user_id as Snowflake,
    selfMute: row.self_mute,
    selfDeaf: row.self_deaf,
    joinedAt: row.joined_at.toISOString(),
  };
}

/**
 * Cửa sổ cho giới hạn join/leave/mute: một client lỗi không được quay vòng
 * join→leave vài trăm lần/giây làm mọi thành viên guild nhận event rác.
 * Số lần mỗi cửa sổ lấy từ config (`RATE_LIMIT_VOICE_MUTATIONS`, mặc định 10)
 * để test nghiệp vụ không phải chờ, còn test giới hạn hạ trần xuống.
 */
const VOICE_MUTATION_WINDOW_MS = 10_000;

/**
 * Trạng thái kênh thoại (G2 — **chưa truyền âm thanh**).
 *
 * Đây là lớp state: ai đang ở phòng nào, tự mute/deafen. Quyền `CONNECT` quyết
 * định ai vào được; `VIEW_CHANNEL` quyết định ai **thấy** danh sách người trong
 * phòng (lọc ở `loadVoiceStates` khi READY và ở `publishVoiceState` khi phát).
 * Khi cắm SFU (LiveKit) thì chỉ cần thêm token phòng + audio, không phải sửa
 * mô hình dữ liệu này.
 */
export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceDeps): void {
  const { pool, config, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);

  /**
   * Đếm thao tác theo user. Không dùng `BucketStore` có sẵn ở đây vì cửa sổ
   * 10 giây/10 lần khác hẳn các trần trong spec §7 — nhưng cùng tinh thần:
   * chặn bằng 429 kèm `retry_after` để client biết chờ bao lâu.
   */
  const mutations = new Map<string, number[]>();
  const takeMutation = (userId: string): number | null => {
    const now = Date.now();
    const recent = (mutations.get(userId) ?? []).filter((at) => now - at < VOICE_MUTATION_WINDOW_MS);
    if (recent.length >= config.rateLimitVoiceMutations) {
      mutations.set(userId, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((VOICE_MUTATION_WINDOW_MS - (now - oldest)) / 1000));
    }
    recent.push(now);
    mutations.set(userId, recent);
    return null;
  };

  /** Tìm kênh thoại + kiểm quyền; dùng chung cho join và leave. */
  async function loadVoiceChannel(userId: Snowflake, channelId: string, needConnect: boolean) {
    const context = await loadChannelContext(pool, userId, channelId, Permission.VIEW_CHANNEL);
    if (context.channel.guild_id === null || context.guild === null) {
      throw badRequest("Kênh thoại phải thuộc một server");
    }
    if (context.channel.type !== "guild_voice") {
      throw badRequest("Kênh này không phải kênh thoại");
    }
    if (needConnect && !hasPermission(context.permissions, Permission.CONNECT)) {
      // Fail-closed: thiếu CONNECT là không vào được, kể cả khi xem được kênh.
      throw forbidden("Bạn không có quyền vào kênh thoại này");
    }
    return { guildId: context.channel.guild_id, context };
  }

  /** Trạng thái hiện tại của user trong một guild (null = không ở phòng nào). */
  async function currentState(userId: Snowflake, guildId: string): Promise<VoiceState | null> {
    const result = await pool.query<VoiceStateRow>(
      "SELECT guild_id, channel_id, user_id, self_mute, self_deaf, joined_at FROM voice_states WHERE user_id = $1 AND guild_id = $2",
      [userId, guildId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapVoiceState(row);
  }

  /** Phát trạng thái mới cho người xem được kênh + chính người đó. */
  function announce(state: VoiceState, channelId: string): void {
    publisher.publishVoiceState(channelId, {
      guildId: state.guildId,
      channelId: state.channelId,
      userId: state.userId,
      selfMute: state.selfMute,
      selfDeaf: state.selfDeaf,
      joinedAt: state.joinedAt,
    });
  }

  /**
   * Vào phòng thoại. Gọi lại nhiều lần là idempotent (cùng kênh → giữ nguyên
   * `joinedAt`); đổi kênh thì tự rời kênh cũ trước — mỗi người chỉ ở một phòng
   * mỗi server.
   */
  app.put(
    "/channels/:channelId/voice",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channelId } = request.params as { channelId: string };
      const { guildId } = await loadVoiceChannel(userId, channelId, true);

      const wait = takeMutation(userId);
      if (wait !== null) {
        return reply
          .code(429)
          .send({ error: { code: "RATE_LIMITED", message: "Thao tác quá nhanh" }, retry_after: wait });
      }

      const body = (request.body ?? {}) as { selfMute?: unknown; selfDeaf?: unknown };
      const selfMute = body.selfMute === true;
      const selfDeaf = body.selfDeaf === true;

      const previous = await currentState(userId, guildId);
      const result = await pool.query<VoiceStateRow>(
        `INSERT INTO voice_states (guild_id, user_id, channel_id, self_mute, self_deaf)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, guild_id) DO UPDATE
              SET channel_id = EXCLUDED.channel_id,
                  self_mute = EXCLUDED.self_mute,
                  self_deaf = EXCLUDED.self_deaf,
                  -- Giữ nguyên mốc vào phòng khi gọi lại cùng kênh; đổi kênh là
                  -- vào phòng mới nên đặt lại.
                  joined_at = CASE
                    WHEN voice_states.channel_id = EXCLUDED.channel_id THEN voice_states.joined_at
                    ELSE now()
                  END
          RETURNING guild_id, channel_id, user_id, self_mute, self_deaf, joined_at`,
        [guildId, userId, channelId, selfMute, selfDeaf],
      );
      const state = mapVoiceState(result.rows[0]!);

      // Rời kênh cũ **trước** khi báo vào kênh mới để client không hiện hai chỗ.
      if (previous !== null && previous.channelId !== state.channelId) {
        publisher.publishVoiceState(previous.channelId, {
          guildId: previous.guildId,
          channelId: null,
          userId,
          selfMute: previous.selfMute,
          selfDeaf: previous.selfDeaf,
          joinedAt: previous.joinedAt,
        });
      }
      announce(state, state.channelId);
      return reply.code(200).send(state);
    },
  );

  /** Rời phòng thoại. Idempotent: không ở trong phòng cũng trả 204. */
  app.delete(
    "/channels/:channelId/voice",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channelId } = request.params as { channelId: string };
      await loadVoiceChannel(userId, channelId, false);

      const wait = takeMutation(userId);
      if (wait !== null) {
        return reply
          .code(429)
          .send({ error: { code: "RATE_LIMITED", message: "Thao tác quá nhanh" }, retry_after: wait });
      }

      // Chỉ xoá khi đang ở **đúng** kênh này: gọi leave cho kênh khác không được
      // đá người ta ra khỏi phòng họ đang ngồi.
      const result = await pool.query<VoiceStateRow>(
        "DELETE FROM voice_states WHERE user_id = $1 AND channel_id = $2 RETURNING guild_id, channel_id, user_id, self_mute, self_deaf, joined_at",
        [userId, channelId],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        emitLeave(publisher, row, userId);
      }
      return reply.code(204).send();
    },
  );

  /** Tự mute/deafen. Chỉ đổi được trạng thái của chính mình. */
  app.patch(
    "/guilds/:guildId/voice-state",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { guildId } = request.params as { guildId: string };
      const body = (request.body ?? {}) as { selfMute?: unknown; selfDeaf?: unknown };
      if (body.selfMute === undefined && body.selfDeaf === undefined) {
        throw badRequest("Cần ít nhất một trong selfMute, selfDeaf");
      }
      if (body.selfMute !== undefined && typeof body.selfMute !== "boolean") {
        throw badRequest("selfMute phải là boolean");
      }
      if (body.selfDeaf !== undefined && typeof body.selfDeaf !== "boolean") {
        throw badRequest("selfDeaf phải là boolean");
      }

      const wait = takeMutation(userId);
      if (wait !== null) {
        return reply
          .code(429)
          .send({ error: { code: "RATE_LIMITED", message: "Thao tác quá nhanh" }, retry_after: wait });
      }

      const result = await pool.query<VoiceStateRow>(
        `UPDATE voice_states
            SET self_mute = COALESCE($3, self_mute),
                self_deaf = COALESCE($4, self_deaf)
          WHERE user_id = $1 AND guild_id = $2
      RETURNING guild_id, channel_id, user_id, self_mute, self_deaf, joined_at`,
        [
          userId,
          guildId,
          body.selfMute === undefined ? null : (body.selfMute as boolean),
          body.selfDeaf === undefined ? null : (body.selfDeaf as boolean),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw notFound("Bạn không ở trong kênh thoại nào của server này");

      const state = mapVoiceState(row);
      announce(state, state.channelId);
      return reply.code(200).send(state);
    },
  );
}

/** Tách riêng để `delete` không phải lồng arrow function nhiều tầng. */
function emitLeave(publisher: EventPublisher, row: VoiceStateRow, userId: Snowflake): void {
  publisher.publishVoiceState(row.channel_id, {
    guildId: row.guild_id as Snowflake,
    channelId: null,
    userId,
    selfMute: row.self_mute,
    selfDeaf: row.self_deaf,
    joinedAt: row.joined_at.toISOString(),
  });
}

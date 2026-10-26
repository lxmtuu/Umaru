import {
  Permission,
  hasPermission,
  parsePermissions,
  resolvePermissions,
  serializePermissions,
  type Channel,
  type DmChannelSummary,
  type Guild,
  type GuildMemberSummary,
  type PermissionOverwriteInput,
  type ReadState,
  type Role,
  type Snowflake,
  type ThreadSummary,
  type VoiceState,
} from "@umaru/protocol";
import type { Pool } from "./db.js";
import { mapChannel, mapGuild, mapRole, type ChannelRow, type GuildRow } from "./mappers.js";
import { listActiveThreadsForGuilds } from "./threads/store.js";

export interface GuildBootstrap {
  guild: Guild;
  channels: Channel[];
  /** Toàn bộ role, `position` giảm dần — client dựng UI quản lý role ngay từ READY. */
  roles: Role[];
  members: GuildMemberSummary[];
}

export interface Bootstrap {
  guilds: GuildBootstrap[];
  /** DM 1-1 của user (sắp xếp mới nhất trước). */
  dms: DmChannelSummary[];
  /** Mốc đã đọc + số tin chưa đọc của những kênh user thấy được. */
  readStates: ReadState[];
  /** Kênh nhận fan-out: mọi kênh guild được xem + mọi DM channel. */
  visibleChannels: Set<string>;
  guildIds: Set<string>;
  /** channelId → quyền hiệu dụng của user (chuỗi thập phân) — gửi kèm READY. */
  channelPermissions: Record<string, string>;
  /** Ai đang ở phòng thoại nào, **chỉ** trong các kênh user xem được. */
  voiceStates: VoiceState[];
  /**
   * Thread **đang mở** trong các server user là thành viên. Thread đã lưu trữ
   * không gửi kèm (tải khi mở kho lưu trữ) để READY không phình theo thời gian.
   */
  threads: ThreadSummary[];
}

/** DM không có role/overwrite: hai người trong cuộc đều có đúng ba quyền này. */
export const DM_PERMISSIONS =
  Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.READ_HISTORY;

interface RoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  is_everyone: boolean;
}

interface OverwriteRow {
  channel_id: string;
  target_type: "role" | "member";
  target_id: string;
  allow: string;
  deny: string;
}

interface DmRow {
  id: string;
  request_pending: boolean;
  type: "dm" | "group_dm";
  group_name: string | null;
  owner_id: string | null;
  /**
   * Gộp từ `string_agg`: mỗi người là `id\x1eusername\x1edisplayName\x1eavatarUrl`,
   * các người cách nhau `\x1f`.
   */
  members: string;
}

/**
 * Cuộc trò chuyện riêng của một user (DM 1-1 **và** group DM), mới nhất trước.
 *
 * Một truy vấn gộp cho cả hai loại: `string_agg` gom mọi người **khác mình** trong
 * kênh thành một chuỗi, client tách ra. Tránh N+1 khi sidebar có nhiều nhóm.
 *
 * DM 1-1 mà một trong hai đã chặn thì biến khỏi danh sách của **cả hai** (giữ
 * nguyên hành vi cũ). Group DM **không** bị ẩn vì block là chuyện giữa hai
 * người — một người chặn không được làm cả nhóm biến mất với người kia.
 */
export async function loadDms(pool: Pool, userId: Snowflake): Promise<DmChannelSummary[]> {
  const result = await pool.query<DmRow>(
    `SELECT c.id,
            c.type,
            g.name AS group_name,
            g.owner_id,
            -- Yêu cầu chờ duyệt: chỉ **người gửi** thấy kênh trong danh sách (kèm
            -- cờ này); người nhận bị lọc ở WHERE bên dưới cho tới khi họ đồng ý.
            EXISTS (SELECT 1 FROM dm_requests dr WHERE dr.channel_id = c.id) AS request_pending,
            -- Hai ký tự điều khiển làm phân cách: tên hiển thị có thể chứa dấu
            -- hai chấm hoặc dấu phẩy nên không dùng ký tự in được.
            coalesce(string_agg(
              concat_ws(chr(30), u.id, u.username, u.display_name, coalesce(u.avatar_url, '')),
              chr(31) ORDER BY u.id
            ), '') AS members
       FROM channels c
       JOIN channel_members mine ON mine.channel_id = c.id AND mine.user_id = $1
       -- LEFT JOIN vì group DM có thể còn **đúng một** thành viên (mọi người khác
       -- đã rời). Nếu INNER JOIN thì nhóm đó biến mất khỏi danh sách của người
       -- cuối cùng → họ không thể rời nốt và kênh thành rác vĩnh viễn.
       LEFT JOIN channel_members theirs ON theirs.channel_id = c.id AND theirs.user_id <> $1
       LEFT JOIN users u ON u.id = theirs.user_id
       LEFT JOIN group_dms g ON g.channel_id = c.id
      WHERE c.type IN ('dm', 'group_dm') AND c.guild_id IS NULL
        -- Yêu cầu nhắn tin chưa được duyệt: người nhận **không** thấy kênh, nên
        -- không nhận được fan-out tin nhắn (visibleChannels dựng từ đây) — người
        -- gửi vẫn thấy bình thường, kèm cờ requestPending.
        AND NOT EXISTS (
          SELECT 1 FROM dm_requests dr WHERE dr.channel_id = c.id AND dr.recipient_id = $1
        )
        -- DM 1-1 luôn phải có người bên kia; group DM thì không.
        AND (c.type = 'group_dm' OR theirs.user_id IS NOT NULL)
        AND (
          c.type = 'group_dm'
          -- DM 1-1: ẩn nếu có block theo bất kỳ chiều nào giữa hai người.
          OR NOT EXISTS (
            SELECT 1 FROM relationships rb
             WHERE rb.type = 'blocked'
               AND ((rb.user_id = $1 AND rb.target_id = theirs.user_id)
                 OR (rb.user_id = theirs.user_id AND rb.target_id = $1))
          )
        )
      GROUP BY c.id, c.type, g.name, g.owner_id
      ORDER BY c.id DESC`,
    [userId],
  );
  return result.rows.map((row) => {
    const recipients = row.members
      .split("\x1f")
      .filter((part) => part.length > 0)
      .map((part) => {
        const [id = "", username = "", displayName = "", avatarUrl = ""] = part.split("\x1e");
        return {
          userId: id as Snowflake,
          username,
          displayName,
          avatarUrl: avatarUrl === "" ? null : avatarUrl,
          // Người trong DM không thuộc guild nào của mình → không có role để hiện.
          roleIds: [],
        } satisfies GuildMemberSummary;
      });
    const isGroup = row.type === "group_dm";
    return {
      channel: {
        id: row.id as Snowflake,
        guildId: null,
        type: row.type,
        name: isGroup ? row.group_name : null,
        topic: null,
        categoryId: null,
        position: 0,
        slowmodeSeconds: 0,
      },
      recipient: isGroup ? null : (recipients[0] ?? null),
      recipients,
      ownerId: row.owner_id === null ? null : (row.owner_id as Snowflake),
      name: isGroup ? row.group_name : null,
      requestPending: row.request_pending,
    };
  });
}

/**
 * Summary một thành viên kèm role đang mang — REST dùng khi phát
 * `GUILD_MEMBER_ADD` / `GUILD_MEMBER_UPDATE` để client thay đúng một dòng.
 */
export async function loadMemberSummary(
  pool: Pool,
  guildId: string,
  memberId: string,
): Promise<GuildMemberSummary | null> {
  const result = await pool.query<{
    user_id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    role_ids: string[] | null;
  }>(
    `SELECT u.id AS user_id, u.username, u.display_name, u.avatar_url,
            array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL) AS role_ids
       FROM guild_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN member_roles mr ON mr.guild_id = gm.guild_id AND mr.user_id = gm.user_id
      WHERE gm.guild_id = $1 AND gm.user_id = $2
      GROUP BY u.id, u.username, u.display_name, u.avatar_url`,
    [guildId, memberId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    userId: row.user_id as Snowflake,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    roleIds: (row.role_ids ?? []) as Snowflake[],
  };
}

/**
 * Dựng snapshot cho READY: guild + channel mà user được xem, tính đúng theo
 * permission overwrite (docs/data-model.md §4). 4 query, không N+1.
 */
export async function loadBootstrap(pool: Pool, userId: Snowflake): Promise<Bootstrap> {
  const [guildResult, dmResult] = await Promise.all([
    pool.query<GuildRow>(
      `SELECT g.id, g.name, g.icon_url, g.owner_id, g.created_at
         FROM guilds g
         JOIN guild_members m ON m.guild_id = g.id
        WHERE m.user_id = $1
        ORDER BY g.id`,
      [userId],
    ),
    loadDms(pool, userId),
  ]);
  const guilds = guildResult.rows;
  const guildIds = guilds.map((guild) => guild.id);
  // DM luôn nhận fan-out, kể cả khi user chưa ở guild nào.
  const visibleChannels = new Set<string>(dmResult.map((dm) => dm.channel.id as string));
  const channelPermissions: Record<string, string> = {};
  for (const dm of dmResult) {
    channelPermissions[dm.channel.id as string] = serializePermissions(DM_PERMISSIONS);
  }
  if (guildIds.length === 0) {
    return {
      guilds: [],
      dms: dmResult,
      readStates: await loadReadStates(pool, userId, [...visibleChannels]),
      visibleChannels,
      guildIds: new Set(),
      channelPermissions,
      voiceStates: [],
      threads: [],
    };
  }

  const [
    channelResult,
    roleResult,
    memberRoleResult,
    guildMemberRoleResult,
    overwriteResult,
    memberResult,
  ] = await Promise.all([
    pool.query<ChannelRow>(
      `SELECT id, guild_id, type, name, topic, parent_id, position, slowmode_seconds
         FROM channels WHERE guild_id = ANY($1::bigint[])
        ORDER BY position, id`,
      [guildIds],
    ),
    pool.query<RoleRow>(
      `SELECT id, guild_id, name, color, position, permissions, is_everyone FROM roles
        WHERE guild_id = ANY($1::bigint[])
        ORDER BY position DESC, id DESC`,
      [guildIds],
    ),
    pool.query<{ guild_id: string; role_id: string }>(
      "SELECT guild_id, role_id FROM member_roles WHERE user_id = $1",
      [userId],
    ),
    pool.query<{ guild_id: string; user_id: string; role_id: string }>(
      `SELECT guild_id, user_id, role_id FROM member_roles
        WHERE guild_id = ANY($1::bigint[])`,
      [guildIds],
    ),
    pool.query<OverwriteRow>(
      `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
         FROM permission_overwrites o
         JOIN channels c ON c.id = o.channel_id
        WHERE c.guild_id = ANY($1::bigint[])`,
      [guildIds],
    ),
    pool.query<{
      guild_id: string;
      user_id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
    }>(
      `SELECT gm.guild_id, u.id AS user_id, u.username, u.display_name, u.avatar_url
         FROM guild_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.guild_id = ANY($1::bigint[])
        ORDER BY gm.joined_at, u.id`,
      [guildIds],
    ),
  ]);

  const rolesByGuild = groupBy(roleResult.rows, (role) => role.guild_id);
  const memberRolesByGuild = groupBy(memberRoleResult.rows, (row) => row.guild_id);
  // (guildId:userId) → roleIds, để mỗi member summary mang đúng role của mình.
  const rolesOfMember = new Map<string, string[]>();
  for (const row of guildMemberRoleResult.rows) {
    const key = `${row.guild_id}:${row.user_id}`;
    const list = rolesOfMember.get(key);
    if (list === undefined) rolesOfMember.set(key, [row.role_id]);
    else list.push(row.role_id);
  }
  const overwritesByChannel = groupBy(overwriteResult.rows, (row) => row.channel_id);
  const channelsByGuild = groupBy(channelResult.rows, (channel) => channel.guild_id ?? "");
  const membersByGuild = groupBy(memberResult.rows, (member) => member.guild_id);

  const result: GuildBootstrap[] = [];

  for (const guild of guilds) {
    const roles = rolesByGuild.get(guild.id) ?? [];
    const everyone = roles.find((role) => role.is_everyone);
    if (everyone === undefined) {
      throw new Error(`Guild ${guild.id} thiếu role @everyone`);
    }
    const memberRoleIds = new Set(
      (memberRolesByGuild.get(guild.id) ?? []).map((row) => row.role_id),
    );
    const memberRoles = roles
      .filter((role) => !role.is_everyone && memberRoleIds.has(role.id))
      .map((role) => ({ id: role.id as Snowflake, permissions: parsePermissions(role.permissions) }));

    const toOverwrite = (row: OverwriteRow): PermissionOverwriteInput => ({
      targetType: row.target_type,
      targetId: row.target_id as Snowflake,
      allow: parsePermissions(row.allow),
      deny: parsePermissions(row.deny),
    });

    const channels: Channel[] = [];
    for (const channel of channelsByGuild.get(guild.id) ?? []) {
      const overwrites = (overwritesByChannel.get(channel.id) ?? []).map(toOverwrite);
      // Category = cấp kế thừa: áp trước, kênh đè lên sau.
      const inheritedOverwrites =
        channel.parent_id === null
          ? []
          : (overwritesByChannel.get(channel.parent_id) ?? []).map(toOverwrite);
      const permissions = resolvePermissions({
        userId,
        isGuildOwner: guild.owner_id === userId,
        everyoneRoleId: everyone.id as Snowflake,
        everyonePermissions: parsePermissions(everyone.permissions),
        memberRoles,
        inheritedOverwrites,
        overwrites,
      });
      if (!hasPermission(permissions, Permission.VIEW_CHANNEL)) continue;
      channelPermissions[channel.id] = serializePermissions(permissions);
      // Thread **không** thuộc sidebar: client nhận qua `threads` + `THREAD_CREATE`.
      // Nhưng vẫn vào `visibleChannels` thì tin trong thread mới fan-out tới
      // người đang mở kênh cha — đúng lý do thread dùng chung `channels`.
      if (channel.type !== "guild_thread") channels.push(mapChannel(channel));
      // Category không nhận message nên không cần nằm trong tập fan-out.
      if (channel.type !== "category") visibleChannels.add(channel.id);
    }
    result.push({
      guild: mapGuild(guild),
      channels,
      // `roles` đã sắp position giảm dần từ câu query.
      roles: roles.map(mapRole),
      members: (membersByGuild.get(guild.id) ?? []).map(
        (member): GuildMemberSummary => ({
          userId: member.user_id as Snowflake,
          username: member.username,
          displayName: member.display_name,
          avatarUrl: member.avatar_url,
          roleIds: (rolesOfMember.get(`${guild.id}:${member.user_id}`) ?? []) as Snowflake[],
        }),
      ),
    });
  }

  return {
    guilds: result,
    dms: dmResult,
    readStates: await loadReadStates(pool, userId, [...visibleChannels]),
    visibleChannels,
    guildIds: new Set(guildIds),
    channelPermissions,
    // Lọc theo `visibleChannels` **trong SQL**: người không có VIEW_CHANNEL của
    // phòng thoại không được biết ai đang ở trong đó (cùng tiêu chí §8 với tin
    // nhắn). Lọc ở tầng này nên không có đường nào lọt qua READY.
    voiceStates: await loadVoiceStates(pool, [...visibleChannels]),
    threads: await listActiveThreadsForGuilds(pool, guildIds),
  };
}

interface VoiceStateRow {
  guild_id: string;
  channel_id: string;
  user_id: string;
  self_mute: boolean;
  self_deaf: boolean;
  joined_at: Date;
}

/** Trạng thái phòng thoại của một tập kênh (đã kiểm quyền xem ở nơi gọi). */
export async function loadVoiceStates(
  pool: Pool,
  channelIds: string[],
): Promise<VoiceState[]> {
  if (channelIds.length === 0) return [];
  const result = await pool.query<VoiceStateRow>(
    `SELECT guild_id, channel_id, user_id, self_mute, self_deaf, joined_at
       FROM voice_states
      WHERE channel_id = ANY($1::bigint[])
      ORDER BY joined_at, user_id`,
    [channelIds],
  );
  return result.rows.map((row) => ({
    guildId: row.guild_id as Snowflake,
    channelId: row.channel_id as Snowflake,
    userId: row.user_id as Snowflake,
    selfMute: row.self_mute,
    selfDeaf: row.self_deaf,
    joinedAt: row.joined_at.toISOString(),
  }));
}

interface ReadStateRow {
  channel_id: string;
  last_read: string;
  unread: string;
  mentions: string;
}

/**
 * Mốc đã đọc + số tin chưa đọc của từng kênh (chỉ tin người khác gửi).
 * Kênh chưa có dòng `read_states` coi như đã đọc hết — badge chỉ hiện cho tin
 * mới đến sau này, tránh user mới vào server thấy hàng trăm tin "chưa đọc".
 */
export async function loadReadStates(
  pool: Pool,
  userId: Snowflake,
  channelIds: string[],
): Promise<ReadState[]> {
  if (channelIds.length === 0) return [];
  const result = await pool.query<ReadStateRow>(
    `SELECT c.id AS channel_id,
            COALESCE(rs.last_read_message_id, 0) AS last_read,
            (SELECT count(*) FROM messages m
              WHERE m.channel_id = c.id
                AND m.id > COALESCE(rs.last_read_message_id, 0)
                AND m.author_id <> $1) AS unread,
            (SELECT count(*) FROM message_mentions mm
               JOIN messages m ON m.id = mm.message_id
              WHERE mm.channel_id = c.id
                AND mm.user_id = $1
                AND mm.message_id > COALESCE(rs.last_read_message_id, 0)
                AND m.author_id <> $1) AS mentions
       FROM channels c
       LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1
      WHERE c.id = ANY($2::bigint[])`,
    [userId, channelIds],
  );
  return result.rows.map((row) => ({
    channelId: row.channel_id as Snowflake,
    lastReadMessageId: row.last_read as Snowflake,
    unread: Number(row.unread),
    mentions: Number(row.mentions),
  }));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const list = map.get(value);
    if (list === undefined) map.set(value, [item]);
    else list.push(item);
  }
  return map;
}

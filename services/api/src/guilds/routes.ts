import { randomBytes } from "node:crypto";
import {
  Permission,
  createSnowflake,
  hasPermission,
  parsePermissions,
  serializePermissions,
  type ChannelType,
  type Snowflake,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import {
  highestRolePosition,
  listGuildChannelsForUser,
  loadChannelContext,
  loadGuildContext,
  requireGuildPermission,
  type GuildContext,
} from "../access.js";
import {
  mapChannel,
  mapGuild,
  mapRole,
  type ChannelRow,
  type GuildRow,
  type RoleRow,
} from "../mappers.js";
import { loadMemberSummary } from "../bootstrap.js";
import { loadDmSummary, renameGroupDm } from "../dms/group.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import type { EventPublisher } from "../events.js";
import { badRequest, forbidden, notFound, readId, readString } from "../http.js";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";

export interface GuildDeps {
  pool: Pool;
  config: Config;
  tokens: TokenService;
  publisher: EventPublisher;
}

/**
 * Quyền mặc định của `@everyone` khi tạo server.
 *
 * Có `CONNECT`/`SPEAK` từ đầu (như Discord): kênh thoại mới tạo phải dùng được
 * ngay, không bắt chủ server đi cấp quyền trước. Muốn hạn chế thì đặt overwrite
 * theo kênh — đúng cách.
 */
const DEFAULT_EVERYONE_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_HISTORY |
  Permission.CONNECT |
  Permission.SPEAK;

const CHANNEL_TYPES = new Set<ChannelType>(["guild_text", "guild_voice", "category"]);

/** Chỉ số kéo-thả: số nguyên ≥ 0 (đầu nhóm = 0); chặn NaN/lớn bất thường. */
function readPosition(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 100_000) {
    throw badRequest("position phải là số nguyên từ 0 đến 100000");
  }
  return raw;
}

const canManageChannels = (permissions: bigint): boolean =>
  hasPermission(permissions, Permission.MANAGE_CHANNELS);

const canManageRoles = (permissions: bigint): boolean =>
  hasPermission(permissions, Permission.MANAGE_ROLES);

/** Owner hoặc có ADMINISTRATOR (resolvePermissions đã trả ALL cho hai nhánh này). */
const isAdmin = (permissions: bigint): boolean =>
  hasPermission(permissions, Permission.ADMINISTRATOR);

const ROLE_COLUMNS = "id, guild_id, name, color, position, permissions, is_everyone";

async function loadGuildRole(pool: Pool, guildId: string, roleId: string): Promise<RoleRow> {
  const result = await pool.query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE id = $1 AND guild_id = $2`,
    [roleId, guildId],
  );
  const row = result.rows[0];
  if (row === undefined) throw notFound("Role không tồn tại");
  return row;
}

/**
 * Phát `GUILD_MEMBER_UPDATE` sau khi gán/thu role — mọi session trong server đổi
 * chip role của thành viên ngay, không phải tải lại danh sách.
 */
async function publishMemberUpdate(
  publisher: EventPublisher,
  pool: Pool,
  guildId: string,
  memberId: string,
): Promise<void> {
  const member = await loadMemberSummary(pool, guildId, memberId);
  if (member === null) return;
  publisher.publishToGuild(guildId, "GUILD_MEMBER_UPDATE", {
    guildId: guildId as Snowflake,
    member,
  });
}

/**
 * Actor được quản lý role này không: cần MANAGE_ROLES hiệu dụng, và role không
 * được cao hơn cấp của chính actor (owner/ADMIN bỏ qua) — chống leo thang quyền
 * qua phân cấp: mod không đụng được role cấp trên mình.
 */
function requireCanManageRole(context: GuildContext, role: RoleRow): void {
  if (!canManageRoles(context.permissions)) throw forbidden("Cần quyền MANAGE_ROLES");
  if (!isAdmin(context.permissions) && role.position > highestRolePosition(context)) {
    throw forbidden("Không thể quản lý role cao hơn cấp của mình");
  }
}

/**
 * Chỉ tạo/sửa/giao được role có quyền là tập con của quyền actor đang có
 * (owner/ADMIN không bị giới hạn). Khác Discord (chỉ phân cấp vị trí): ở đây mod có
 * MANAGE_ROLES cũng không thể tự phong quyền mình không có.
 */
function requireCanGrant(context: GuildContext, bits: bigint): void {
  if (isAdmin(context.permissions)) return;
  if ((bits & ~context.permissions) !== 0n) {
    throw forbidden("Không thể cấp quyền ngoài tập quyền của bạn");
  }
}

/**
 * Kéo-thả đổi cấp role: chèn `role` vào chỉ số `index` (0 = trên cùng, **không
 * tính** `@everyone`), rồi renumber toàn bộ role của server từ M (trên cùng)
 * xuống 1 (dưới cùng). `@everyone` luôn giữ `position = 0` ở đáy nên không bao
 * giờ bị đẩy lên/xuống theo.
 *
 * Trả về những role **thật sự đổi `position`**, theo đúng thứ tự mới, để
 * fan-out `ROLE_UPDATE` — client khác xếp lại ngay mà không cần tải lại.
 *
 * Fail-closed: non-admin không được đẩy role lên trên cấp cao nhất của mình
 * (làm vậy là tự nâng quyền qua phân cấp); khoá advisory theo guild để hai
 * người kéo cùng lúc không renumber chồng nhau thành position trùng.
 */
async function reorderRoles(
  pool: Pool,
  context: GuildContext,
  role: RoleRow,
  index: number,
  guildId: string,
): Promise<RoleRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${guildId}`]);

    const siblings = await client.query<{ id: string; position: number }>(
      `SELECT id, position FROM roles
        WHERE guild_id = $1 AND is_everyone = false AND id <> $2
        ORDER BY position DESC, id DESC`,
      [guildId, role.id],
    );
    const before = new Map<string, number>(siblings.rows.map((row) => [row.id, row.position]));
    before.set(role.id, role.position);

    const ids = siblings.rows.map((row) => row.id);
    const at = Math.min(index, ids.length);
    const ordered = [...ids.slice(0, at), role.id, ...ids.slice(at)];
    const total = ordered.length;
    // Chỉ số từ trên xuống 0..M-1 ↔ position M..1 (cao = mạnh hơn).
    if (!isAdmin(context.permissions) && total - at > highestRolePosition(context)) {
      throw forbidden("Không thể đưa role lên trên cấp cao nhất của bạn");
    }

    await client.query(
      `UPDATE roles AS r
          SET position = v.pos
         FROM unnest($1::bigint[], $2::integer[]) AS v(id, pos)
        WHERE r.id = v.id`,
      [ordered, ordered.map((_, position) => total - position)],
    );

    const after = await client.query<RoleRow>(
      `SELECT ${ROLE_COLUMNS} FROM roles WHERE id = ANY($1::bigint[])`,
      [ordered],
    );
    const byId = new Map(after.rows.map((row) => [row.id, row]));
    const changed: RoleRow[] = [];
    for (const id of ordered) {
      const row = byId.get(id);
      if (row !== undefined && before.get(row.id) !== row.position) changed.push(row);
    }
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function readRoleColor(body: Record<string, unknown> | undefined): number | null {
  const raw = body?.color;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 16777215) {
    throw badRequest('"color" phải là số nguyên 0–16777215 (0xRRGGBB)');
  }
  return raw;
}

function readPermissionBits(body: Record<string, unknown> | undefined): bigint | null {
  const raw = body?.permissions;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw badRequest('"permissions" phải là bitfield chuỗi thập phân');
  try {
    return parsePermissions(raw);
  } catch {
    throw badRequest(`"permissions" không hợp lệ: ${raw}`);
  }
}

export function registerGuildRoutes(app: FastifyInstance, deps: GuildDeps): void {
  const { pool, config, publisher } = deps;
  const guard = createAuthGuard(deps.tokens);
  const nextId = () => createSnowflake(config.workerId);

  app.post("/guilds", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const body = request.body as Record<string, unknown> | undefined;
    const name = readString(body, "name", { min: 1, max: 100 });

    const guildId = nextId();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)", [
        guildId,
        name,
        userId,
      ]);
      await client.query(
        `INSERT INTO roles (id, guild_id, name, position, permissions, is_everyone)
         VALUES ($1, $2, '@everyone', 0, $3, true)`,
        [nextId(), guildId, serializePermissions(DEFAULT_EVERYONE_PERMISSIONS)],
      );
      await client.query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)", [
        guildId,
        userId,
      ]);
      await client.query(
        `INSERT INTO channels (id, guild_id, type, name, position)
         VALUES ($1, $2, 'guild_text', 'general', 0)`,
        [nextId(), guildId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const guild = await pool.query<GuildRow>(
      "SELECT id, name, icon_url, owner_id, created_at FROM guilds WHERE id = $1",
      [guildId],
    );
    const created = guild.rows[0];
    if (created === undefined) throw new Error("Không đọc được guild vừa tạo");
    // Session gateway đang mở chưa biết guild mới (READY chạy trước đó).
    await publisher.refreshUserVisibility(userId);
    return reply.code(201).send(mapGuild(created));
  });

  app.get("/users/@me/guilds", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const result = await pool.query<GuildRow>(
      `SELECT g.id, g.name, g.icon_url, g.owner_id, g.created_at
         FROM guilds g
         JOIN guild_members m ON m.guild_id = g.id
        WHERE m.user_id = $1
        ORDER BY g.id`,
      [userId],
    );
    return reply.send(result.rows.map(mapGuild));
  });

  app.get<{ Params: { guildId: string } }>(
    "/guilds/:guildId/channels",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { channels } = await listGuildChannelsForUser(
        pool,
        userId as Snowflake,
        request.params.guildId,
      );
      return reply.send(channels.map((entry) => mapChannel(entry.channel)));
    },
  );

  app.post<{ Params: { guildId: string } }>(
    "/guilds/:guildId/channels",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await requireGuildPermission(
        pool,
        userId as Snowflake,
        request.params.guildId,
        Permission.MANAGE_CHANNELS,
      );

      const body = request.body as Record<string, unknown> | undefined;
      const name = readString(body, "name", { min: 1, max: 100 });
      const rawType = typeof body?.type === "string" ? body.type : "guild_text";
      if (!CHANNEL_TYPES.has(rawType as ChannelType)) {
        throw badRequest("type phải là guild_text, guild_voice hoặc category");
      }
      const parentId = readId(body, "parentId");
      if (parentId !== null) {
        const parent = await pool.query<{ type: string; guild_id: string }>(
          "SELECT type, guild_id FROM channels WHERE id = $1",
          [parentId],
        );
        const parentRow = parent.rows[0];
        if (
          parentRow === undefined ||
          parentRow.guild_id !== request.params.guildId ||
          parentRow.type !== "category"
        ) {
          throw badRequest("parentId phải là category trong cùng server");
        }
      }

      const position = await pool.query<{ next: number }>(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE guild_id = $1",
        [request.params.guildId],
      );
      const channelId = nextId();
      const inserted = await pool.query<ChannelRow>(
        `INSERT INTO channels (id, guild_id, type, name, parent_id, position)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, guild_id, type, name, topic, parent_id, position`,
        [
          channelId,
          request.params.guildId,
          rawType,
          name,
          parentId,
          position.rows[0]?.next ?? 0,
        ],
      );
      const channel = inserted.rows[0];
      if (channel === undefined) throw new Error("Không đọc được channel vừa tạo");

      await publisher.refreshGuildVisibility(request.params.guildId);
      publisher.publishToGuild(request.params.guildId, "CHANNEL_CREATE", mapChannel(channel));
      return reply.code(201).send(mapChannel(channel));
    },
  );

  app.patch<{ Params: { channelId: string } }>(
    "/channels/:channelId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await loadChannelContext(pool, userId as Snowflake, request.params.channelId);
      if (context.guild === null) {
        // `loadChannelContext` đã kiểm tư cách thành viên; chỉ group DM mới có
        // tên để đổi (DM 1-1 luôn hiển thị theo tên người kia).
        if (context.channel.type !== "group_dm") throw notFound("Kênh không tồn tại");
        const body = request.body as Record<string, unknown> | undefined;
        if (body === undefined || !("name" in body)) {
          throw badRequest('Thiếu trường "name"');
        }
        await renameGroupDm(pool, publisher, request.params.channelId, body.name);
        const summary = await loadDmSummary(pool, request.params.channelId, userId);
        if (summary === null) throw notFound("Nhóm không tồn tại");
        return reply.send(summary);
      }
      if (!canManageChannels(context.permissions | context.guild.permissions)) {
        throw forbidden("Cần quyền MANAGE_CHANNELS");
      }

      const body = request.body as Record<string, unknown> | undefined;
      const name = body?.name === undefined ? null : readString(body, "name", { min: 1, max: 100 });
      const topic = body?.topic === undefined ? undefined : readString(body, "topic", { min: 0, max: 1024 });
      // `parentId: null` = đưa ra gốc; vắng mặt = giữ nguyên category hiện tại.
      const movesCategory = body !== undefined && "parentId" in body;
      const parentId = movesCategory ? readId(body, "parentId") : null;
      if (movesCategory && parentId !== null) {
        if (context.channel.type === "category") {
          throw badRequest("Category không lồng trong category khác");
        }
        const parent = await pool.query<{ type: string; guild_id: string }>(
          "SELECT type, guild_id FROM channels WHERE id = $1",
          [parentId],
        );
        const parentRow = parent.rows[0];
        if (
          parentRow === undefined ||
          parentRow.guild_id !== (context.channel.guild_id ?? "") ||
          parentRow.type !== "category"
        ) {
          throw badRequest("parentId phải là category trong cùng server");
        }
      }
      // `position` = chỉ số trong nhóm kênh cùng category (0 = đầu nhóm) — cho kéo-thả.
      const movesPosition = body !== undefined && "position" in body && body.position !== null;
      const position = movesPosition ? readPosition(body?.position) : 0;
      if (name === null && topic === undefined && !movesCategory && !movesPosition) {
        throw badRequest("Không có gì để cập nhật");
      }

      if (name !== null || topic !== undefined || movesCategory) {
        await pool.query(
          `UPDATE channels
              SET name = COALESCE($2, name),
                  topic = COALESCE($3, topic),
                  parent_id = CASE WHEN $4 THEN $5 ELSE parent_id END,
                  updated_at = now()
            WHERE id = $1`,
          [request.params.channelId, name, topic ?? null, movesCategory, parentId],
        );
      }

      // Đổi thứ tự: renumber lại toàn bộ anh em cùng category theo thứ tự mới, rồi
      // đẩy `CHANNEL_UPDATE` cho những kênh vị trí thật sự đổi để client khác xếp lại ngay.
      const changed = new Map<string, ChannelRow>();
      if (movesPosition) {
        // Không đổi category thì vẫn phải renumber theo category **hiện tại** của kênh.
        const targetParentId = movesCategory ? parentId : context.channel.parent_id;
        const siblings = await pool.query<{ id: string; position: number }>(
          `SELECT id, position FROM channels
            WHERE guild_id = $1
              AND parent_id IS NOT DISTINCT FROM $2::bigint
              AND id <> $3
            ORDER BY position, id`,
          [context.channel.guild_id ?? "", targetParentId, request.params.channelId],
        );
        const before = new Map<string, number>(siblings.rows.map((row) => [row.id, row.position]));
        before.set(request.params.channelId, context.channel.position);

        const siblingIds = siblings.rows.map((row) => row.id);
        const insertAt = Math.min(position, siblingIds.length);
        const ordered = [
          ...siblingIds.slice(0, insertAt),
          request.params.channelId,
          ...siblingIds.slice(insertAt),
        ];
        await pool.query(
          `UPDATE channels AS c
              SET position = v.pos, updated_at = now()
             FROM unnest($1::bigint[], $2::integer[]) AS v(id, pos)
            WHERE c.id = v.id`,
          [ordered, ordered.map((_, index) => index)],
        );

        const after = await pool.query<ChannelRow>(
          `SELECT id, guild_id, type, name, topic, parent_id, position
             FROM channels WHERE id = ANY($1::bigint[])`,
          [ordered],
        );
        // Duyệt theo thứ tự mới để fan-out theo đúng thứ tự sidebar.
        const afterById = new Map(after.rows.map((row) => [row.id, row]));
        for (const id of ordered) {
          const row = afterById.get(id);
          if (row !== undefined && before.get(row.id) !== row.position) changed.set(row.id, row);
        }
      }

      const updated = await pool.query<ChannelRow>(
        `SELECT id, guild_id, type, name, topic, parent_id, position
           FROM channels WHERE id = $1`,
        [request.params.channelId],
      );
      const channel = updated.rows[0];
      if (channel === undefined) throw notFound("Kênh không tồn tại");
      const guildId = channel.guild_id ?? "";

      // Chỉ đổi category thì tập kênh hiển thị mới đổi → tính lại quyền/visibility.
      if (movesCategory) await publisher.refreshGuildVisibility(guildId);
      if (name !== null || topic !== undefined || movesCategory) changed.set(channel.id, channel);
      for (const row of changed.values()) {
        publisher.publishToGuild(guildId, "CHANNEL_UPDATE", mapChannel(row));
      }
      return reply.send(mapChannel(channel));
    },
  );

  app.delete<{ Params: { channelId: string } }>(
    "/channels/:channelId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await loadChannelContext(pool, userId as Snowflake, request.params.channelId);
      if (context.guild === null) throw notFound("Kênh không tồn tại");
      if (!canManageChannels(context.permissions | context.guild.permissions)) {
        throw forbidden("Cần quyền MANAGE_CHANNELS");
      }
      await pool.query("DELETE FROM channels WHERE id = $1", [request.params.channelId]);
      const guildId = context.channel.guild_id ?? "";
      await publisher.refreshGuildVisibility(guildId);
      publisher.publishToGuild(guildId, "CHANNEL_DELETE", {
        id: request.params.channelId as Snowflake,
        guildId: guildId as Snowflake,
      });
      return reply.code(204).send();
    },
  );

  // ---------- roles ----------

  app.get<{ Params: { guildId: string } }>(
    "/guilds/:guildId/roles",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await loadGuildContext(pool, userId as Snowflake, request.params.guildId);
      if (context === null) throw notFound("Server không tồn tại");
      const result = await pool.query<RoleRow>(
        `SELECT ${ROLE_COLUMNS} FROM roles WHERE guild_id = $1 ORDER BY position DESC, id DESC`,
        [request.params.guildId],
      );
      return reply.send(result.rows.map(mapRole));
    },
  );

  app.post<{ Params: { guildId: string } }>(
    "/guilds/:guildId/roles",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await requireGuildPermission(
        pool,
        userId as Snowflake,
        request.params.guildId,
        Permission.MANAGE_ROLES,
      );

      const body = request.body as Record<string, unknown> | undefined;
      const name = readString(body, "name", { min: 1, max: 100 });
      const color = readRoleColor(body) ?? 0;
      const bits = readPermissionBits(body) ?? 0n;
      requireCanGrant(context, bits);

      // Role mới: owner/ADMIN đẩy lên trên cùng; người thường tạo ngang cấp
      // mình — không bao giờ nhảy trên cấp để không cần ai "giải" lại.
      const maxPosition = await pool.query<{ max: number }>(
        "SELECT COALESCE(MAX(position), 0) AS max FROM roles WHERE guild_id = $1",
        [request.params.guildId],
      );
      const position = isAdmin(context.permissions)
        ? (maxPosition.rows[0]?.max ?? 0) + 1
        : highestRolePosition(context);

      const created = await pool.query<RoleRow>(
        `INSERT INTO roles (id, guild_id, name, color, position, permissions)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${ROLE_COLUMNS}`,
        [nextId(), request.params.guildId, name, color, position, serializePermissions(bits)],
      );
      const role = created.rows[0];
      if (role === undefined) throw new Error("Không đọc được role vừa tạo");
      // Role chưa gán cho ai → chưa đổi quyền của ai, chỉ cần broadcast.
      publisher.publishToGuild(request.params.guildId, "ROLE_CREATE", {
        guildId: request.params.guildId as Snowflake,
        role: mapRole(role),
      });
      return reply.code(201).send(mapRole(role));
    },
  );

  app.patch<{ Params: { guildId: string; roleId: string } }>(
    "/guilds/:guildId/roles/:roleId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await requireGuildPermission(
        pool,
        userId as Snowflake,
        request.params.guildId,
        Permission.MANAGE_ROLES,
      );
      const role = await loadGuildRole(pool, request.params.guildId, request.params.roleId);
      requireCanManageRole(context, role);

      const body = request.body as Record<string, unknown> | undefined;
      const name = body?.name === undefined ? null : readString(body, "name", { min: 1, max: 100 });
      const color = readRoleColor(body);
      const bits = readPermissionBits(body);
      // `position` ở đây là **thứ hạng kéo-thả** (0 = trên cùng), khác `Role.position`
      // (cao = mạnh hơn) mà response trả về — đừng nhầm hai chiều.
      const movesPosition = body !== undefined && "position" in body && body.position !== null;
      if (name === null && color === null && bits === null && !movesPosition) {
        throw badRequest("Không có gì để cập nhật");
      }
      if (bits !== null) requireCanGrant(context, bits);

      let updatedRole = role;
      if (name !== null || color !== null || bits !== null) {
        const updated = await pool.query<RoleRow>(
          `UPDATE roles
              SET name = COALESCE($3, name),
                  color = COALESCE($4, color),
                  permissions = COALESCE($5, permissions)
            WHERE id = $1 AND guild_id = $2
            RETURNING ${ROLE_COLUMNS}`,
          [
            request.params.roleId,
            request.params.guildId,
            name,
            color,
            bits === null ? null : serializePermissions(bits),
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) throw notFound("Role không tồn tại");
        updatedRole = row;
      }

      const changedFields = name !== null || color !== null || bits !== null;
      // Quyền role đổi → hiệu dụng của mọi thành viên mang role đó đổi theo.
      // (Chỉ đổi tên/màu hoặc thứ hạng thì tập kênh hiển thị không đổi.)
      if (bits !== null) await publisher.refreshGuildVisibility(request.params.guildId);

      let published = false;
      if (movesPosition) {
        // Kéo-thả chỉ đổi **thứ hạng**: không ai được/mất quyền, nên không cần
        // `refreshGuildVisibility` — chỉ fan-out role nào đổi chỗ, theo thứ tự mới.
        if (updatedRole.is_everyone) throw badRequest("@everyone luôn ở dưới cùng");
        const changed = await reorderRoles(
          pool,
          context,
          updatedRole,
          readPosition(body?.position),
          request.params.guildId,
        );
        for (const row of changed) {
          publisher.publishToGuild(request.params.guildId, "ROLE_UPDATE", {
            guildId: request.params.guildId as Snowflake,
            role: mapRole(row),
          });
          if (row.id === updatedRole.id) {
            updatedRole = row;
            published = true;
          }
        }
      }
      // Thả đúng chỗ cũ (không ai đổi position) vẫn phải phát nếu tên/quyền vừa
      // sửa — và không bao giờ phát hai lần cho cùng một role trong một request.
      if (changedFields && !published) {
        publisher.publishToGuild(request.params.guildId, "ROLE_UPDATE", {
          guildId: request.params.guildId as Snowflake,
          role: mapRole(updatedRole),
        });
      }

      return reply.send(mapRole(updatedRole));
    },
  );

  app.delete<{ Params: { guildId: string; roleId: string } }>(
    "/guilds/:guildId/roles/:roleId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await requireGuildPermission(
        pool,
        userId as Snowflake,
        request.params.guildId,
        Permission.MANAGE_ROLES,
      );
      const role = await loadGuildRole(pool, request.params.guildId, request.params.roleId);
      if (role.is_everyone) throw badRequest("Không thể xoá role @everyone");
      requireCanManageRole(context, role);

      await pool.query("DELETE FROM roles WHERE id = $1 AND guild_id = $2", [
        request.params.roleId,
        request.params.guildId,
      ]);
      // member_roles cascade theo FK → người từng mang role này mất quyền ngay.
      await publisher.refreshGuildVisibility(request.params.guildId);
      publisher.publishToGuild(request.params.guildId, "ROLE_DELETE", {
        guildId: request.params.guildId as Snowflake,
        roleId: request.params.roleId as Snowflake,
      });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { guildId: string; memberId: string; roleId: string } }>(
    "/guilds/:guildId/members/:memberId/roles/:roleId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await requireGuildPermission(
        pool,
        userId as Snowflake,
        request.params.guildId,
        Permission.MANAGE_ROLES,
      );
      const role = await loadGuildRole(pool, request.params.guildId, request.params.roleId);
      if (role.is_everyone) throw badRequest("@everyone đã được gán mặc định cho mọi người");
      requireCanManageRole(context, role);
      // Giao role mạnh hơn mình = leo thang quyền, kể cả khi position thấp hơn.
      requireCanGrant(context, parsePermissions(role.permissions));

      const member = await pool.query(
        "SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2",
        [request.params.guildId, request.params.memberId],
      );
      if (member.rowCount === 0) throw notFound("Thành viên không tồn tại trong server");

      await pool.query(
        `INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [request.params.guildId, request.params.memberId, request.params.roleId],
      );
      // Chỉ người được gán đổi quyền → đẩy đúng session của họ.
      await publisher.refreshUserVisibility(request.params.memberId);
      await publishMemberUpdate(
        publisher,
        pool,
        request.params.guildId,
        request.params.memberId,
      );
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { guildId: string; memberId: string; roleId: string } }>(
    "/guilds/:guildId/members/:memberId/roles/:roleId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await requireGuildPermission(
        pool,
        userId as Snowflake,
        request.params.guildId,
        Permission.MANAGE_ROLES,
      );
      const role = await loadGuildRole(pool, request.params.guildId, request.params.roleId);
      if (role.is_everyone) throw badRequest("@everyone luôn được gán — không thể thu");
      requireCanManageRole(context, role);

      const removed = await pool.query(
        "DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = $3",
        [request.params.guildId, request.params.memberId, request.params.roleId],
      );
      if (removed.rowCount === 0) throw notFound("Thành viên không mang role này");

      await publisher.refreshUserVisibility(request.params.memberId);
      await publishMemberUpdate(
        publisher,
        pool,
        request.params.guildId,
        request.params.memberId,
      );
      return reply.code(204).send();
    },
  );

  // ---------- invites ----------

  app.post<{ Params: { guildId: string } }>(
    "/guilds/:guildId/invites",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      const context = await loadGuildContext(pool, userId as Snowflake, request.params.guildId);
      if (context === null) throw notFound("Server không tồn tại");

      const body = request.body as Record<string, unknown> | undefined;
      const channelId = readId(body, "channelId");
      if (channelId === null) throw badRequest("Thiếu channelId");

      const channel = await loadChannelContext(pool, userId as Snowflake, channelId);
      if (channel.channel.guild_id !== request.params.guildId) {
        throw badRequest("channelId không thuộc server này");
      }

      const code = randomBytes(6).toString("hex");
      await pool.query(
        `INSERT INTO invites (code, guild_id, channel_id, inviter_id)
         VALUES ($1, $2, $3, $4)`,
        [code, request.params.guildId, channelId, userId],
      );
      return reply.code(201).send({ code, guildId: request.params.guildId, channelId });
    },
  );

  app.post<{ Params: { code: string } }>(
    "/invites/:code",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      // Tăng lượt dùng atomic — không cần trigger, không race.
      const consumed = await pool.query<{ guild_id: string }>(
        `UPDATE invites SET uses = uses + 1
          WHERE code = $1
            AND (max_uses IS NULL OR uses < max_uses)
            AND (expires_at IS NULL OR expires_at > now())
          RETURNING guild_id`,
        [request.params.code],
      );
      const invite = consumed.rows[0];
      if (invite === undefined) throw notFound("Lời mời không hợp lệ hoặc đã hết hạn");

      await pool.query(
        `INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [invite.guild_id, userId],
      );

      const guild = await pool.query<GuildRow>(
        "SELECT id, name, icon_url, owner_id, created_at FROM guilds WHERE id = $1",
        [invite.guild_id],
      );
      const guildRow = guild.rows[0];
      if (guildRow === undefined) throw notFound("Server không tồn tại");

      const member = await pool.query<{
        username: string;
        display_name: string;
        avatar_url: string | null;
      }>("SELECT username, display_name, avatar_url FROM users WHERE id = $1", [userId]);
      const memberRow = member.rows[0];
      if (memberRow !== undefined) {
        // Dùng chung loader với GUILD_MEMBER_UPDATE — người đã ở server từ trước
        // có thể đã mang role, nên không được gửi mảng rỗng.
        const summary = await loadMemberSummary(pool, invite.guild_id, userId);
        if (summary !== null) {
          publisher.publishToGuild(invite.guild_id, "GUILD_MEMBER_ADD", {
            guildId: invite.guild_id as Snowflake,
            member: summary,
          });
        }
      }
      // Session của người vừa join chưa biết guild này.
      await publisher.refreshUserVisibility(userId);
      return reply.send(mapGuild(guildRow));
    },
  );
}

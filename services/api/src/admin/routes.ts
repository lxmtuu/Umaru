import {
  REPORT_REASONS,
  type AdminReport,
  type AdminReportPage,
  type ReportReason,
  type ReportStatus,
  type Snowflake,
} from "@umaru/protocol";
import type { FastifyInstance } from "fastify";
import { createAuthGuard, requireUserId } from "../auth/guard.js";
import type { TokenService } from "../auth/tokens.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";
import { badRequest, notFound, readLimit } from "../http.js";
import { isAdmin, requireAdmin } from "./access.js";

export interface AdminDeps {
  pool: Pool;
  tokens: TokenService;
  config: Config;
}

/** Trạng thái hợp lệ — dùng chung với CHECK constraint trong `reports`. */
export const REPORT_STATUSES: readonly ReportStatus[] = ["open", "reviewing", "closed"];

interface AdminReportRow {
  id: string;
  status: ReportStatus;
  reason: string;
  details: string | null;
  snapshot_content: string | null;
  target_message_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  guild_id: string | null;
  guild_name: string | null;
  created_at: Date;
  reporter_id: string;
  reporter_username: string;
  reporter_display_name: string;
  target_user_id: string;
  target_username: string;
  target_display_name: string;
}

const SELECT_REPORTS = `
  SELECT r.id, r.status, r.reason, r.details, r.snapshot_content, r.target_message_id,
         r.channel_id, c.name AS channel_name,
         r.guild_id, g.name AS guild_name,
         r.created_at,
         reporter.id AS reporter_id, reporter.username AS reporter_username,
         reporter.display_name AS reporter_display_name,
         target.id AS target_user_id, target.username AS target_username,
         target.display_name AS target_display_name
    FROM reports r
    JOIN users reporter ON reporter.id = r.reporter_id
    JOIN users target   ON target.id = r.target_user_id
    LEFT JOIN channels c ON c.id = r.channel_id
    LEFT JOIN guilds g   ON g.id = r.guild_id`;

function mapReport(row: AdminReportRow): AdminReport {
  return {
    id: row.id as Snowflake,
    status: row.status,
    // Bảng có CHECK nên giá trị lạ chỉ xảy ra khi DB bị sửa tay — quy về "other"
    // thay vì trả chuỗi không khớp union cho client.
    reason: (REPORT_REASONS as readonly string[]).includes(row.reason)
      ? (row.reason as ReportReason)
      : "other",
    details: row.details,
    snapshotContent: row.snapshot_content,
    messageId: row.target_message_id as Snowflake | null,
    channelId: row.channel_id as Snowflake | null,
    channelName: row.channel_name,
    guildId: row.guild_id as Snowflake | null,
    guildName: row.guild_name,
    reporter: {
      userId: row.reporter_id as Snowflake,
      username: row.reporter_username,
      displayName: row.reporter_display_name,
    },
    target: {
      userId: row.target_user_id as Snowflake,
      username: row.target_username,
      displayName: row.target_display_name,
    },
    createdAt: row.created_at.toISOString(),
  };
}

function readStatusFilter(raw: unknown): ReportStatus | null {
  if (raw === undefined || raw === "" || raw === "all") return null;
  if (typeof raw !== "string" || !(REPORT_STATUSES as readonly string[]).includes(raw)) {
    throw badRequest(`"status" phải là một trong: ${REPORT_STATUSES.join(", ")} (hoặc bỏ trống)`);
  }
  return raw as ReportStatus;
}

/**
 * API cho người vận hành nền tảng (không phải chủ server).
 *
 * Toàn bộ route ở đây đi qua `requireAdmin`; thiếu quyền → 403. Client ẩn nút
 * khi `GET /admin/status` trả `admin: false`, nhưng quyền thật luôn kiểm ở
 * server (không tin UI).
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { pool, config } = deps;
  const guard = createAuthGuard(deps.tokens);

  /** Cho client biết có hiện lối vào khu quản trị hay không. */
  app.get("/admin/status", { preHandler: guard }, async (request, reply) => {
    const userId = requireUserId(request);
    const result = await pool.query<{ id: string; username: string }>(
      "SELECT id, username FROM users WHERE id = $1",
      [userId],
    );
    const user = result.rows[0];
    return reply.send({ admin: user !== undefined && isAdmin(config, user) });
  });

  /**
   * Hàng đợi báo cáo: mặc định `status=open`, mới nhất trước, cursor `before`.
   *
   * `counts` đếm toàn bộ (không phụ thuộc bộ lọc) để hiện số trên tab.
   */
  app.get<{ Querystring: { status?: string; before?: string; limit?: string } }>(
    "/admin/reports",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await requireAdmin(pool, config, userId);

      const status = readStatusFilter(request.query.status);
      const limit = readLimit(request.query.limit, 25, 100);
      const before = request.query.before ?? null;
      if (before !== null && !/^\d{1,20}$/.test(before)) {
        throw badRequest("before phải là snowflake");
      }

      const rows = await pool.query<AdminReportRow>(
        `${SELECT_REPORTS}
          WHERE ($1::text IS NULL OR r.status = $1)
            AND ($2::bigint IS NULL OR r.id < $2)
          ORDER BY r.id DESC
          LIMIT $3`,
        [status, before, limit],
      );

      const counts = await pool.query<{ status: ReportStatus; count: string }>(
        "SELECT status, count(*)::text AS count FROM reports GROUP BY status",
      );
      const tally: Record<ReportStatus, number> = { open: 0, reviewing: 0, closed: 0 };
      for (const row of counts.rows) {
        if ((REPORT_STATUSES as readonly string[]).includes(row.status)) {
          tally[row.status] = Number(row.count);
        }
      }

      const page: AdminReportPage = {
        reports: rows.rows.map(mapReport),
        counts: tally,
        hasMore: rows.rows.length === limit,
      };
      return reply.send(page);
    },
  );

  /** Đổi trạng thái xử lý một báo cáo (open → reviewing → closed). */
  app.patch<{ Params: { reportId: string } }>(
    "/admin/reports/:reportId",
    { preHandler: guard },
    async (request, reply) => {
      const userId = requireUserId(request);
      await requireAdmin(pool, config, userId);

      const body = request.body as Record<string, unknown> | undefined;
      const status = body?.["status"];
      if (typeof status !== "string" || !(REPORT_STATUSES as readonly string[]).includes(status)) {
        throw badRequest(`"status" phải là một trong: ${REPORT_STATUSES.join(", ")}`);
      }

      // UPDATE rồi SELECT riêng: trong cùng một câu, phần SELECT vẫn thấy bản
      // ghi TRƯỚC khi UPDATE (PostgreSQL dùng snapshot của câu lệnh), nên gộp
      // bằng CTE sẽ trả về trạng thái cũ.
      const updated = await pool.query(
        "UPDATE reports SET status = $2 WHERE id = $1 RETURNING id",
        [request.params.reportId, status],
      );
      if (updated.rowCount === 0) throw notFound("Báo cáo không tồn tại");

      const fresh = await pool.query<AdminReportRow>(
        `${SELECT_REPORTS} WHERE r.id = $1`,
        [request.params.reportId],
      );
      const row = fresh.rows[0];
      if (row === undefined) throw notFound("Báo cáo không tồn tại");
      return reply.send(mapReport(row));
    },
  );
}

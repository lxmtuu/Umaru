import type { ReportReason } from "@umaru/protocol";
import type { Mailer } from "../mail.js";
import type { Config } from "../config.js";
import type { Pool } from "../db.js";

/**
 * Mail báo có báo cáo vi phạm mới — gửi cho **quản trị viên nền tảng** (cùng
 * danh sách `ADMIN_USER_IDS` / `ADMIN_USERNAMES` dùng cho `/admin/reports`).
 *
 * Ba nguyên tắc:
 * 1. **Không chặn đường gửi báo cáo**: SMTP chậm/hỏng mà làm `POST /reports`
 *    treo hay trả lỗi là tự phá tính năng an toàn. Ở đây gọi fire-and-forget,
 *    lỗi chỉ ghi log.
 * 2. **Gộp + giãn cách**: người dùng bấm báo cáo 20 lần/phút thì admin không
 *    được nhận 20 mail. Trong `reportNotifyCooldownSec` chỉ gửi **một** mail và
 *    ghi kèm số báo cáo đã dồn lại.
 * 3. **Không rò dữ liệu thừa**: mail chỉ chứa lý do, id, tên hiển thị người bị
 *    báo cáo và link hàng đợi — không chứa email người dùng, không chứa toàn bộ
 *    nội dung tin (bản đầy đủ nằm sau đăng nhập admin).
 */
export interface ReportNotice {
  reportId: string;
  reason: ReportReason;
  targetUserId: string;
  targetDisplayName: string;
  guildId: string | null;
  channelId: string | null;
  details: string | null;
}

const REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Quấy rối",
  hate: "Thù ghét / kích động",
  sexual_content: "Nội dung khiêu dâm",
  violence: "Bạo lực",
  self_harm: "Tự hại",
  impersonation: "Mạo danh",
  other: "Khác",
};

interface AdminRow {
  id: string;
  username: string;
  display_name: string;
  email: string;
}

export class ReportNotifier {
  /** Số báo cáo dồn lại chưa kịp báo cho admin. */
  private pending = 0;
  private lastSentAt = 0;
  /** Promise của lần gửi đang chạy — test cần chờ, production thì không. */
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      pool: Pool;
      config: Config;
      mailer: Mailer;
      /** Đồng hồ thay được để test cooldown mà không phải chờ thật. */
      now?: () => number;
      write?: (line: string) => void;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Báo có báo cáo mới. **Không bao giờ ném lỗi và không chặn caller** — trả về
   * ngay, phần gửi mail chạy nền (giữ `inflight` để test chờ được).
   */
  notifyNewReport(input: ReportNotice): void {
    this.pending += 1;
    const { config } = this.deps;
    if (!config.reportNotifyEmail) {
      this.pending = 0;
      return;
    }
    const now = this.now();
    const cooldownMs = config.reportNotifyCooldownSec * 1000;
    if (now - this.lastSentAt < cooldownMs) return;

    this.lastSentAt = now;
    const batched = this.pending;
    this.pending = 0;
    this.inflight = this.deliver(input, batched).catch((error: unknown) => {
      this.deps.write?.(
        `[report-notify] không gửi được mail báo cáo ${input.reportId}: ${String(error)}`,
      );
    });
  }

  /** Chờ lần gửi đang chạy xong — chỉ dùng trong test. */
  async whenIdle(): Promise<void> {
    await this.inflight;
  }

  private async deliver(input: ReportNotice, batched: number): Promise<void> {
    const admins = await this.loadAdmins();
    if (admins.length === 0) return;

    const { config } = this.deps;
    const link = `${config.publicWebUrl.replace(/\/$/, "")}/admin/reports`;
    const reason = REASON_LABELS[input.reason];
    const where = input.guildId === null ? "tin nhắn riêng" : "trong server";
    const details =
      input.details === null || input.details.trim().length === 0
        ? "Không có mô tả thêm."
        : input.details.trim().slice(0, 500);
    const count = batched > 1 ? ` (${batched} báo cáo mới kể từ mail trước)` : "";

    const subject = `Umaru: báo cáo vi phạm mới — ${reason}${count}`;
    const text = [
      `Có báo cáo vi phạm mới${count}.`,
      "",
      `Lý do: ${reason}`,
      `Người bị báo cáo: ${input.targetDisplayName}`,
      `Vị trí: ${where}`,
      `Mã báo cáo: ${input.reportId}`,
      "",
      "Mô tả từ người báo cáo:",
      details,
      "",
      `Xem hàng đợi: ${link}`,
      "",
      "— Umaru (mail tự động, đừng trả lời)",
    ].join("\n");

    await Promise.all(
      admins.map((admin) =>
        this.deps.mailer
          .send({ to: admin.email, subject, text, html: escapeHtml(text) })
          .catch((error: unknown) => {
            this.deps.write?.(
              `[report-notify] lỗi gửi tới ${admin.username}: ${String(error)}`,
            );
          }),
      ),
    );
  }

  /** Admin có email, theo đúng thứ tự cấu hình, đã bỏ trùng. */
  private async loadAdmins(): Promise<AdminRow[]> {
    const { config, pool } = this.deps;
    const ids = config.adminUserIds;
    const names = config.adminUsernames.map((name) => name.toLowerCase());
    if (ids.length === 0 && names.length === 0) return [];

    const result = await pool.query<AdminRow>(
      `SELECT id, username, display_name, email FROM users
        WHERE id = ANY($1::bigint[])
           OR lower(username) = ANY($2::text[])`,
      [ids.length === 0 ? [] : ids, names],
    );
    // Giữ thứ tự khai báo trong env để hành vi dễ đoán, và bỏ trùng.
    const seen = new Set<string>();
    const ordered: AdminRow[] = [];
    for (const admin of result.rows) {
      const match =
        ids.includes(admin.id) || names.includes(admin.username.toLowerCase());
      if (!match || seen.has(admin.email.toLowerCase())) continue;
      seen.add(admin.email.toLowerCase());
      ordered.push(admin);
    }
    return ordered;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

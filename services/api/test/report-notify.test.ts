import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportNotifier } from "../src/admin/notify.js";
import { MemoryMailer, type MailMessage } from "../src/mail.js";
import {
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  sendMessage,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Mail báo admin khi có báo cáo vi phạm mới.
 *
 * Ba thứ dễ sai và đều được kiểm ở đây:
 * 1. Mail chỉ đi tới **admin**, không tới người dùng thường.
 * 2. Gửi báo cáo vẫn thành công kể cả khi mail lỗi/chậm.
 * 3. Không dội hộp thư: nhiều báo cáo liên tiếp chỉ thành một mail, có ghi số
 *    lượng đã gộp.
 */

let ctx: TestContext;
let admin: RegisteredUser;
let admin2: RegisteredUser;
let reporter: RegisteredUser;
let target: RegisteredUser;
let outsider: RegisteredUser;
let guildId: string;
let generalId: string;

beforeAll(async () => {
  // Cooldown dài để test gộp được nhiều báo cáo trong một mail.
  ctx = await createTestContext({
    ADMIN_USERNAMES: "boss,phu_thu",
    REPORT_NOTIFY_COOLDOWN_SEC: "300",
  });
  admin = await registerUser(ctx, "boss");
  admin2 = await registerUser(ctx, "phu_thu");
  reporter = await registerUser(ctx, "mail_reporter");
  target = await registerUser(ctx, "mail_target");
  outsider = await registerUser(ctx, "mail_outsider");
  guildId = await createGuild(ctx, admin.token);
  generalId = (await listChannels(ctx, admin.token, guildId))[0]!.id;

  for (const user of [reporter, target]) {
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(admin.token),
      payload: { channelId: generalId },
    });
    const { code } = invite.json<{ code: string }>();
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(user.token),
    });
  }
});

afterAll(async () => {
  await ctx.close();
});

/**
 * Chỉ lấy mail **báo cáo**: hộp thư dùng chung với mail xác thực email, nên đếm
 * thô `outbox.length` là sai ngay từ lần đăng ký đầu tiên.
 */
function reportMails(mailer: MemoryMailer, address?: string): MailMessage[] {
  const needle = address?.toLowerCase();
  return mailer.outbox.filter(
    (mail) =>
      mail.subject.includes("báo cáo vi phạm") &&
      (needle === undefined || mail.to.toLowerCase() === needle),
  );
}

async function reportMessage(reason: string, details?: string): Promise<void> {
  const message = await sendMessage(ctx, target.token, generalId, "tin bị báo cáo");
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: auth(reporter.token),
    payload: { messageId: message.id, reason, ...(details ? { details } : {}) },
  });
  expect(response.statusCode, String(response.body)).toBe(201);
  await ctx.reportNotifier.whenIdle();
}

describe("mail báo cáo vi phạm", () => {
  it("gửi cho mọi admin có email, không gửi cho người dùng thường", async () => {
    await reportMessage("harassment", "hắn lăng mạ trong #general");

    const bossMails = reportMails(ctx.mailer, "boss@example.com");
    expect(bossMails).toHaveLength(1);
    const first = bossMails[0];
    expect(first).toBeDefined();
    expect(first?.subject).toContain("báo cáo vi phạm mới");
    expect(first?.subject).toContain("Quấy rối");
    expect(first?.text).toContain("mail_target");
    expect(first?.text).toContain("hắn lăng mạ trong #general");
    expect(first?.text).toContain("/admin/reports");

    // Admin thứ hai cũng nhận.
    expect(reportMails(ctx.mailer, "phu_thu@example.com")).toHaveLength(1);
    // Người dùng thường thì không.
    expect(reportMails(ctx.mailer, "mail_outsider@example.com")).toHaveLength(0);
    expect(reportMails(ctx.mailer, "mail_reporter@example.com")).toHaveLength(0);
    expect(reportMails(ctx.mailer, "mail_target@example.com")).toHaveLength(0);
  });

  it("trong thời gian giãn cách: dồn lại, không dội hộp thư", async () => {
    // Mail đầu đã gửi ở test trước (cùng ctx, cooldown 300s) → hai báo cáo này
    // không được sinh thêm mail nào.
    await reportMessage("spam");
    await reportMessage("spam");
    expect(reportMails(ctx.mailer, "boss@example.com")).toHaveLength(1);
  });

  it("hết giãn cách: mail gộp ghi đúng số báo cáo đã dồn", async () => {
    // Đồng hồ giả để kiểm phần gộp mà không phải chờ 5 phút thật.
    let clock = 1_000_000;
    const mailer = new MemoryMailer();
    const notifier = new ReportNotifier({
      pool: ctx.pool,
      config: { ...ctx.config, reportNotifyCooldownSec: 300 },
      mailer,
      now: () => clock,
    });
    const notice = (reportId: string) => ({
      reportId,
      reason: "spam" as const,
      targetUserId: target.id,
      targetDisplayName: "Mail Target",
      guildId: null,
      channelId: null,
      details: null,
    });

    notifier.notifyNewReport(notice("r1"));
    await notifier.whenIdle();
    expect(reportMails(mailer)).toHaveLength(2); // 2 admin
    expect(reportMails(mailer)[0]?.subject).not.toContain("kể từ mail trước");

    // Trong cooldown: 2 báo cáo nữa chỉ dồn lại.
    clock += 30_000;
    notifier.notifyNewReport(notice("r2"));
    notifier.notifyNewReport(notice("r3"));
    await notifier.whenIdle();
    expect(reportMails(mailer)).toHaveLength(2);

    // Hết cooldown: mail tiếp theo gộp cả 3 báo cáo chưa báo.
    clock += 300_000;
    notifier.notifyNewReport(notice("r4"));
    await notifier.whenIdle();
    const mails = reportMails(mailer, "boss@example.com");
    expect(mails).toHaveLength(2);
    expect(mails[1]?.subject).toContain("(3 báo cáo mới kể từ mail trước)");
    expect(mails[1]?.text).toContain("tin nhắn riêng");
    expect(mails[1]?.text).toContain("Không có mô tả thêm.");
  });

  it("cooldown = 0 thì mỗi báo cáo một mail, nội dung đánh số đúng", async () => {
    const mailer = new MemoryMailer();
    const notifier = new ReportNotifier({
      pool: ctx.pool,
      config: { ...ctx.config, reportNotifyCooldownSec: 0 },
      mailer,
    });
    for (const reason of ["spam", "violence"] as const) {
      notifier.notifyNewReport({
        reportId: reason,
        reason,
        targetUserId: target.id,
        targetDisplayName: "Mail Target",
        guildId,
        channelId: generalId,
        details: null,
      });
      await notifier.whenIdle();
    }
    // 2 báo cáo × 2 admin.
    expect(reportMails(mailer)).toHaveLength(4);
    // Gộp 1 báo cáo thì không có phần "(N báo cáo mới…)".
    const mails = reportMails(mailer);
    expect(mails[0]?.subject).not.toContain("báo cáo mới kể từ mail trước");
    expect(mails[0]?.subject).toContain("Spam");
    expect(mails[2]?.subject).toContain("Bạo lực");
    expect(mails[0]?.text).toContain("trong server");
  });

  it("mailer ném lỗi: chỉ ghi log, không ném ra đường gửi báo cáo", async () => {
    const logged: string[] = [];
    const failing = new ReportNotifier({
      pool: ctx.pool,
      config: { ...ctx.config, reportNotifyCooldownSec: 0 },
      mailer: {
        send: async () => {
          throw new Error("SMTP chết");
        },
      },
      write: (line) => logged.push(line),
    });
    failing.notifyNewReport({
      reportId: "boom",
      reason: "other",
      targetUserId: target.id,
      targetDisplayName: "Mail Target",
      guildId: null,
      channelId: null,
      details: null,
    });
    // `whenIdle` không được ném — lỗi SMTP chỉ nằm trong log.
    await expect(failing.whenIdle()).resolves.toBeUndefined();
    expect(logged.some((line) => line.includes("SMTP chết"))).toBe(true);
  });

  it("tắt bằng REPORT_NOTIFY_EMAIL=off", async () => {
    const off = await createTestContext({
      ADMIN_USERNAMES: "off_boss",
      REPORT_NOTIFY_EMAIL: "off",
    });
    const boss = await registerUser(off, "off_boss");
    const reporter2 = await registerUser(off, "off_reporter");
    const target2 = await registerUser(off, "off_target");
    const gid = await createGuild(off, boss.token);
    const cid = (await listChannels(off, boss.token, gid))[0]!.id;
    const invite = await off.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${gid}/invites`,
      headers: auth(boss.token),
      payload: { channelId: cid },
    });
    const code = invite.json<{ code: string }>().code;
    for (const user of [reporter2, target2]) {
      await off.app.inject({
        method: "POST",
        url: `/api/v1/invites/${code}`,
        headers: auth(user.token),
      });
    }
    const message = await sendMessage(off, boss.token, cid, "tin bị báo cáo");
    const response = await off.app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: auth(reporter2.token),
      payload: { messageId: message.id, reason: "spam" },
    });
    expect(response.statusCode).toBe(201);
    await off.reportNotifier.whenIdle();
    expect(reportMails(off.mailer)).toHaveLength(0);
    await off.close();
    expect(boss.id.length).toBeGreaterThan(0);
  });
});

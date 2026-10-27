import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdminReportPage } from "@umaru/protocol";
import { isAdmin } from "../src/admin/access.js";
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

let ctx: TestContext;
let admin: RegisteredUser;
let reporter: RegisteredUser;
let target: RegisteredUser;
let guildId: string;
let generalId: string;

beforeAll(async () => {
  // Admin khai báo bằng username (đường dev hay dùng), phần id test riêng bên dưới.
  ctx = await createTestContext({ ADMIN_USERNAMES: "boss, Phu-Thu" });
  admin = await registerUser(ctx, "boss");
  reporter = await registerUser(ctx, "reporter");
  target = await registerUser(ctx, "target");
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

async function makeReport(index: number): Promise<string> {
  const message = await sendMessage(ctx, target.token, generalId, `nội dung vi phạm #${index}`);
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/reports",
    headers: auth(reporter.token),
    payload: { messageId: message.id, reason: "harassment" },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

const listReports = (token: string, query = "") =>
  ctx.app.inject({
    method: "GET",
    url: `/api/v1/admin/reports${query}`,
    headers: auth(token),
  });

describe("kiểm quyền admin", () => {
  it("isAdmin so khớp id và username (không phân biệt hoa/thường), rỗng = không ai", () => {
    const base = { ...ctx.config };
    expect(isAdmin({ ...base, adminUserIds: ["42"], adminUsernames: [] }, {
      id: "42",
      username: "x",
    })).toBe(true);
    expect(isAdmin({ ...base, adminUserIds: [], adminUsernames: ["boss"] }, {
      id: "1",
      username: "BOSS",
    })).toBe(true);
    expect(isAdmin({ ...base, adminUserIds: [], adminUsernames: [] }, {
      id: "42",
      username: "boss",
    })).toBe(false);
  });

  it("GET /admin/status trả đúng cờ admin cho từng người", async () => {
    const adminStatus = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/status",
      headers: auth(admin.token),
    });
    expect(adminStatus.json<{ admin: boolean }>().admin).toBe(true);

    const normal = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/status",
      headers: auth(reporter.token),
    });
    expect(normal.json<{ admin: boolean }>().admin).toBe(false);
  });

  it("người thường: 403 ở cả danh sách lẫn đổi trạng thái; chưa đăng nhập: 401", async () => {
    expect((await listReports(reporter.token)).statusCode).toBe(403);

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/reports/1",
      headers: auth(reporter.token),
      payload: { status: "closed" },
    });
    expect(patch.statusCode).toBe(403);

    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/admin/reports" })).statusCode).toBe(
      401,
    );
  });

  it("đăng nhập bằng username thứ hai trong danh sách cũng là admin", async () => {
    const second = await registerUser(ctx, "phu-thu");
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/status",
      headers: auth(second.token),
    });
    expect(response.json<{ admin: boolean }>().admin).toBe(true);
  });
});

describe("hàng đợi báo cáo", () => {
  it("danh sách: mới nhất trước, kèm snapshot + người báo cáo + người bị báo cáo", async () => {
    const first = await makeReport(1);
    const second = await makeReport(2);

    const response = await listReports(admin.token);
    expect(response.statusCode).toBe(200);
    const page = response.json<AdminReportPage>();

    expect(page.reports[0]?.id).toBe(second);
    expect(page.reports.some((report) => report.id === first)).toBe(true);
    const latest = page.reports[0]!;
    expect(latest.reason).toBe("harassment");
    expect(latest.snapshotContent).toContain("nội dung vi phạm #2");
    expect(latest.reporter.userId).toBe(reporter.id);
    expect(latest.target.userId).toBe(target.id);
    expect(latest.channelName).toBe("general");
    expect(latest.guildName).toBe("Umaru Dev");
    expect(latest.status).toBe("open");
  });

  it("không trả email của người báo cáo hay người bị báo cáo", async () => {
    const response = await listReports(admin.token);
    expect(response.body).not.toContain("@example.com");
  });

  it("lọc theo status và đếm theo từng trạng thái", async () => {
    await makeReport(3);
    const openOnly = await listReports(admin.token, "?status=open");
    expect(openOnly.statusCode).toBe(200);
    expect(openOnly.json<AdminReportPage>().reports.every((r) => r.status === "open")).toBe(true);

    const closedOnly = await listReports(admin.token, "?status=closed");
    expect(closedOnly.json<AdminReportPage>().reports).toHaveLength(0);

    const counts = closedOnly.json<AdminReportPage>().counts;
    expect(counts.open).toBeGreaterThan(0);
  });

  it("status lạ → 400; limit ngoài khoảng → 400; before sai → 400", async () => {
    expect((await listReports(admin.token, "?status=bịa")).statusCode).toBe(400);
    expect((await listReports(admin.token, "?limit=0")).statusCode).toBe(400);
    expect((await listReports(admin.token, "?before=abc")).statusCode).toBe(400);
  });

  it("phân trang bằng cursor before không trùng dòng", async () => {
    const page1 = (await listReports(admin.token, "?limit=2")).json<AdminReportPage>();
    expect(page1.reports).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    const page2 = (
      await listReports(admin.token, `?limit=2&before=${page1.reports[1]!.id}`)
    ).json<AdminReportPage>();
    const ids1 = new Set(page1.reports.map((report) => report.id));
    expect(page2.reports.every((report) => !ids1.has(report.id))).toBe(true);
    // Cursor dùng id (snowflake) nên luôn giảm dần.
    expect(Number(page2.reports[0]?.id ?? 0)).toBeLessThan(Number(page1.reports[1]!.id));
  });

  it("đổi trạng thái: open → reviewing → closed, trả bản ghi đã cập nhật", async () => {
    const id = await makeReport(10);

    const reviewing = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/reports/${id}`,
      headers: auth(admin.token),
      payload: { status: "reviewing" },
    });
    expect(reviewing.statusCode).toBe(200);
    expect(reviewing.json<{ status: string }>().status).toBe("reviewing");

    const closed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/reports/${id}`,
      headers: auth(admin.token),
      payload: { status: "closed" },
    });
    expect(closed.json<{ status: string }>().status).toBe("closed");

    // Đóng rồi thì biến khỏi tab open, và đổi lại lần nữa vẫn idempotent.
    const open = (await listReports(admin.token, "?status=open")).json<AdminReportPage>();
    expect(open.reports.some((report) => report.id === id)).toBe(false);

    const again = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/reports/${id}`,
      headers: auth(admin.token),
      payload: { status: "closed" },
    });
    expect(again.statusCode).toBe(200);
  });

  it("đổi trạng thái sai: status lạ → 400, báo cáo không tồn tại → 404, id không phải số → 400", async () => {
    const id = await makeReport(11);
    const badStatus = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/reports/${id}`,
      headers: auth(admin.token),
      payload: { status: "deleted" },
    });
    expect(badStatus.statusCode).toBe(400);

    const missing = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/reports/999999999999999999",
      headers: auth(admin.token),
      payload: { status: "closed" },
    });
    expect(missing.statusCode).toBe(404);

    const badId = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/reports/abc",
      headers: auth(admin.token),
      payload: { status: "closed" },
    });
    expect(badId.statusCode).toBe(400);
  });

  it("báo cáo người (không kèm tin) vẫn hiện trong hàng đợi với snapshot null", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/reports",
      headers: auth(reporter.token),
      payload: { userId: target.id, reason: "impersonation", details: "giả danh admin" },
    });
    const id = created.json<{ id: string }>().id;

    const page = (await listReports(admin.token, "?status=open")).json<AdminReportPage>();
    const row = page.reports.find((report) => report.id === id);
    expect(row).toBeDefined();
    expect(row!.snapshotContent).toBeNull();
    expect(row!.messageId).toBeNull();
    expect(row!.details).toBe("giả danh admin");
    expect(row!.reason).toBe("impersonation");
  });
});

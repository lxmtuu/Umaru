import { describe, expect, it } from "vitest";
import { ADMIN_REPORTS_PATH, readAdminRoute } from "./adminRoute.js";

describe("readAdminRoute", () => {
  it("nhận /admin/reports, có dấu / cuối hoặc chữ hoa", () => {
    expect(readAdminRoute("/admin/reports")).toBe("reports");
    expect(readAdminRoute("/admin/reports/")).toBe("reports");
    expect(readAdminRoute("/Admin/Reports")).toBe("reports");
    expect(ADMIN_REPORTS_PATH).toBe("/admin/reports");
  });

  it("đường dẫn khác → null để app xử lý bình thường", () => {
    expect(readAdminRoute("/")).toBeNull();
    expect(readAdminRoute("/admin")).toBeNull();
    expect(readAdminRoute("/admin/reports/7")).toBeNull();
    expect(readAdminRoute("/terms")).toBeNull();
  });
});

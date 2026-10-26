import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchHtml } from "../src/embeds/fetch.js";

/**
 * Hàng rào SSRF của bộ tải trang.
 *
 * Điểm quan trọng: nội dung tin nhắn do người dùng nhập, nên `http://127.0.0.1:…`
 * và `http://169.254.169.254/…` phải **không** bao giờ được server gọi tới. Test
 * dựng server thật trên loopback để chứng minh điều đó — không mock.
 */

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<meta property="og:title" content="Trang thử"><meta name="description" content="mô tả">`,
      );
      return;
    }
    if (url === "/redirect") {
      response.writeHead(302, { location: "/page" });
      response.end();
      return;
    }
    if (url === "/pdf") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.7");
      return;
    }
    if (url === "/big") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<meta property="og:title" content="${"x".repeat(4096)}">`);
      return;
    }
    if (url === "/empty-type") {
      response.writeHead(200);
      response.end("<html></html>");
      return;
    }
    response.writeHead(404, { "content-type": "text/html" });
    response.end("không có");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const permissive = { timeoutMs: 2_000, maxBytes: 4096, allowPrivateHosts: true };
const guarded = { timeoutMs: 2_000, maxBytes: 4096, allowPrivateHosts: false };

describe("fetchHtml", () => {
  it("chặn loopback khi không cho phép host nội bộ", async () => {
    await expect(fetchHtml(`${base}/page`, guarded)).rejects.toThrow(/chặn địa chỉ nội bộ/u);
    // `localhost` cũng phân giải ra ::1/127.0.0.1 → cùng bị chặn.
    await expect(fetchHtml("http://localhost:9/page", guarded)).rejects.toThrow(/chặn/u);
  });

  it("cho phép khi bật allowPrivateHosts (chỉ dev/test)", async () => {
    const page = await fetchHtml(`${base}/page`, permissive);
    expect(page.html).toContain("og:title");
    expect(page.finalUrl).toBe(`${base}/page`);
  });

  it("theo redirect và trả URL cuối", async () => {
    const page = await fetchHtml(`${base}/redirect`, permissive);
    expect(page.finalUrl).toBe(`${base}/page`);
    expect(page.html).toContain("Trang thử");
  });

  it("từ chối trang không phải HTML", async () => {
    await expect(fetchHtml(`${base}/pdf`, permissive)).rejects.toThrow(/HTML/u);
    await expect(fetchHtml(`${base}/empty-type`, permissive)).rejects.toThrow(/HTML/u);
  });

  it("từ chối trang lớn hơn trần", async () => {
    await expect(fetchHtml(`${base}/big`, { ...permissive, maxBytes: 1024 })).rejects.toThrow(
      /lớn hơn/u,
    );
  });

  it("404 là lỗi, không phải trang rỗng", async () => {
    await expect(fetchHtml(`${base}/khong-co`, permissive)).rejects.toThrow(/HTTP 404/u);
  });

  it("giao thức không phải http(s) bị từ chối ngay", async () => {
    await expect(fetchHtml("file:///etc/passwd", permissive)).rejects.toThrow(/giao thức/u);
  });
});

import { describe, expect, it } from "vitest";
import { resolveGatewayUrl } from "./gatewayUrl.js";

/**
 * Lỗi thật đã xảy ra khi QA bằng preview: API trả `ws://…`, trang mở bằng
 * `https://`, trình duyệt chặn mixed content **không báo gì** → gateway không
 * kết nối được, người dùng thấy "không có server nào" và tạo server xong cũng
 * không thấy. Bộ test này khoá đúng hành vi đó.
 */
describe("resolveGatewayUrl", () => {
  const httpsPage = { protocol: "https:", host: "4173-abc.e2b.app" };
  const httpPage = { protocol: "http:", host: "localhost:4173" };

  it("trang https + server trả ws:// → nâng lên wss (đây là bug gốc)", () => {
    expect(resolveGatewayUrl("ws://4173-abc.e2b.app/api/v1/gateway/ws", httpsPage)).toBe(
      "wss://4173-abc.e2b.app/api/v1/gateway/ws",
    );
  });

  it("trang https + server trả http:// → wss", () => {
    expect(resolveGatewayUrl("http://api.example.com/api/v1/gateway/ws", httpsPage)).toBe(
      "wss://api.example.com/api/v1/gateway/ws",
    );
  });

  it("trang http giữ nguyên ws:// (dev local không cần TLS)", () => {
    expect(resolveGatewayUrl("ws://localhost:4000/api/v1/gateway/ws", httpPage)).toBe(
      "ws://localhost:4000/api/v1/gateway/ws",
    );
  });

  it("trang http nhưng server đã trả wss → giữ wss, không hạ cấp", () => {
    expect(resolveGatewayUrl("wss://gw.example.com/api/v1/gateway/ws", httpPage)).toBe(
      "wss://gw.example.com/api/v1/gateway/ws",
    );
  });

  it("host khác trang vẫn được giữ (gateway riêng, ví dụ sharding sau này)", () => {
    expect(resolveGatewayUrl("wss://gw1.example.com/api/v1/gateway/ws", httpsPage)).toBe(
      "wss://gw1.example.com/api/v1/gateway/ws",
    );
  });

  it("server trả host:port nội bộ nhưng cùng trang → dùng host của trang", () => {
    // API tự suy từ `Host` header nên có thể ra cổng nội bộ; đi qua proxy của
    // trang mới đúng.
    expect(resolveGatewayUrl("ws://127.0.0.1:4000/api/v1/gateway/ws", httpsPage)).toBe(
      "wss://127.0.0.1:4000/api/v1/gateway/ws",
    );
  });

  it("đường dẫn tương đối → ghép với host của trang", () => {
    expect(resolveGatewayUrl("/api/v1/gateway/ws", httpsPage)).toBe(
      "wss://4173-abc.e2b.app/api/v1/gateway/ws",
    );
  });

  it("giữ nguyên query string", () => {
    expect(resolveGatewayUrl("wss://a.example.com/gw?v=1", httpsPage)).toBe(
      "wss://a.example.com/gw?v=1",
    );
  });

  it("URL hỏng hoặc scheme lạ → ném lỗi tiếng Việt rõ ràng", () => {
    expect(() => resolveGatewayUrl("khong-phai-url", httpsPage)).toThrow(/không hợp lệ/);
    expect(() => resolveGatewayUrl("ftp://example.com/gw", httpsPage)).toThrow(/không hợp lệ/);
  });

  it("không có DOM (test/SSR) vẫn chạy, mặc định coi là trang http", () => {
    expect(resolveGatewayUrl("ws://localhost:4000/api/v1/gateway/ws", { protocol: "http:", host: "" })).toBe(
      "ws://localhost:4000/api/v1/gateway/ws",
    );
  });
});

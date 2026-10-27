import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  firstUrl,
  isBlockedAddress,
  parseEmbedHtml,
} from "../src/embeds/extract.js";

/**
 * Phần thuần của embed: tìm URL, chặn địa chỉ nội bộ, đọc thẻ meta.
 *
 * Đây là chỗ dễ sai âm thầm nhất (regex cắt nhầm dấu câu, `og:image` tương đối,
 * entity HTML) nên test bằng chuỗi thay vì phải dựng server.
 */

describe("firstUrl", () => {
  it("lấy URL đầu tiên, bỏ dấu câu cuối câu", () => {
    expect(firstUrl("xem https://umaru.app/docs.")).toBe("https://umaru.app/docs");
    expect(firstUrl("(xem https://umaru.app/a)")).toBe("https://umaru.app/a");
    expect(firstUrl("https://a.com/x?y=1, https://b.com")).toBe("https://a.com/x?y=1");
  });

  it("giữ ngoặc cân bằng trong URL thật", () => {
    expect(firstUrl("https://en.wikipedia.org/wiki/Umaru_(app)")).toBe(
      "https://en.wikipedia.org/wiki/Umaru_(app)",
    );
    expect(firstUrl("https://en.wikipedia.org/wiki/Umaru_(app))")).toBe(
      "https://en.wikipedia.org/wiki/Umaru_(app)",
    );
  });

  it("bỏ qua URL nằm trong code — đó là văn bản, không phải liên kết", () => {
    expect(firstUrl("`https://umaru.app`")).toBeNull();
    expect(firstUrl("```\nhttps://umaru.app\n```")).toBeNull();
    expect(firstUrl("`https://a.com` rồi https://b.com")).toBe("https://b.com/");
  });

  it("không có URL, hoặc giao thức lạ → null", () => {
    expect(firstUrl("không có link nào")).toBeNull();
    expect(firstUrl("ftp://a.com/file")).toBeNull();
    expect(firstUrl("mailto:ai@example.com")).toBeNull();
  });
});

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "192.0.2.10", // TEST-NET-1
    "224.0.0.1", // multicast
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"];

  it.each(blocked)("chặn %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(allowed)("cho %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("chuỗi không phải IP → chặn (an toàn khi phân giải lỗi)", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("parseEmbedHtml", () => {
  it("đọc đủ bộ thẻ og", () => {
    const html = `<html><head>
      <meta property="og:title" content="Umaru — chat cho dev" />
      <meta property="og:description" content="Nhắn tin, gọi thoại, chia sẻ code." />
      <meta property="og:site_name" content="Umaru" />
      <meta property="og:image" content="https://cdn.umaru.app/cover.png" />
    </head></html>`;
    expect(parseEmbedHtml(html, "https://umaru.app")).toEqual({
      url: "https://umaru.app",
      title: "Umaru — chat cho dev",
      description: "Nhắn tin, gọi thoại, chia sẻ code.",
      siteName: "Umaru",
      imageUrl: "https://cdn.umaru.app/cover.png",
    });
  });

  it("thiếu og → lùi về twitter, rồi tới <title> và meta description", () => {
    const html = `<head>
      <title>  Trang
        nhiều dòng  </title>
      <meta name="twitter:description" content="Mô tả twitter" />
      <meta name="twitter:image" content="/anh.png" />
    </head>`;
    const embed = parseEmbedHtml(html, "https://a.com/bai-viet");
    expect(embed?.title).toBe("Trang nhiều dòng");
    expect(embed?.description).toBe("Mô tả twitter");
    // Ảnh tương đối phải ghép với URL trang, nếu không ra 404.
    expect(embed?.imageUrl).toBe("https://a.com/anh.png");
    // Không khai site_name → lấy tên miền, thẻ không bị trống phần đầu.
    expect(embed?.siteName).toBe("a.com");
  });

  it("giải entity HTML và gộp khoảng trắng", () => {
    const html = `<meta property="og:title" content="A &amp; B &#39;ok&#39; &quot;nè&quot;">`;
    expect(parseEmbedHtml(html, "https://a.com")?.title).toBe(`A & B 'ok' "nè"`);
  });

  it("cắt tiêu đề quá dài bằng dấu ba chấm", () => {
    const long = "a".repeat(500);
    const embed = parseEmbedHtml(`<meta property="og:title" content="${long}">`, "https://a.com");
    expect(embed?.title?.length).toBe(200);
    expect(embed?.title?.endsWith("…")).toBe(true);
  });

  it("trang không có thông tin gì → null (không hiện thẻ rỗng)", () => {
    expect(parseEmbedHtml("<html><body>xin chào</body></html>", "https://a.com")).toBeNull();
    expect(parseEmbedHtml(`<title>   </title>`, "https://a.com")).toBeNull();
  });

  it("og:image giao thức lạ bị bỏ, phần chữ vẫn còn", () => {
    const embed = parseEmbedHtml(
      `<meta property="og:title" content="T"><meta property="og:image" content="javascript:alert(1)">`,
      "https://a.com",
    );
    expect(embed?.title).toBe("T");
    expect(embed?.imageUrl).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("giải mã số thập phân, hex và tên", () => {
    expect(decodeEntities("&#65;&#x42;&amp;&nbsp;")).toBe("AB& ");
  });

  it("entity lạ hoặc mã sai → giữ nguyên văn", () => {
    expect(decodeEntities("&khongbiet; & #zz;")).toBe("&khongbiet; & #zz;");
  });
});

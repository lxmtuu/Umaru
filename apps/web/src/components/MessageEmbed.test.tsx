import type { Embed } from "@umaru/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageEmbeds } from "./MessageEmbed.js";

/**
 * Thẻ embed chỉ là hiển thị: không tải gì từ client, không có logic quyền.
 * Test render tĩnh đủ để khoá các trường hợp làm vỡ layout (thiếu tiêu đề, ảnh
 * chết, không khai siteName).
 */
function embed(overrides: Partial<Embed> = {}): Embed {
  return {
    url: "https://umaru.app/blog/post",
    title: "Umaru — chat cho dev",
    description: "Nhắn tin, gọi thoại, chia sẻ code.",
    siteName: "Umaru Blog",
    imageUrl: "https://cdn.umaru.app/cover.png",
    ...overrides,
  };
}

describe("MessageEmbeds", () => {
  it("không có embed → không render gì", () => {
    expect(renderToStaticMarkup(<MessageEmbeds embeds={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<MessageEmbeds embeds={[]} />)).toBe("");
  });

  it("render đủ tiêu đề, mô tả, tên trang và ảnh", () => {
    const html = renderToStaticMarkup(<MessageEmbeds embeds={[embed()]} />);
    expect(html).toContain("Umaru — chat cho dev");
    expect(html).toContain("Nhắn tin, gọi thoại, chia sẻ code.");
    expect(html).toContain("Umaru Blog");
    expect(html).toContain('href="https://umaru.app/blog/post"');
    expect(html).toContain('src="https://cdn.umaru.app/cover.png"');
    // Mở tab mới, không cho trang đích đụng vào app.
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("không có ảnh → không có thẻ <img>", () => {
    const html = renderToStaticMarkup(<MessageEmbeds embeds={[embed({ imageUrl: null })]} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("Umaru — chat cho dev");
  });

  it("thiếu siteName → lấy tên miền từ URL", () => {
    const html = renderToStaticMarkup(<MessageEmbeds embeds={[embed({ siteName: null })]} />);
    expect(html).toContain("umaru.app");
  });

  it("embed chỉ có URL vẫn render được (không vỡ khi mọi trường null)", () => {
    const html = renderToStaticMarkup(
      <MessageEmbeds
        embeds={[embed({ title: null, description: null, siteName: null, imageUrl: null })]}
      />,
    );
    expect(html).toContain("https://umaru.app/blog/post");
    expect(html).not.toContain("undefined");
  });
});

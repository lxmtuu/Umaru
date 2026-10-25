import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageContent } from "./MessageContent.js";

const render = (content: string) => renderToStaticMarkup(<MessageContent content={content} />);

describe("MessageContent", () => {
  it("render markdown thành element thật", () => {
    const html = render("**đậm** và `code`");
    expect(html).toContain("<strong");
    expect(html).toContain("đậm");
    expect(html).toContain("<code");
    expect(html).toContain("code");
    // Không lộ dấu markdown ra ngoài.
    expect(html).not.toContain("**");
    expect(html).not.toContain("`");
  });

  it("code block giữ nguyên nội dung và hiện nhãn ngôn ngữ", () => {
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("ts");
  });

  it("link mở tab mới với rel an toàn", () => {
    const html = render("xem https://umaru.dev nhé");
    expect(html).toContain('href="https://umaru.dev"');
    expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it("HTML thô trong tin nhắn bị escape, không chạy", () => {
    const html = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("tin nhắn rỗng render không có gì", () => {
    expect(render("")).toBe("");
    expect(render("   \n  ")).toBe("");
  });

  it("@mention được highlight", () => {
    const html = render("chào @alice_smoke");
    expect(html).toContain("@alice_smoke");
    expect(html).toContain("text-emerald-300");
  });
});

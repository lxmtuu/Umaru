import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar.js";

/**
 * Test render tĩnh (không có DOM): chỉ kiểm trạng thái **chưa có ảnh**, vì ảnh
 * cần `useEffect` + fetch nên không chạy trong `renderToStaticMarkup`.
 */
describe("Avatar", () => {
  it("chưa có ảnh → hiện chữ cái đầu, không có <img>", () => {
    const html = renderToStaticMarkup(<Avatar avatarUrl={null} name="minh" />);
    expect(html).toContain("M");
    expect(html).not.toContain("<img");
  });

  it("tên rỗng vẫn không vỡ layout", () => {
    const html = renderToStaticMarkup(<Avatar avatarUrl={undefined} name="" />);
    expect(html).toContain("?");
  });

  it("nhận class kích thước tuỳ chỉnh", () => {
    const html = renderToStaticMarkup(
      <Avatar avatarUrl={null} name="an" size="size-16" textClass="text-xl" />,
    );
    expect(html).toContain("size-16");
    expect(html).toContain("text-xl");
    expect(html).toContain("rounded-full");
  });
});

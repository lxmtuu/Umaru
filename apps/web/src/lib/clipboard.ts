/**
 * Chép chữ vào clipboard, có đường lùi cho trình duyệt/ngữ cảnh không cho dùng
 * Clipboard API.
 *
 * Vì sao không gọi thẳng `navigator.clipboard.writeText`:
 *   - Clipboard API chỉ có ở **secure context** (https hoặc localhost). Bản chạy
 *     thử bằng http trong LAN sẽ không có `navigator.clipboard`.
 *   - Firefox/Safari từng từ chối khi không có "user gesture" đúng lúc, và iOS
 *     Safari cần `document.execCommand` cho vài trường hợp.
 *
 * Nên: thử API mới, hỏng thì dùng `execCommand("copy")` trên một `<textarea>` ẩn
 * (cách cũ nhưng vẫn chạy rộng rãi), và **báo lại** thành công/thất bại để UI
 * biết có nên hiện "Đã sao chép" hay không — im lặng nuốt lỗi thì người dùng
 * tưởng đã chép, dán ra lại thấy nội dung cũ.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Rơi xuống đường lùi bên dưới.
    }
  }
  return legacyCopy(text);
}

/** `execCommand` qua textarea ẩn — đường lùi cho ngữ cảnh không có Clipboard API. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // `readonly` để bàn phím ảo trên mobile không bật lên; `position: fixed` +
  // toạ độ âm để không nhảy scroll.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    area.select();
    // `execCommand` là API cũ (đã deprecated) nhưng vẫn là đường lùi duy nhất
    // khi Clipboard API không dùng được — không có API thay thế.
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    // Trả lại vùng chọn cũ: xoá sạch thì người dùng mất chỗ đang đọc.
    if (selection !== null && previous !== null) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

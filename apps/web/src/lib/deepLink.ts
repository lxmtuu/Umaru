/**
 * Deep link `?channel=<id>&message=<id>` — dùng khi người dùng bấm vào một thông
 * báo đẩy, hoặc bấm **"Sao chép liên kết"** trong menu chuột phải của một tin.
 *
 * Service worker mở `/?channel=…`; app đọc tham số này **một lần** rồi xoá khỏi
 * URL. Xoá là bắt buộc: để nguyên thì mỗi lần F5 lại nhảy về kênh cũ, và tham
 * số đó còn bị sao chép khi người dùng chia sẻ link.
 *
 * `message` là tuỳ chọn và **chỉ có nghĩa khi có `channel`**: mở đúng kênh rồi
 * cuộn tới đúng tin (tô sáng vài giây để mắt tìm ra). Link dán vào chat của
 * chính mình cũng chạy được nhờ vậy.
 *
 * Hàm thuần để test được (không đụng `window`): nhận `search` và trả về id cần
 * mở cùng query string đã làm sạch.
 */
export function readChannelDeepLink(search: string): {
  channelId: string | null;
  messageId: string | null;
  cleanedSearch: string;
} {
  // Giữ nguyên chuỗi gốc khi không có tham số: tránh tự ý chuẩn hoá URL của
  // người dùng (ví dụ `?lang=vi&` vẫn phải y như cũ).
  if (!search.includes("channel=")) {
    return { channelId: null, messageId: null, cleanedSearch: search };
  }
  const params = new URLSearchParams(search);
  const raw = params.get("channel");
  const rawMessage = params.get("message");
  params.delete("channel");
  params.delete("message");
  const rest = params.toString();
  const cleanedSearch = rest.length === 0 ? "" : `?${rest}`;
  // Chỉ nhận snowflake dạng số: id rác trong URL không được làm app gọi API 404.
  const channelId = raw !== null && /^\d{1,20}$/.test(raw) ? raw : null;
  const messageId =
    channelId !== null && rawMessage !== null && /^\d{1,20}$/.test(rawMessage)
      ? rawMessage
      : null;
  return { channelId, messageId, cleanedSearch };
}

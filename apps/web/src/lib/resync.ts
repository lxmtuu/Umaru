import type { Message } from "@umaru/protocol";

/**
 * Ghép danh sách tin vừa tải lại từ server vào danh sách đang có trong bộ nhớ,
 * sau khi socket **resume** (mục 42: session + replay log nằm ở Redis).
 *
 * Vì sao phải tải lại chứ không tin replay: replay chỉ phát lại những frame còn
 * trong log. Node chết/đổi node thì có một cửa sổ frame bị mất, và frame mất có
 * thể là `MESSAGE_DELETE` — tin đã xoá vẫn nằm trong khung chat của người dùng
 * cho tới lần F5. Tải lại trang tin mới nhất của kênh đang mở là cách duy nhất
 * sửa được **cả** tin thiếu **và** tin thừa.
 *
 * Nhưng không thể thay cả danh sách bằng 50 tin mới nhất: người dùng có thể đã
 * cuộn lên đọc lịch sử (những trang cũ hơn nằm trong `messages`), thay cả danh
 * sách là mất chỗ đang đọc. Nên chỉ thay đúng **cửa sổ** mà server vừa trả về:
 *
 *  - cũ hơn tin cũ nhất trong cửa sổ → giữ (lịch sử đã tải trước đó);
 *  - trong cửa sổ → **server thắng** (tin bị xoá lúc mất mạng biến mất, tin bị
 *    sửa hiện nội dung mới);
 *  - mới hơn tin mới nhất trong cửa sổ → giữ (tới qua replay/live, server chưa
 *    kịp thấy hoặc trang vừa trả chưa gồm).
 *
 * Kết quả sắp tăng dần theo id (snowflake ⇒ theo thời gian), không trùng.
 */
export function mergeAfterResync(existing: Message[], fresh: Message[]): Message[] {
  if (fresh.length === 0) return existing;

  let oldest = fresh[0]!.id;
  let newest = fresh[0]!.id;
  for (const message of fresh) {
    if (BigInt(message.id) < BigInt(oldest)) oldest = message.id;
    if (BigInt(message.id) > BigInt(newest)) newest = message.id;
  }

  const merged = new Map<string, Message>();
  for (const message of existing) {
    // Bỏ những tin nằm trong cửa sổ cũ: chúng sẽ được thay bằng bản của server.
    const insideWindow =
      BigInt(message.id) >= BigInt(oldest) && BigInt(message.id) <= BigInt(newest);
    if (!insideWindow) merged.set(message.id, message);
  }
  for (const message of fresh) merged.set(message.id, message);

  return [...merged.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

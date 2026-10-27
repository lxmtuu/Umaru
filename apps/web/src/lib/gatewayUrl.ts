/**
 * Chuẩn hoá URL gateway mà server trả về cho khớp trang đang mở.
 *
 * Vì sao cần: API trả `ws://…` khi nó không biết mình đang nằm sau proxy TLS
 * (ví dụ `vite preview` — proxy này không gửi `X-Forwarded-Proto`). Trang thì
 * được mở bằng `https://`, và trình duyệt **chặn im lặng** WebSocket `ws://` vì
 * mixed content: không có lỗi nào hiện ra cho người dùng, chỉ là gateway không
 * kết nối được → không có `READY` → không thấy server, không thấy DM, tạo server
 * thì API trả 201 mà giao diện vẫn trống.
 *
 * Nên không tin scheme server trả về: trang https thì luôn nâng lên `wss`.
 */

export interface PageLocation {
  /** `window.location.protocol`, ví dụ `"https:"`. */
  protocol: string;
  /** `window.location.host`, ví dụ `"4173-abc.e2b.app"`. Rỗng khi không có DOM. */
  host: string;
}

function currentPage(): PageLocation {
  if (typeof window === "undefined") return { protocol: "http:", host: "" };
  return { protocol: window.location.protocol, host: window.location.host };
}

/** `http(s)` → `ws(s)`; giá trị khác coi là không hợp lệ. */
function toSocketScheme(protocol: string): "ws" | "wss" | null {
  switch (protocol) {
    case "ws:":
    case "http:":
      return "ws";
    case "wss:":
    case "https:":
      return "wss";
    default:
      return null;
  }
}

/**
 * @param raw URL server trả về (`ws://`, `wss://`, `http(s)://`, hoặc đường dẫn
 *   tương đối `/api/v1/gateway/ws`).
 * @param page vị trí trang hiện tại — mặc định `window.location`, để trống được
 *   khi chạy test/SSR.
 * @throws khi URL không đọc được hoặc scheme lạ.
 */
export function resolveGatewayUrl(raw: string, page: PageLocation = currentPage()): string {
  const relative = raw.startsWith("/");
  let url: URL;
  try {
    // Cần base có scheme để `URL` chấp nhận đường dẫn tương đối; host để trống
    // thì `new URL` ném lỗi nên dùng host giả rồi ghép lại như dưới.
    url = relative
      ? new URL(raw, `http://${page.host === "" ? "placeholder.invalid" : page.host}`)
      : new URL(raw);
  } catch {
    throw new Error(`URL gateway không hợp lệ: ${raw}`);
  }

  const scheme = toSocketScheme(url.protocol);
  if (scheme === null) throw new Error(`URL gateway không hợp lệ: ${raw}`);

  const securePage = page.protocol === "https:";
  // Cùng host nghĩa là đi qua chính proxy đang phục vụ trang (preview, nginx,
  // dev server) → bám theo scheme của trang, đừng tin cổng/host server tự đoán.
  const sameHost = page.host !== "" && url.host === page.host;
  const finalScheme = securePage ? "wss" : scheme;

  return `${finalScheme}://${sameHost ? page.host : url.host}${url.pathname}${url.search}`;
}

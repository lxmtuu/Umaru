/**
 * Service worker của Umaru — chỉ làm đúng một việc: nhận thông báo đẩy và mở
 * app khi bấm vào.
 *
 * Vì sao phải có service worker: khi tab đóng thì **không còn JavaScript nào
 * của app chạy**. Chỉ service worker còn sống, nên đây là chỗ duy nhất hiện
 * được thông báo.
 *
 * File này chạy trong một global khác (không có `window`, không có bundler):
 * cố ý để JS thuần, không import gì, để nó không phụ thuộc build của app. Nội
 * dung payload do `services/api/src/push/sender.ts` quyết định — đổi một khoá ở
 * đó thì phải đổi ở đây.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data === null ? {} : event.data.json();
  } catch {
    // Payload không phải JSON (không nên xảy ra): vẫn hiện gì đó thay vì im lặng.
    data = { body: event.data === null ? "" : event.data.text() };
  }
  const title = typeof data.title === "string" && data.title.length > 0 ? data.title : "Umaru";
  const body = typeof data.body === "string" ? data.body : "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // `tag` theo kênh: tin mới trong cùng kênh thay thế thông báo cũ, thay vì
      // xếp 10 dòng cho 10 tin liên tiếp.
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: {
        url: typeof data.url === "string" ? data.url : "/",
        channelId: typeof data.channelId === "string" ? data.channelId : null,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        // Đã có tab Umaru → đưa tab đó tới đúng kênh rồi focus, thay vì mở tab mới.
        if ("focus" in client) {
          if ("navigate" in client) {
            try {
              await client.navigate(target);
            } catch {
              // Điều hướng bị chặn (tab đang ở origin khác) — cứ focus là được.
            }
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

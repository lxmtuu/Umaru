import { translate } from "./i18n.js";

/**
 * Thông báo khi có tin mới: tiêu đề tab + thông báo hệ điều hành.
 *
 * Toàn bộ **quyết định** nằm ở đây dưới dạng hàm thuần để test được (jsdom không
 * có Notification API thật, và test hành vi "có báo hay không" quan trọng hơn test
 * việc gọi API của trình duyệt).
 */

export interface NotificationSettings {
  /** Bật thông báo hệ điều hành (cần quyền của trình duyệt). */
  desktop: boolean;
  /** Hiện số chưa đọc trên tiêu đề tab — mặc định bật vì không cần quyền. */
  tabTitle: boolean;
}

export const NOTIFICATION_SETTINGS_KEY = "umaru.notifications";

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktop: false,
  tabTitle: true,
};

/**
 * Đọc cài đặt từ chuỗi trong localStorage. Rác/hỏng → về mặc định thay vì ném
 * lỗi: một key hỏng không được làm trắng cả app.
 */
export function parseNotificationSettings(raw: string | null): NotificationSettings {
  if (raw === null) return DEFAULT_NOTIFICATION_SETTINGS;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return DEFAULT_NOTIFICATION_SETTINGS;
    const record = value as Record<string, unknown>;
    return {
      desktop: typeof record["desktop"] === "boolean" ? record["desktop"] : false,
      tabTitle: typeof record["tabTitle"] === "boolean" ? record["tabTitle"] : true,
    };
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

/**
 * Tiêu đề tab. `(3) Umaru` — chỉ đếm **unread**; mention đã là tập con của unread
 * nên cộng thêm sẽ thành số ảo. Chưa đọc gì thì trả đúng tên app (không để
 * "(0)").
 */
export function formatTabTitle(
  base: string,
  counts: { unread: number; mentions: number },
  showCount = true,
): string {
  if (!showCount || counts.unread <= 0) return base;
  // Mention đáng chú ý hơn tin thường → đánh dấu để liếc tab là biết.
  return counts.mentions > 0 ? `(${counts.unread}@) ${base}` : `(${counts.unread}) ${base}`;
}

export interface NotifyInput {
  /** Người gửi tin. */
  authorId: string;
  /** Chính mình — tin của mình không bao giờ báo. */
  meId: string | null;
  /** Kênh có tin mới và kênh đang mở. */
  channelId: string;
  activeChannelId: string | null;
  /** Cửa sổ trình duyệt đang được focus hay không (`document.hasFocus()`). */
  windowFocused: boolean;
  desktopEnabled: boolean;
  /** Tin này có @mình (hoặc là DM) — bỏ qua cooldown. */
  important: boolean;
  /** Lần báo gần nhất của **kênh này** (epoch ms) — `null` = chưa báo lần nào. */
  lastNotifiedAt: number | null;
  now: number;
  cooldownMs?: number;
}

/** Hai tin liên tiếp trong cùng một kênh không được thành hai popup. */
export const NOTIFY_COOLDOWN_MS = 15_000;

export type NotifyVerdict =
  | { notify: true }
  | { notify: false; reason: "self" | "disabled" | "reading" | "cooldown" };

/**
 * Có báo hay không, và **vì sao không** (lý do được trả về để test đọc được ý
 * định, không chỉ đúng/sai).
 *
 * `reading` = đang mở đúng kênh đó **và** cửa sổ đang focus. Đang mở kênh mà ở
 * tab khác thì vẫn báo — người dùng không nhìn thấy tin mới.
 */
export function decideNotify(input: NotifyInput): NotifyVerdict {
  if (input.meId !== null && input.authorId === input.meId) return { notify: false, reason: "self" };
  if (!input.desktopEnabled) return { notify: false, reason: "disabled" };
  if (input.windowFocused && input.activeChannelId === input.channelId) {
    return { notify: false, reason: "reading" };
  }
  if (!input.important && input.lastNotifiedAt !== null) {
    if (input.now - input.lastNotifiedAt < (input.cooldownMs ?? NOTIFY_COOLDOWN_MS)) {
      return { notify: false, reason: "cooldown" };
    }
  }
  return { notify: true };
}

/** Nội dung popup: cắt ngắn để không tràn màn hình, giữ nguyên xuống dòng đầu. */
export function notificationText(input: {
  authorName: string;
  channelLabel: string;
  content: string;
  important: boolean;
}): { title: string; body: string } {
  const body = [...input.content.replace(/\s+/g, " ").trim()].slice(0, 140).join("");
  return {
    title: input.important
      ? translate("notifyMentionTitle", { name: input.authorName })
      : translate("notifyTitle", { name: input.authorName, channel: input.channelLabel }),
    body: body.length > 0 ? body : translate("notifyEmptyBody"),
  };
}

/**
 * Gọi API trình duyệt. Tách khỏi phần quyết định để test không cần `Notification`
 * thật; mọi lỗi (quyền bị thu hồi, trình duyệt chặn) đều nuốt — thông báo hỏng
 * không được làm hỏng luồng nhận tin.
 */
export function showDesktopNotification(payload: { title: string; body: string }): void {
  if (typeof window === "undefined") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(payload.title, { body: payload.body, tag: "umaru-message" });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Trình duyệt cũ / chặn popup: bỏ qua, badge trên tab vẫn còn.
  }
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Xin quyền — chỉ được gọi từ một thao tác của người dùng (nút bấm). */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

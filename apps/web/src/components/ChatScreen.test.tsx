// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Snowflake } from "@umaru/protocol";

/**
 * Render **toàn bộ** `ChatScreen` với state thật của store (không mock component
 * con). Đây là bài kiểm tra gần nhất với "mở app lên thì thấy gì" mà không cần
 * trình duyệt: bắt được crash khi một vùng mới (danh sách thành viên, timeline,
 * dải mất kết nối) được ghép vào cây component thật.
 *
 * Mạng được chặn bằng mock `session.js` — bài test này chỉ nói về **giao diện**.
 */

const reactionCalls = vi.hoisted(() => ({ added: [] as string[], removed: [] as string[] }));

vi.mock("../lib/session.js", () => ({
  api: { getGatewayUrl: async () => ({ url: "ws://localhost/api/v1/gateway/ws", version: 1 }) },
  authedApi: {
    listMessages: async () => [],
    ackRead: async () => undefined,
    // Ô soạn gọi `notifyTyping` mỗi lần gõ; thiếu hàm này thì mock `authedApi`
    // ném lỗi *sau* khi test đã xanh → vitest đánh dấu cả lượt chạy là hỏng.
    sendTyping: async () => undefined,
    listMessageRequests: async () => [],
    listPins: async () => [],
    searchMessages: async () => ({ hits: [], hasMore: false }),
    addReaction: async (messageId: string, emoji: string) => {
      reactionCalls.added.push(`${messageId}:${emoji}`);
      return { reactions: [] };
    },
    removeReaction: async (messageId: string, emoji: string) => {
      reactionCalls.removed.push(`${messageId}:${emoji}`);
      return { reactions: [] };
    },
  },
  clearTokens: () => undefined,
  getAccessToken: () => "token",
  getRefreshToken: () => null,
  refreshSession: async () => false,
  storeTokens: () => undefined,
}));

// Voice/gateway/notification để trống: bài test không chạm tới.
vi.mock("../lib/push.js", () => ({
  PushService: { load: async () => null },
  clearPushState: () => undefined,
}));

const gatewayMock = vi.hoisted(() => {
  class Client {
    static last: Client | null = null;
    constructor(public options: { url: string; token: string }) {
      Client.last = this;
    }
    on() {}
    onStateChange() {}
    connect() {}
    close() {}
  }
  return { Client };
});

vi.mock("@umaru/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@umaru/sdk")>();
  return { ...actual, GatewayClient: gatewayMock.Client };
});

const { ChatScreen } = await import("./ChatScreen.js");
const { useChat } = await import("../lib/chatStore.js");
const { useLocale } = await import("../lib/i18n.js");

const sid = (value: string): Snowflake => value as Snowflake;

const ME = {
  id: sid("1000"),
  username: "demo_user",
  displayName: "Demo",
  avatarUrl: null,
  emailVerified: true,
};
const GUILD = {
  id: sid("2000"),
  name: "Umaru Demo",
  iconUrl: null,
  ownerId: sid("1000"),
  createdAt: "2026-10-01T00:00:00.000Z",
};
const CHANNEL = {
  id: sid("3000"),
  guildId: sid("2000"),
  type: "guild_text" as const,
  name: "chung",
  topic: "Kênh thử nghiệm của đội QA",
  categoryId: null,
  position: 0,
};
const ROLES = [
  {
    id: sid("4000"),
    guildId: sid("2000"),
    name: "@everyone",
    color: 0,
    position: 0,
    permissions: "1795",
    isEveryone: true,
  },
  {
    id: sid("4001"),
    guildId: sid("2000"),
    name: "Quản trị",
    color: 0x5865f2,
    position: 5,
    permissions: "2048",
    isEveryone: false,
  },
];

function message(id: string, authorId: string, content: string, createdAt: string): Message {
  return {
    id: sid(id),
    channelId: CHANNEL.id,
    authorId: sid(authorId),
    content,
    replyToId: null,
    pinned: false,
    createdAt,
    editedAt: null,
    attachments: [],
  } as unknown as Message;
}

const MEMBERS = [
  {
    userId: sid("1000"),
    username: "demo_user",
    displayName: "Demo",
    avatarUrl: null,
    roleIds: [sid("4001")],
  },
  {
    userId: sid("1001"),
    username: "minh",
    displayName: "Minh",
    avatarUrl: null,
    roleIds: [],
  },
];

function seedChat() {
  useChat.setState({
    screen: "chat",
    me: ME,
    guilds: [GUILD],
    channels: { "2000": [CHANNEL] },
    members: { "2000": MEMBERS },
    roles: { "2000": ROLES },
    dms: [],
    activeGuildId: GUILD.id,
    activeChannelId: CHANNEL.id,
    messages: {
      [CHANNEL.id]: [
        message("5001", "1001", "Tin đầu tiên trong ngày", "2026-10-26T02:00:00.000Z"),
        message("5002", "1001", "Tin thứ hai cùng người, trong 5 phút", "2026-10-26T02:01:00.000Z"),
        message("5003", "1000", "Tin của mình", "2026-10-26T03:00:00.000Z"),
      ],
    },
    unread: {},
    mentions: {},
    // VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY | CONNECT | SPEAK — không có
    // quyền xem kênh thì sidebar ẩn kênh, và test sẽ hiểu sai là "mất kênh".
    permissions: { [CHANNEL.id as string]: 1795n },
    // Demo đang online (giữ role Quản trị), Minh ngoại tuyến.
    presence: { "1000": "online" },
    selfStatus: "online",
    voiceStates: [],
    voiceScreens: [],
    voiceAudio: "idle",
    voiceSpeakers: [],
    screenSharing: false,
    gatewayStatus: "ready",
    searchOpen: false,
    pinsOpen: false,
    friendsOpen: false,
    blocksOpen: false,
    mentionsOpen: false,
    settingsOpen: false,
    groupPanelOpen: false,
    channelSettingsChannelId: null,
    messageRequests: [],
    friends: [],
    blocks: [],
    admin: false,
    error: null,
    notice: null,
    banner: null,
  } as never);
}

beforeEach(() => {
  useLocale.setState({ locale: "vi" });
  reactionCalls.added.length = 0;
  reactionCalls.removed.length = 0;
  // jsdom không có scrollIntoView; ChatScreen tự cuộn xuống tin mới nhất.
  Element.prototype.scrollIntoView = () => undefined;
  seedChat();
});

afterEach(cleanup);

describe("ChatScreen — dựng giao diện thật", () => {
  it("hiện server, kênh và nội dung tin nhắn", () => {
    render(<ChatScreen />);
    expect(screen.getAllByTitle("Umaru Demo").length).toBeGreaterThan(0);
    // Tên kênh xuất hiện ở sidebar và ở tiêu đề khung chat (có tiền tố "#").
    expect(screen.getAllByText(/chung/).length).toBeGreaterThan(1);
    expect(screen.getByText("Tin đầu tiên trong ngày")).toBeTruthy();
  });

  it("có danh sách thành viên với role và đúng số người", () => {
    render(<ChatScreen />);
    expect(screen.getByRole("heading", { name: "Thành viên — 2" })).toBeTruthy();
    // Người online nhóm theo role; người offline gom vào nhóm cuối (như Discord).
    expect(screen.getByText("Quản trị — 1")).toBeTruthy();
    expect(screen.getByText("Ngoại tuyến — 1")).toBeTruthy();
  });

  it("gộp tin liên tiếp cùng người: tên chỉ hiện một lần cho cụm", () => {
    render(<ChatScreen />);
    // "Minh" xuất hiện ở danh sách thành viên + một lần trong khung chat.
    expect(screen.getAllByText("Minh")).toHaveLength(2);
  });

  it("hiện topic của kênh cạnh tên kênh", () => {
    render(<ChatScreen />);
    expect(screen.getByText("Kênh thử nghiệm của đội QA")).toBeTruthy();
  });

  it("khi mất kết nối thì có dải báo + nút Thử lại (không im lặng)", () => {
    useChat.setState({ gatewayStatus: "offline" } as never);
    render(<ChatScreen />);
    const banner = screen.getByRole("status");
    expect(within(banner).getByText(/Mất kết nối tới server/)).toBeTruthy();
    expect(within(banner).getByText("Thử lại")).toBeTruthy();
  });

  it("khi đang kết nối lại thì báo đang kết nối", () => {
    useChat.setState({ gatewayStatus: "reconnecting" } as never);
    render(<ChatScreen />);
    expect(within(screen.getByRole("status")).getByText("Đang kết nối…")).toBeTruthy();
  });

  it("kênh trống hiện khung chào thay vì dòng xám", () => {
    useChat.setState({ messages: { [CHANNEL.id]: [] } } as never);
    render(<ChatScreen />);
    expect(screen.getByText(/Chào mừng tới/)).toBeTruthy();
    expect(screen.getByText(/Chưa có tin nhắn/)).toBeTruthy();
  });

  it("view Home: không có danh sách thành viên, hiện danh sách DM", () => {
    useChat.setState({ activeGuildId: null, activeChannelId: null } as never);
    render(<ChatScreen />);
    expect(screen.queryByRole("heading", { name: /Thành viên —/ })).toBeNull();
    expect(screen.getByText(/Chưa có tin nhắn riêng/)).toBeTruthy();
  });

  it("DM 1-1 có chấm trạng thái của người bên kia", () => {
    useChat.setState({
      activeGuildId: null,
      activeChannelId: "6000",
      presence: { "1001": "idle" },
      dms: [
        {
          channel: {
            id: "6000",
            guildId: null,
            type: "dm",
            name: null,
            topic: null,
            categoryId: null,
            position: 0,
          },
          recipient: {
            userId: "1001",
            username: "minh",
            displayName: "Minh",
            avatarUrl: null,
            roleIds: [],
          },
          recipients: [
            {
              userId: "1001",
              username: "minh",
              displayName: "Minh",
              avatarUrl: null,
              roleIds: [],
            },
          ],
          ownerId: null,
          name: null,
          requestPending: false,
        },
      ],
    } as never);
    const { container } = render(<ChatScreen />);
    const dots = container.querySelectorAll("span.absolute.-bottom-0\\.5");
    // Chấm trong sidebar DM: màu vàng vì Minh đang "Đang chờ".
    expect([...dots].some((node) => node.className.includes("bg-amber-400"))).toBe(true);
  });
});

describe("ChatScreen — menu chuột phải trên tin nhắn", () => {
  function openMenuOn(text: string) {
    const article = screen.getByText(text).closest("article");
    expect(article).not.toBeNull();
    fireEvent.contextMenu(article as HTMLElement, { clientX: 120, clientY: 80 });
    return screen.getByRole("menu", { name: "Hành động với tin nhắn" });
  }

  it("chuột phải vào tin của người khác: có Trả lời/Sao chép/Báo cáo, không có Xoá", () => {
    render(<ChatScreen />);
    const menu = openMenuOn("Tin đầu tiên trong ngày");
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.includes("Trả lời"))).toBe(true);
    expect(labels.some((label) => label.includes("Sao chép nội dung"))).toBe(true);
    expect(labels.some((label) => label.includes("Sao chép liên kết"))).toBe(true);
    expect(labels.some((label) => label.includes("Báo cáo tin nhắn"))).toBe(true);
    // Không có quyền MANAGE_MESSAGES ở kênh này và không phải tin của mình.
    expect(labels.some((label) => label.includes("Xoá"))).toBe(false);
  });

  it("chuột phải vào tin của mình: có Ghim/Sửa/Xoá, không có Báo cáo", () => {
    render(<ChatScreen />);
    const menu = openMenuOn("Tin của mình");
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.includes("Ghim tin nhắn"))).toBe(true);
    expect(labels.some((label) => label.includes("Sửa"))).toBe(true);
    expect(labels.some((label) => label.includes("Xoá"))).toBe(true);
    expect(labels.some((label) => label.includes("Báo cáo"))).toBe(false);
  });

  it("nút ⋯ mở đúng menu đó (đường dùng được bằng bàn phím, không cần chuột phải)", () => {
    render(<ChatScreen />);
    const buttons = screen.getAllByRole("button", { name: "Hành động với tin nhắn" });
    fireEvent.click(buttons[0]!);
    expect(screen.getByRole("menu", { name: "Hành động với tin nhắn" })).toBeTruthy();
  });

  it("Sao chép liên kết: clipboard nhận URL mở đúng kênh + đúng tin, và báo đã chép", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void written.push(text) },
      configurable: true,
    });
    render(<ChatScreen />);
    const menu = openMenuOn("Tin của mình");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Sao chép liên kết/ }));

    // Menu đóng ngay sau khi chọn.
    expect(screen.queryByRole("menu")).toBeNull();
    await screen.findByText("Đã sao chép");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("?channel=3000&message=5003");
  });

  it("mục Xoá chỉ mở bước xác nhận, không xoá ngay", () => {
    render(<ChatScreen />);
    const menu = openMenuOn("Tin của mình");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Xoá/ }));
    expect(screen.getByText("Xoá?")).toBeTruthy();
    // Tin vẫn còn trên màn hình.
    expect(screen.getByText("Tin của mình")).toBeTruthy();
  });

  it("Escape đóng menu", () => {
    render(<ChatScreen />);
    openMenuOn("Tin của mình");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("mục Trả lời bật thanh \"đang trả lời\" ở ô soạn tin", () => {
    render(<ChatScreen />);
    const menu = openMenuOn("Tin của mình");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Trả lời/ }));
    expect(screen.getByText(/Đang trả lời/)).toBeTruthy();
  });
});

describe("ChatScreen — gợi ý @mention và bảng emoji", () => {
  /** Gõ vào ô soạn rồi đặt con trỏ ở cuối — jsdom không tự dời con trỏ. */
  function typeDraft(value: string) {
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value } });
    box.setSelectionRange(value.length, value.length);
    fireEvent.keyUp(box, { key: value.slice(-1) });
    return box;
  }

  it("gõ `@mi` → hiện gợi ý đúng người, không gợi ý chính mình", () => {
    render(<ChatScreen />);
    typeDraft("@mi");
    const list = screen.getByRole("listbox", { name: "Gợi ý thành viên để nhắc" });
    expect(within(list).getByRole("option", { name: /Minh/ })).toBeTruthy();
    // "Demo" là chính mình → không nằm trong danh sách.
    expect(within(list).queryByRole("option", { name: /Demo/ })).toBeNull();
  });

  it("Enter chọn gợi ý: chèn `@username ` vào ô soạn, KHÔNG gửi tin", () => {
    render(<ChatScreen />);
    const box = typeDraft("@mi");
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe("@minh ");
    // Gợi ý đóng sau khi chọn.
    expect(screen.queryByRole("listbox")).toBeNull();
    // Tin chưa được gửi: vẫn còn nội dung trong ô soạn.
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("Escape đóng gợi ý, gõ tiếp thì hiện lại", () => {
    render(<ChatScreen />);
    const box = typeDraft("@mi");
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(box, { target: { value: "@min" } });
    box.setSelectionRange(4, 4);
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });

  it("gõ email không bật gợi ý (chỉ `@` sau khoảng trắng mới là mention)", () => {
    render(<ChatScreen />);
    typeDraft("minh@example.com");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("bấm một gợi ý cũng chèn được (dùng chuột)", () => {
    render(<ChatScreen />);
    const box = typeDraft("@mi");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Minh/ }));
    expect((box as HTMLTextAreaElement).value).toBe("@minh ");
  });

  it("mở bảng emoji, chọn một cái → chèn vào ô soạn và đóng bảng", () => {
    render(<ChatScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Chèn emoji" }));
    const picker = screen.getByRole("dialog", { name: "Bảng emoji" });
    expect(picker).toBeTruthy();

    fireEvent.click(within(picker).getByRole("button", { name: "🎉" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("🎉");
    expect(screen.queryByRole("dialog", { name: "Bảng emoji" })).toBeNull();
  });

  it("bảng emoji nhóm đúng nhãn tiếng Việt", () => {
    render(<ChatScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Chèn emoji" }));
    const picker = screen.getByRole("dialog", { name: "Bảng emoji" });
    expect(within(picker).getByText("Cảm xúc")).toBeTruthy();
    expect(within(picker).getByText("Mặt")).toBeTruthy();
    expect(within(picker).getByText("Công việc")).toBeTruthy();
  });
});

describe("ChatScreen — reaction trên tin nhắn", () => {
  function seedReactions() {
    useChat.setState({
      messages: {
        [CHANNEL.id]: [
          {
            ...message("5001", "1001", "Tin có reaction", "2026-10-26T02:00:00.000Z"),
            reactions: [
              { emoji: "👍", count: 2, me: true },
              { emoji: "🔥", count: 1, me: false },
            ],
          },
        ],
      },
    } as never);
  }

  it("hiện chip cho từng emoji kèm số người, `me` được đánh dấu aria-pressed", () => {
    seedReactions();
    render(<ChatScreen />);
    const mine = screen.getByRole("button", { name: "👍 — 2 người thả" });
    const other = screen.getByRole("button", { name: "🔥 — 1 người thả" });
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    expect(other.getAttribute("aria-pressed")).toBe("false");
    expect(within(mine).getByText("2")).toBeTruthy();
  });

  it("bấm chip của mình → bỏ reaction; bấm chip người khác → thả thêm", () => {
    seedReactions();
    render(<ChatScreen />);
    fireEvent.click(screen.getByRole("button", { name: "👍 — 2 người thả" }));
    expect(reactionCalls.removed).toEqual([`5001:👍`]);
    fireEvent.click(screen.getByRole("button", { name: "🔥 — 1 người thả" }));
    expect(reactionCalls.added).toEqual([`5001:🔥`]);
  });

  it("nút 😊+ mở bảng emoji và thả reaction lên đúng tin", () => {
    render(<ChatScreen />);
    const add = screen.getAllByRole("button", { name: "Thêm cảm xúc" });
    fireEvent.click(add[0]!);
    const picker = screen.getByRole("dialog", { name: "Bảng emoji" });
    fireEvent.click(within(picker).getByRole("button", { name: "🎉" }));
    expect(reactionCalls.added).toEqual([`5001:🎉`]);
    expect(screen.queryByRole("dialog", { name: "Bảng emoji" })).toBeNull();
  });

  it("tin chưa có reactions (payload cũ) không làm sập khung chat", () => {
    // seedChat() dựng Message **không** có trường reactions — đúng dạng dữ liệu
    // cũ còn trong bộ nhớ. Trước đây chỗ này ném `Cannot read properties of
    // undefined (reading 'length')` và cả khung chat trắng.
    render(<ChatScreen />);
    expect(screen.getByText("Tin đầu tiên trong ngày")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /người thả/ })).toBeNull();
  });
});

describe("ChatScreen — menu chuột phải ở sidebar (kênh & thành viên)", () => {
  function sidebar(): HTMLElement {
    // `aside` của danh sách thành viên có aria-label = nhãn đếm.
    return screen.getByLabelText("Thành viên — 2");
  }

  it("chuột phải vào kênh: có Đánh dấu đã đọc / Sao chép liên kết / Cài đặt kênh", () => {
    render(<ChatScreen />);
    fireEvent.contextMenu(screen.getAllByRole("button", { name: /chung/ })[0]!);
    const menu = screen.getByRole("menu", { name: "Hành động với kênh" });
    expect(within(menu).getByRole("menuitem", { name: /Đánh dấu đã đọc/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Sao chép liên kết kênh/ })).toBeTruthy();
    // Demo là chủ server ⇒ có quyền mở cài đặt kênh.
    expect(within(menu).getByRole("menuitem", { name: /Cài đặt kênh/ })).toBeTruthy();
  });

  it("Đánh dấu đã đọc xoá badge chưa đọc của kênh", () => {
    useChat.setState({ unread: { [CHANNEL.id]: 3 } } as never);
    render(<ChatScreen />);
    fireEvent.contextMenu(screen.getAllByRole("button", { name: /chung/ })[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Đánh dấu đã đọc/ }));
    expect(useChat.getState().unread[CHANNEL.id as string]).toBeUndefined();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("người không có quyền quản lý kênh thì menu không có Cài đặt kênh", () => {
    // Bỏ quyền MANAGE_CHANNELS/MANAGE_ROLES và không còn là chủ server.
    useChat.setState({
      guilds: [{ ...GUILD, ownerId: "1001" }],
      permissions: { [CHANNEL.id as string]: 1795n },
    } as never);
    render(<ChatScreen />);
    fireEvent.contextMenu(screen.getAllByRole("button", { name: /chung/ })[0]!);
    const menu = screen.getByRole("menu", { name: "Hành động với kênh" });
    expect(within(menu).queryByRole("menuitem", { name: /Cài đặt kênh/ })).toBeNull();
  });

  it("chuột phải vào thành viên khác: Nhắn tin / Sao chép tên người dùng / Chặn", () => {
    render(<ChatScreen />);
    fireEvent.contextMenu(within(sidebar()).getByText("Minh"));
    const menu = screen.getByRole("menu", { name: "Hành động với thành viên" });
    expect(within(menu).getByRole("menuitem", { name: /Nhắn tin/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Sao chép tên người dùng/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Chặn/ })).toBeTruthy();
  });

  it("người đã bị chặn thì mục đảo thành Bỏ chặn (không phải ngõ cụt)", () => {
    useChat.setState({ blocks: [MEMBERS[1]] } as never);
    render(<ChatScreen />);
    fireEvent.contextMenu(within(sidebar()).getByText("Minh"));
    const menu = screen.getByRole("menu", { name: "Hành động với thành viên" });
    expect(within(menu).getByRole("menuitem", { name: /Bỏ chặn/ })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /^Chặn$/ })).toBeNull();
  });

  it("chuột phải vào chính mình: không mở menu", () => {
    render(<ChatScreen />);
    fireEvent.contextMenu(within(sidebar()).getByText("Demo"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape đóng menu sidebar", () => {
    render(<ChatScreen />);
    fireEvent.contextMenu(within(sidebar()).getByText("Minh"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

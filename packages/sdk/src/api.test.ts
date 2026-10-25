import { describe, expect, it } from "vitest";
import { ApiError, UmaruApi } from "./api.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(response: { status: number; body?: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(response.status === 204 ? null : JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("UmaruApi", () => {
  it("login gửi POST JSON tới /api/v1/auth/login và trả AuthResult", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: { user: { id: "1" }, accessToken: "a", refreshToken: "r", expiresIn: 900 },
    });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const result = await api.login("a@b.c", "mat-khau");

    expect(calls[0]?.url).toBe("/api/v1/auth/login");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "a@b.c",
      password: "mat-khau",
    });
    expect(result.accessToken).toBe("a");
  });

  it("gắn Bearer token vào mọi request khi có token", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: [] });
    const api = new UmaruApi({ baseUrl: "http://api.test/", getToken: () => "token-123", fetchImpl });
    await api.listGuilds();
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(calls[0]?.url).toBe("http://api.test/api/v1/users/@me/guilds");
    expect(headers.authorization).toBe("Bearer token-123");
  });

  it("listMessages dựng query string đúng và bỏ qua tham số rỗng", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: [] });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    await api.listMessages("42", { limit: 20 });
    await api.listMessages("42", { before: "99", limit: 5 });
    expect(calls[0]?.url).toBe("/api/v1/channels/42/messages?limit=20");
    expect(calls[1]?.url).toBe("/api/v1/channels/42/messages?before=99&limit=5");
  });

  it("listDms/createDm gọi đúng endpoint và method", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201, body: { channel: { id: "7" }, recipient: { userId: "2" } } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });

    await api.listDms();
    expect(calls[0]?.url).toBe("/api/v1/users/@me/channels");

    await api.createDm("2");
    expect(calls[1]?.url).toBe("/api/v1/users/@me/channels");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ recipientId: "2" });
  });

  it("request không body (typing) không gắn content-type — Fastify sẽ 400 nếu có", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 204 });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    await api.sendTyping("42");

    expect(calls[0]?.url).toBe("/api/v1/channels/42/typing");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBeUndefined();
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("ackRead/listReadStates gọi đúng endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 204 });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });

    await api.ackRead("42");
    await api.ackRead("42", "99");

    expect(calls[0]?.url).toBe("/api/v1/channels/42/read");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ messageId: "99" });
  });

  it("listReadStates trả ReadState[]", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: [{ channelId: "42", lastReadMessageId: "99", unread: 3 }],
    });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });

    const states = await api.listReadStates();

    expect(calls[0]?.url).toBe("/api/v1/users/@me/read-states");
    expect(states).toEqual([{ channelId: "42", lastReadMessageId: "99", unread: 3 }]);
  });

  it("listMentions gọi /users/@me/mentions và dựng query before/limit", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: [
        {
          message: { id: "9", channelId: "42", content: "@bob xem cái này" },
          channel: { id: "42", guildId: "1", type: "guild_text", name: "chung" },
          guildName: "Umaru",
          author: { userId: "2", username: "alice", displayName: "Alice", avatarUrl: null },
          recipient: null,
        },
      ],
    });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    await api.listMentions();
    await api.listMentions({ before: "99", limit: 20 });

    expect(calls[0]?.url).toBe("/api/v1/users/@me/mentions");
    expect(calls[0]?.init?.method).toBeUndefined();
    expect(calls[1]?.url).toBe("/api/v1/users/@me/mentions?before=99&limit=20");
    const mentions = await api.listMentions();
    expect(mentions[0]?.message.id).toBe("9");
    expect(mentions[0]?.channel.name).toBe("chung");
  });

  it("role API gọi đúng endpoint + method (GET/POST/PATCH/PUT/DELETE)", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 204 });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });

    await api.listRoles("1");
    await api.createRole("1", { name: "Mod", permissions: "6" });
    await api.editRole("1", "2", { name: "Mod 2" });
    await api.addMemberRole("1", "3", "2");
    await api.removeMemberRole("1", "3", "2");
    await api.deleteRole("1", "2");

    expect(calls[0]?.url).toBe("/api/v1/guilds/1/roles");
    expect(calls[0]?.init?.method).toBeUndefined();

    expect(calls[1]?.url).toBe("/api/v1/guilds/1/roles");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ name: "Mod", permissions: "6" });

    expect(calls[2]?.url).toBe("/api/v1/guilds/1/roles/2");
    expect(calls[2]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ name: "Mod 2" });

    expect(calls[3]?.url).toBe("/api/v1/guilds/1/members/3/roles/2");
    expect(calls[3]?.init?.method).toBe("PUT");
    expect(calls[3]?.init?.body).toBeUndefined();

    expect(calls[4]?.url).toBe("/api/v1/guilds/1/members/3/roles/2");
    expect(calls[4]?.init?.method).toBe("DELETE");

    expect(calls[5]?.url).toBe("/api/v1/guilds/1/roles/2");
    expect(calls[5]?.init?.method).toBe("DELETE");
  });

  it("204 trả undefined (delete/logout)", async () => {
    const { fetchImpl } = fakeFetch({ status: 204 });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    await expect(api.deleteMessage("1")).resolves.toBeUndefined();
  });

  it("lỗi HTTP ném ApiError kèm status và body", async () => {
    const { fetchImpl } = fakeFetch({
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "Không có quyền" } },
    });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const error = await api.sendMessage("1", "hi").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).body).toEqual({ error: { code: "FORBIDDEN", message: "Không có quyền" } });
  });
  it("sendMessage không có file vẫn là JSON (tương thích cũ)", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201, body: { id: "1" } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    await api.sendMessage("42", "chào", "99");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ content: "chào", replyToId: "99" });
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("sendMessage có file dùng FormData và KHÔNG tự đặt content-type", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201, body: { id: "1", attachments: [] } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const file = new File([new Uint8Array([1, 2, 3])], "anh.png", { type: "image/png" });
    await api.sendMessage("42", "kèm ảnh", { files: [file] });

    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("content")).toBe("kèm ảnh");
    const uploaded = form.get("files") as File;
    expect(uploaded.name).toBe("anh.png");
    // Trình duyệt tự sinh `content-type` kèm boundary; SDK không được ghi đè.
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("fetchAttachment tải blob kèm Bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;
    const api = new UmaruApi({ baseUrl: "http://api.test", getToken: () => "tok", fetchImpl });
    const blob = await api.fetchAttachment("555");

    expect(calls[0]?.url).toBe("http://api.test/api/v1/attachments/555");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("image/png");
  });

  it("fetchAttachment lỗi thì ném ApiError", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const error = await api.fetchAttachment("1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it("updateAvatar gửi PUT multipart, KHÔNG tự đặt content-type", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: { id: "1", avatarUrl: "/api/v1/users/1/avatar/9" },
    });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const file = new File([new Uint8Array([1, 2, 3])], "toi.png", { type: "image/png" });
    const user = await api.updateAvatar(file);

    expect(calls[0]?.url).toBe("/api/v1/users/@me/avatar");
    expect(calls[0]?.init?.method).toBe("PUT");
    const form = calls[0]?.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get("file") as File).name).toBe("toi.png");
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(user.avatarUrl).toBe("/api/v1/users/1/avatar/9");
  });

  it("removeAvatar gọi DELETE tới cùng endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { id: "1", avatarUrl: null } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const user = await api.removeAvatar();
    expect(calls[0]?.url).toBe("/api/v1/users/@me/avatar");
    expect(calls[0]?.init?.method).toBe("DELETE");
    expect(user.avatarUrl).toBeNull();
  });

  it("fetchAvatar ghép baseUrl với avatarUrl và gửi Bearer", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([4, 5]), { status: 200 });
    }) as typeof fetch;
    const api = new UmaruApi({ baseUrl: "http://api.test", getToken: () => "tok", fetchImpl });
    const blob = await api.fetchAvatar("/api/v1/users/7/avatar/77");

    expect(calls[0]?.url).toBe("http://api.test/api/v1/users/7/avatar/77");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(blob.size).toBe(2);
  });

  it("createGroupDm gửi recipientIds + name (nếu có)", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201, body: { channel: { id: "9" } } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    await api.createGroupDm(["2", "3"]);
    expect(calls[0]?.url).toBe("/api/v1/users/@me/channels");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ recipientIds: ["2", "3"] });

    await api.createGroupDm(["2", "3"], "Nhóm");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      recipientIds: ["2", "3"],
      name: "Nhóm",
    });
  });

  it("addGroupRecipient / removeGroupRecipient / renameGroupDm đúng đường dẫn", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { channel: { id: "9" } } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });

    await api.addGroupRecipient("9", "5");
    expect(calls[0]?.url).toBe("/api/v1/channels/9/recipients");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ userId: "5" });

    await api.removeGroupRecipient("9", "@me");
    // `@` được encode cho an toàn (server vẫn hiểu `@me` sau khi decode).
    expect(calls[1]?.url).toBe("/api/v1/channels/9/recipients/%40me");
    expect(calls[1]?.init?.method).toBe("DELETE");

    await api.renameGroupDm("9", null);
    expect(calls[2]?.url).toBe("/api/v1/channels/9");
    expect(calls[2]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ name: null });
  });

  it("pinMessage/unpinMessage gọi đúng method + đường dẫn", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { id: "5", pinned: true } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });

    const pinned = await api.pinMessage("5");
    expect(calls[0]?.url).toBe("/api/v1/messages/5/pin");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(pinned.pinned).toBe(true);

    await api.unpinMessage("5");
    expect(calls[1]?.url).toBe("/api/v1/messages/5/pin");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("listPinnedMessages gọi kênh pins kèm limit", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: [] });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    await api.listPinnedMessages("42", 10);
    expect(calls[0]?.url).toBe("/api/v1/channels/42/pins?limit=10");
  });

  it("searchChannelMessages mã hoá q và cursor trong query string", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: [] });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });
    await api.searchChannelMessages("42", "xin chào & tệp", { before: "100", limit: 10 });

    const url = new URL(calls[0]?.url ?? "", "http://local");
    expect(url.pathname).toBe("/api/v1/channels/42/messages/search");
    expect(url.searchParams.get("q")).toBe("xin chào & tệp");
    expect(url.searchParams.get("before")).toBe("100");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("searchGuildMessages không gửi before/limit khi không truyền", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: [] });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    await api.searchGuildMessages("7", "abc");

    expect(calls[0]?.url).toBe("/api/v1/guilds/7/messages/search?q=abc");
  });

  it("verifyEmail gửi POST token tới /auth/verify-email", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { user: { id: "1" } } });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const result = await api.verifyEmail("tok-abc");

    expect(calls[0]?.url).toBe("/api/v1/auth/verify-email");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: "tok-abc" });
    expect(result.user).toEqual({ id: "1" });
  });

  it("resendVerification trả devVerificationToken khi server echo", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 202,
      body: { sent: true, devVerificationToken: "tok-dev" },
    });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });
    const result = await api.resendVerification();

    expect(calls[0]?.url).toBe("/api/v1/auth/verify-email/resend");
    expect(result).toEqual({ sent: true, devVerificationToken: "tok-dev" });
  });

  it("register trả emailVerificationSent kèm token dev", async () => {
    const { fetchImpl } = fakeFetch({
      status: 201,
      body: {
        user: { id: "1" },
        accessToken: "a",
        refreshToken: "r",
        tokenType: "Bearer",
        expiresIn: 900,
        emailVerificationSent: true,
        devVerificationToken: "tok-1",
      },
    });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const result = await api.register({
      username: "an",
      displayName: "An",
      email: "an@example.com",
      password: "mat-khau-123",
      acceptedTerms: true,
    });

    expect(result.emailVerificationSent).toBe(true);
    expect(result.devVerificationToken).toBe("tok-1");
  });

  it("blockUser/unblockUser dùng PUT và DELETE tới /users/@me/blocks/:id", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 204 });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    await api.blockUser("42");
    await api.unblockUser("42");

    expect(calls[0]?.url).toBe("/api/v1/users/@me/blocks/42");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("createReport gửi JSON kèm lý do và messageId", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201, body: { id: "1", status: "open" } });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    const result = await api.createReport({ messageId: "99", reason: "spam", details: "quảng cáo" });

    expect(calls[0]?.url).toBe("/api/v1/reports");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      messageId: "99",
      reason: "spam",
      details: "quảng cáo",
    });
    expect(result.status).toBe("open");
  });

  it("listBlocks trả danh sách summary", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: [{ userId: "1" }] });
    const api = new UmaruApi({ baseUrl: "", fetchImpl });
    const blocks = await api.listBlocks();
    expect(calls[0]?.url).toBe("/api/v1/users/@me/blocks");
    expect(blocks).toHaveLength(1);
  });

  it("listAdminReports dựng query status/before/limit và bỏ tham số không dùng", async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, body: { reports: [] } });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    await api.listAdminReports({ status: "open", limit: 50 });
    await api.listAdminReports();

    expect(calls[0]?.url).toBe("/api/v1/admin/reports?status=open&limit=50");
    expect(calls[1]?.url).toBe("/api/v1/admin/reports");
  });

  it("setReportStatus gửi PATCH JSON và trả báo cáo đã cập nhật", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: { id: "7", status: "closed" },
    });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    const result = await api.setReportStatus("7", "closed");

    expect(calls[0]?.url).toBe("/api/v1/admin/reports/7");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ status: "closed" });
    expect(result.status).toBe("closed");
  });

  it("getAdminStatus ném ApiError 403 khi không đủ quyền", async () => {
    const { fetchImpl } = fakeFetch({ status: 403, body: {} });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });
    const error = await api.getAdminStatus().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });

  it("joinVoice/leaveVoice/updateVoiceState gọi đúng endpoint và method", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: {
        guildId: "1",
        channelId: "2",
        userId: "3",
        selfMute: true,
        selfDeaf: false,
        joinedAt: "2026-10-26T00:00:00.000Z",
      },
    });
    const api = new UmaruApi({ baseUrl: "", getToken: () => "tok", fetchImpl });

    const state = await api.joinVoice("2");
    expect(calls[0]?.url).toBe("/api/v1/channels/2/voice");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(state.channelId).toBe("2");

    await api.leaveVoice("2");
    expect(calls[1]?.url).toBe("/api/v1/channels/2/voice");
    expect(calls[1]?.init?.method).toBe("DELETE");

    await api.updateVoiceState("1", { selfDeaf: true });
    expect(calls[2]?.url).toBe("/api/v1/guilds/1/voice-state");
    expect(calls[2]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ selfDeaf: true });
  });
});

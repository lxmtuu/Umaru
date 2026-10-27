import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  createGuild,
  createTestContext,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/** PNG 1×1 trong suốt — ảnh hợp lệ nhỏ nhất mà parser đọc được. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** GIF 40×30 chỉ cần header để kiểm đọc kích thước. */
function gifHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.write("GIF89a", 0, "latin1");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

const BOUNDARY = "----umaruAvatarBoundary1";

function multipart(
  file: { filename: string; mime: string; data: Buffer } | null,
  field = "file",
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  if (file !== null) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
    );
    chunks.push(file.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

interface ProfileBody {
  id: string;
  avatarUrl: string | null;
}

/** `GET /users/@me` — dùng để đối chiếu avatarUrl giữa hai endpoint. */
async function getCurrentUser(ctx: TestContext, token: string): Promise<ProfileBody> {
  const response = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/users/@me",
    headers: auth(token),
  });
  if (response.statusCode !== 200) throw new Error(`Lấy hồ sơ lỗi: ${response.body}`);
  return response.json<ProfileBody>();
}

describe("avatar người dùng", () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await registerUser(ctx, "avatar_alice");
    bob = await registerUser(ctx, "avatar_bob");
  });

  afterAll(async () => {
    await ctx.close();
  });

  const upload = (user: RegisteredUser, file: Parameters<typeof multipart>[0]) => {
    const body = multipart(file);
    return ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { ...auth(user.token), ...body.headers },
      payload: body.payload,
    });
  };

  it("mặc định chưa có avatar (avatarUrl null)", async () => {
    const me = await getCurrentUser(ctx, alice.token);
    expect(me.avatarUrl).toBeNull();
  });

  it("tải PNG lên: 200, avatarUrl chứa userId + uploadId", async () => {
    const response = await upload(alice, {
      filename: "pixel.png",
      mime: "image/png",
      data: PNG_1x1,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: string;
      avatarUrl: string;
      displayName: string;
      email?: string;
    }>();
    expect(body.id).toBe(alice.id);
    expect(body.avatarUrl).toMatch(new RegExp(`^/api/v1/users/${alice.id}/avatar/\\d+$`));
    // Không lộ email qua đường hồ sơ công khai.
    expect(body.email).toBeUndefined();

    // API hồ sơ hiện tại trả cùng URL đó (không phải bản sao lệch).
    const me = await getCurrentUser(ctx, alice.token);
    expect(me.avatarUrl).toBe(body.avatarUrl);
  });

  it("người dùng khác đã đăng nhập tải được ảnh, kèm header chống đoán MIME", async () => {
    const me = await getCurrentUser(ctx, alice.token);
    const response = await ctx.app.inject({
      method: "GET",
      url: me.avatarUrl!,
      headers: auth(bob.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(response.rawPayload.equals(PNG_1x1)).toBe(true);
  });

  it("chưa đăng nhập thì 401 (không phải public)", async () => {
    const me = await getCurrentUser(ctx, alice.token);
    const response = await ctx.app.inject({ method: "GET", url: me.avatarUrl! });
    expect(response.statusCode).toBe(401);
  });

  it("đổi avatar: URL đổi theo uploadId và file cũ bị xoá", async () => {
    const before = await getCurrentUser(ctx, alice.token);
    const oldUrl = before.avatarUrl!;

    const response = await upload(alice, {
      filename: "banner.gif",
      mime: "image/gif",
      data: gifHeader(40, 30),
    });
    expect(response.statusCode).toBe(200);
    const after = response.json<{ avatarUrl: string }>();
    expect(after.avatarUrl).not.toBe(oldUrl);

    // URL cũ không còn phục vụ ảnh mới dưới id cũ.
    const stale = await ctx.app.inject({
      method: "GET",
      url: oldUrl,
      headers: auth(alice.token),
    });
    expect(stale.statusCode).toBe(404);

    // Và file cũ đã bị xoá khỏi đĩa (không rò rỉ dung lượng).
    const files = await readdir(ctx.config.avatarsDir);
    expect(files).toHaveLength(1);
  });

  it("MIME giả (khai image/png nhưng không phải ảnh) bị 415", async () => {
    const response = await upload(alice, {
      filename: "evil.png",
      mime: "image/png",
      data: Buffer.from("<?php echo 1; ?>"),
    });
    expect(response.statusCode).toBe(415);
  });

  it("SVG bị từ chối ngay ở MIME khai báo (chứa được script)", async () => {
    const response = await upload(alice, {
      filename: "x.svg",
      mime: "image/svg+xml",
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    });
    expect(response.statusCode).toBe(415);
  });

  it("không gửi file → 400", async () => {
    const response = await upload(alice, null);
    expect(response.statusCode).toBe(400);
  });

  it("gửi JSON thay vì multipart → 415", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: auth(alice.token),
      payload: { avatarUrl: "https://example.com/x.png" },
    });
    expect(response.statusCode).toBe(415);
  });

  it("ảnh quá trần bị 413 và không để lại file", async () => {
    // Không tạo context thứ hai: `createTestContext` truncate cả DB dùng chung.
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(5 * 1024 * 1024)]);
    const body = multipart({ filename: "big.png", mime: "image/png", data: big });
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(413);
    // File dở bị xoá ngay, không để lại rác.
    const files = await readdir(ctx.config.avatarsDir).catch(() => [] as string[]);
    expect(files).toHaveLength(1); // chỉ còn avatar hợp lệ đang dùng, file dở đã xoá
  });

  it("gỡ avatar: 200, avatarUrl null và file bị xoá", async () => {
    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/avatar",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ avatarUrl: null }>().avatarUrl).toBeNull();

    const files = await readdir(ctx.config.avatarsDir);
    expect(files).toHaveLength(0);
  });

  it("gỡ khi chưa có avatar vẫn 200 (idempotent)", async () => {
    const response = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/@me/avatar",
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ avatarUrl: null }>().avatarUrl).toBeNull();
  });

  it("avatar hiện trong danh sách DM của người khác", async () => {
    // Không có REST liệt kê thành viên server (members đi qua READY), nên kiểm
    // qua DM summary — cùng nguồn `users.avatar_url`.
    await upload(alice, { filename: "pixel.png", mime: "image/png", data: PNG_1x1 });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/users/@me/channels",
      headers: auth(bob.token),
      payload: { recipientId: alice.id },
    });
    expect(created.statusCode).toBeLessThan(300);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/@me/channels",
      headers: auth(bob.token),
    });
    expect(list.statusCode).toBe(200);
    const dms = list.json<{ recipient: { userId: string; avatarUrl: string | null } }[]>();
    const withAlice = dms.find((dm) => dm.recipient.userId === alice.id);
    expect(withAlice?.recipient.avatarUrl).toMatch(new RegExp(`/users/${alice.id}/avatar/\\d+$`));
  });

  it("avatar lưu đúng ở thư mục riêng, không trộn với tệp đính kèm", async () => {
    const me = await getCurrentUser(ctx, alice.token);
    const uploadId = me.avatarUrl!.split("/").pop()!;
    const files = await readdir(ctx.config.avatarsDir);
    expect(files).toContain(uploadId);
    // Không ghi vào UPLOADS_DIR của tệp đính kèm.
    expect(path.resolve(ctx.config.avatarsDir)).not.toBe(path.resolve(ctx.uploadsDir));
  });
});

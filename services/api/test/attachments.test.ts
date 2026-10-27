import { readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auth,
  createGuild,
  createTestContext,
  listChannels,
  registerUser,
  type RegisteredUser,
  type TestContext,
} from "./helpers.js";

/** PNG 1×1 trong suốt (hợp lệ, đủ để parser đọc IHDR). */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** GIF chỉ cần header hợp lệ để kiểm kích thước 40×30 đọc từ logical screen. */
function gifHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.write("GIF89a", 0, "latin1");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

interface UploadFile {
  filename: string;
  mime: string;
  data: Buffer;
}

const BOUNDARY = "----umaruTestBoundary7d1";

/** Dựng thân multipart thủ công — không cần thêm dependency chỉ để test. */
function multipart(
  fields: Record<string, string>,
  files: UploadFile[],
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
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

describe("upload tệp đính kèm", () => {
  let ctx: TestContext;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  let guildId: string;
  let channelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await registerUser(ctx, "upload_alice");
    bob = await registerUser(ctx, "upload_bob");
    guildId = await createGuild(ctx, alice.token, "Upload Server");
    const channels = await listChannels(ctx, alice.token, guildId);
    channelId = channels[0]!.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("gửi text + ảnh PNG: 201 kèm metadata và kích thước ảnh", async () => {
    const body = multipart({ content: "ảnh đính kèm" }, [
      { filename: "pixel.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });

    expect(response.statusCode).toBe(201);
    const message = response.json<{
      content: string;
      attachments: {
        id: string;
        filename: string;
        url: string;
        size: number;
        mimeType: string;
        width: number | null;
        height: number | null;
      }[];
    }>();
    expect(message.content).toBe("ảnh đính kèm");
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments[0]!;
    expect(attachment.filename).toBe("pixel.png");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.size).toBe(PNG_1x1.length);
    expect(attachment.width).toBe(1);
    expect(attachment.height).toBe(1);
    expect(attachment.url).toBe(`/api/v1/attachments/${attachment.id}`);
  });

  it("đọc kích thước GIF từ header", async () => {
    const body = multipart({}, [
      { filename: "banner.gif", mime: "image/gif", data: gifHeader(40, 30) },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(201);
    const message = response.json<{
      content: string;
      attachments: { width: number | null; height: number | null }[];
    }>();
    // Chỉ có file, không có text vẫn hợp lệ.
    expect(message.content).toBe("");
    expect(message.attachments[0]).toMatchObject({ width: 40, height: 30 });
  });

  it("danh sách tin nhắn trả kèm attachment", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    const messages = response.json<{ attachments: unknown[] }[]>();
    const withFiles = messages.filter((message) => message.attachments.length > 0);
    expect(withFiles.length).toBeGreaterThanOrEqual(2);
  });

  it("tải file về: đúng byte, đúng content-type, có nosniff", async () => {
    const body = multipart({ content: "tải về" }, [
      { filename: "tải-về.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const attachmentId = sent.json<{ attachments: { id: string }[] }>().attachments[0]!.id;

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: auth(alice.token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload.equals(PNG_1x1)).toBe(true);
  });

  it("người ngoài server không tải được file (404), chưa đăng nhập là 401", async () => {
    const body = multipart({ content: "riêng tư" }, [
      { filename: "private.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const attachmentId = sent.json<{ attachments: { id: string }[] }>().attachments[0]!.id;

    const outsider = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: auth(bob.token),
    });
    expect(outsider.statusCode).toBe(404);

    const anonymous = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("chặn định dạng có thể chạy script (svg, html)", async () => {
    for (const mime of ["image/svg+xml", "text/html"]) {
      const body = multipart({ content: "x" }, [
        { filename: "evil", mime, data: Buffer.from("<script>alert(1)</script>") },
      ]);
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/channels/${channelId}/messages`,
        headers: { ...auth(alice.token), ...body.headers },
        payload: body.payload,
      });
      expect(response.statusCode).toBe(415);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }
  });

  it("tối đa 4 tệp mỗi tin", async () => {
    const body = multipart(
      { content: "5 file" },
      Array.from({ length: 5 }, (_, index) => ({
        filename: `f${index}.png`,
        mime: "image/png",
        data: PNG_1x1,
      })),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it("tên file bị lọc (không cho đường dẫn) và vẫn giữ tiếng Việt", async () => {
    const body = multipart({}, [
      { filename: "../../etc/passwd", mime: "text/plain", data: Buffer.from("hé lô") },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ attachments: { filename: string }[] }>().attachments[0]?.filename).toBe(
      "passwd",
    );
  });

  it("xoá tin nhắn thì file trên đĩa cũng bị xoá", async () => {
    const body = multipart({}, [
      { filename: "tam.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const message = sent.json<{ id: string; attachments: { id: string }[] }>();
    const attachmentId = message.attachments[0]!.id;

    const before = await readdir(ctx.uploadsDir);
    expect(before).toContain(attachmentId);

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(alice.token),
    });
    expect(deleted.statusCode).toBe(204);

    const after = await readdir(ctx.uploadsDir);
    expect(after).not.toContain(attachmentId);
  });

  it("JSON thuần vẫn hoạt động và không tạo attachment", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(alice.token),
      payload: { content: "chỉ text" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ attachments: unknown[] }>().attachments).toEqual([]);
  });

  it("thiếu cả text lẫn file là 400", async () => {
    const body = multipart({}, []);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it("thành viên thường vẫn tải được file (có quyền xem kênh chia sẻ)", async () => {
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/guilds/${guildId}/invites`,
      headers: auth(alice.token),
      payload: { channelId },
    });
    const code = invite.json<{ code: string }>().code;
    const join = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${code}`,
      headers: auth(bob.token),
    });
    expect(join.statusCode).toBe(200);

    const body = multipart({ content: "cho bob" }, [
      { filename: "share.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const attachmentId = sent.json<{ attachments: { id: string }[] }>().attachments[0]!.id;

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: auth(bob.token),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("trần kích thước tệp", () => {
  let ctx: TestContext;
  let user: RegisteredUser;
  let channelId: string;

  beforeAll(async () => {
    // Trần 1KB để test nhanh, không phải đẩy 10MB qua bộ nhớ.
    ctx = await createTestContext({ MAX_UPLOAD_BYTES: "1024" });
    user = await registerUser(ctx, "upload_quota");
    const guildId = await createGuild(ctx, user.token, "Quota Server");
    channelId = (await listChannels(ctx, user.token, guildId))[0]!.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("file vượt trần trả 413 và không để lại rác trên đĩa", async () => {
    const body = multipart({ content: "to quá" }, [
      { filename: "big.bin", mime: "application/zip", data: Buffer.alloc(4096, 7) },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(user.token), ...body.headers },
      payload: body.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("PAYLOAD_TOO_LARGE");
    // Không có file nào bị bỏ lại, và cũng không có tin nhắn rỗng được tạo.
    expect(await readdir(ctx.uploadsDir)).toEqual([]);
    const messages = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(user.token),
    });
    expect(messages.json<unknown[]>()).toEqual([]);
  });
});

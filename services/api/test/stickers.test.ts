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

/**
 * Sticker theo server (mục 53).
 *
 * Trọng tâm:
 *  * ảnh phải **vuông** và không được là file đổi tên (kiểm magic bytes);
 *  * quyền: thành viên xem/gửi được, chỉ người có `MANAGE_EXPRESSIONS` mới
 *    tạo/xoá gói;
 *  * sticker của server A **không** gửi được vào kênh server B, và ảnh của nó
 *    không tải được bởi người ngoài server.
 */

let ctx: TestContext;
let owner: RegisteredUser;
let member: RegisteredUser;
let outsider: RegisteredUser;
let guildId: string;
let channelId: string;
let otherGuildId: string;
let otherChannelId: string;

/** PNG 1×1 hợp lệ (header + IHDR thật, đủ để `readImageSize` đọc). */
function pngOfSize(width: number, height: number): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // magic
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x00, // width (điền sau)
    0x00, 0x00, 0x00, 0x00, // height
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, color type, ...
    0x00, 0x00, 0x00, 0x00, // CRC (không cần đúng với hàm đọc header)
    0x00, 0x00, 0x00, 0x00, // IEND-ish đệm
  ]);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function multipart(body: Buffer, fields: Record<string, string> = {}): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----umaruStickerBoundary";
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sticker.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
  );
  chunks.push(body);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(Buffer.concat(chunks).length),
    },
  };
}

async function createPack(token: string, guild: string, name: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guild}/sticker-packs`,
    headers: auth(token),
    payload: { name },
  });
}

async function uploadSticker(
  token: string,
  packId: string,
  name: string,
  image: Buffer = pngOfSize(64, 64),
) {
  const { payload, headers } = multipart(image, { name });
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/sticker-packs/${packId}/stickers`,
    headers: { ...auth(token), ...headers },
    payload,
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  owner = await registerUser(ctx, "stk_owner");
  member = await registerUser(ctx, "stk_member");
  outsider = await registerUser(ctx, "stk_outsider");

  guildId = await createGuild(ctx, owner.token, "Sticker GW");
  channelId = (await listChannels(ctx, owner.token, guildId))[0]!.id;
  const invite = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/guilds/${guildId}/invites`,
    headers: auth(owner.token),
    payload: { channelId },
  });
  await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${invite.json<{ code: string }>().code}`,
    headers: auth(member.token),
  });

  otherGuildId = await createGuild(ctx, outsider.token, "Outsider GW");
  otherChannelId = (await listChannels(ctx, outsider.token, otherGuildId))[0]!.id;
});

afterAll(async () => {
  await ctx.close();
});

describe("gói sticker", () => {
  it("owner tạo gói và thấy trong danh sách", async () => {
    const created = await createPack(owner.token, guildId, "Biểu cảm");
    expect(created.statusCode).toBe(201);
    const pack = created.json<{ id: string; name: string; guildId: string; stickers: unknown[] }>();
    expect(pack.name).toBe("Biểu cảm");
    expect(pack.guildId).toBe(guildId);
    expect(pack.stickers).toEqual([]);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/sticker-packs`,
      headers: auth(member.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<Array<{ id: string }>>().some((entry) => entry.id === pack.id)).toBe(true);
  });

  it("thành viên thường không tạo được gói (403)", async () => {
    const response = await createPack(member.token, guildId, "Tự tạo");
    expect(response.statusCode).toBe(403);
  });

  it("người ngoài server không đọc được danh sách (404)", async () => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/sticker-packs`,
      headers: auth(outsider.token),
    });
    expect(response.statusCode).toBe(404);
  });

  it("tên gói trùng bị chặn (409), khoảng trắng được gộp", async () => {
    const duplicate = await createPack(owner.token, guildId, " Biểu   cảm ");
    expect(duplicate.statusCode).toBe(409);
  });

  it("đổi tên gói", async () => {
    const pack = (await createPack(owner.token, guildId, "Tên cũ")).json<{ id: string }>();
    const renamed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/sticker-packs/${pack.id}`,
      headers: auth(owner.token),
      payload: { name: "Tên mới" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe("Tên mới");
  });
});

describe("tải sticker lên", () => {
  let packId: string;

  beforeAll(async () => {
    packId = (await createPack(owner.token, guildId, "Tải lên")).json<{ id: string }>().id;
  });

  it("ảnh vuông hợp lệ → 201 kèm imageUrl", async () => {
    const response = await uploadSticker(owner.token, packId, "Mèo cười");
    expect(response.statusCode).toBe(201);
    const sticker = response.json<{
      id: string;
      name: string;
      imageUrl: string;
      width: number;
      height: number;
      mimeType: string;
    }>();
    expect(sticker.name).toBe("Mèo cười");
    expect(sticker.width).toBe(64);
    expect(sticker.height).toBe(64);
    expect(sticker.mimeType).toBe("image/png");
    expect(sticker.imageUrl).toBe(`/api/v1/guilds/${guildId}/stickers/${sticker.id}/image`);
  });

  it("ảnh không vuông bị từ chối (400) và file không bị giữ lại", async () => {
    const response = await uploadSticker(owner.token, packId, "Chữ nhật", pngOfSize(64, 32));
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain("vuông");
  });

  it("file không phải ảnh bị từ chối (415) dù khai image/png", async () => {
    const response = await uploadSticker(
      owner.token,
      packId,
      "Giả mạo",
      Buffer.from("MZ không phải ảnh"),
    );
    expect(response.statusCode).toBe(415);
  });

  it("thành viên thường không tải lên được (403)", async () => {
    const response = await uploadSticker(member.token, packId, "Của member");
    expect(response.statusCode).toBe(403);
  });

  it("thiếu tên sticker → 400", async () => {
    const response = await uploadSticker(owner.token, packId, "");
    expect(response.statusCode).toBe(400);
  });

  it("tên sticker trùng trong gói → 409", async () => {
    await uploadSticker(owner.token, packId, "Trùng tên");
    const response = await uploadSticker(owner.token, packId, "Trùng tên");
    expect(response.statusCode).toBe(409);
  });
});

describe("gửi sticker trong tin", () => {
  let stickerId: string;
  let imageUrl: string;

  beforeAll(async () => {
    const pack = (await createPack(owner.token, guildId, "Gửi tin")).json<{ id: string }>();
    const sticker = (await uploadSticker(owner.token, pack.id, "Vẫy tay")).json<{
      id: string;
      imageUrl: string;
    }>();
    stickerId = sticker.id;
    imageUrl = sticker.imageUrl;
  });

  it("gửi tin chỉ có sticker (content rỗng) và đọc lại thấy sticker", async () => {
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(member.token),
      payload: { stickerId },
    });
    expect(sent.statusCode).toBe(201);
    const message = sent.json<{
      id: string;
      content: string;
      sticker: { id: string; name: string; imageUrl: string } | null;
    }>();
    expect(message.content).toBe("");
    expect(message.sticker?.id).toBe(stickerId);
    expect(message.sticker?.name).toBe("Vẫy tay");

    const page = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(member.token),
    });
    const found = page
      .json<Array<{ id: string; sticker?: { id: string } | null }>>()
      .find((entry) => entry.id === message.id);
    expect(found?.sticker?.id).toBe(stickerId);
  });

  it("sticker của server khác bị chặn (400)", async () => {
    const otherPack = (await createPack(outsider.token, otherGuildId, "Ngoài")).json<{
      id: string;
    }>();
    const otherSticker = (await uploadSticker(outsider.token, otherPack.id, "Ngoài")).json<{
      id: string;
    }>();
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(member.token),
      payload: { stickerId: otherSticker.id },
    });
    expect(response.statusCode).toBe(400);
  });

  it("sticker + poll cùng tin bị chặn (400)", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(member.token),
      payload: {
        stickerId,
        poll: { question: "Chọn gì?", options: ["A", "B"] },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("stickerId không tồn tại → 400", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: auth(member.token),
      payload: { stickerId: "999999999999999999" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("thành viên tải được ảnh; người ngoài server thì không", async () => {
    const ok = await ctx.app.inject({
      method: "GET",
      url: imageUrl,
      headers: auth(member.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.rawPayload.length).toBeGreaterThan(0);

    const denied = await ctx.app.inject({
      method: "GET",
      url: imageUrl,
      headers: auth(outsider.token),
    });
    expect(denied.statusCode).toBe(404);
  });

  it("sticker đang được dùng thì không xoá được (409)", async () => {
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/stickers/${stickerId}`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("STICKER_IN_USE");
  });
});

describe("xoá", () => {
  it("xoá sticker chưa dùng: 204 và file bị gỡ khỏi kho", async () => {
    const pack = (await createPack(owner.token, guildId, "Xoá lẻ")).json<{ id: string }>();
    const sticker = (await uploadSticker(owner.token, pack.id, "Tạm")).json<{ id: string }>();

    const before = await readdir(ctx.config.stickersDir);
    expect(before.length).toBeGreaterThan(0);

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/stickers/${sticker.id}`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(204);

    const after = await readdir(ctx.config.stickersDir);
    expect(after.length).toBe(before.length - 1);
  });

  it("xoá gói: 204, sticker trong gói cũng mất", async () => {
    const pack = (await createPack(owner.token, guildId, "Xoá cả gói")).json<{ id: string }>();
    await uploadSticker(owner.token, pack.id, "Một");
    await uploadSticker(owner.token, pack.id, "Hai");

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/sticker-packs/${pack.id}`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/guilds/${guildId}/sticker-packs`,
      headers: auth(owner.token),
    });
    expect(list.json<Array<{ id: string }>>().some((entry) => entry.id === pack.id)).toBe(false);
  });

  it("thành viên thường không xoá được gói (403)", async () => {
    const pack = (await createPack(owner.token, guildId, "Không cho xoá")).json<{ id: string }>();
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/sticker-packs/${pack.id}`,
      headers: auth(member.token),
    });
    expect(response.statusCode).toBe(403);
  });
});

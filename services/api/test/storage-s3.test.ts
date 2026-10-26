import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { signRequest } from "../src/uploads/sigv4.js";
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
 * Test cho kho S3/R2 bằng một **S3 giả** chạy trong tiến trình test.
 *
 * Vì sao không mock `S3FileStore`: mock lớp đó thì chỉ chứng minh route gọi đúng
 * hàm, còn toàn bộ phần dễ sai — ký SigV4, đặt khoá, Range cho `peek`, xoá khi
 * xoá tin — không được chạy. S3 giả ở đây nhận HTTP thật nên mọi thứ đi qua
 * `node:http` đều được kiểm, kể cả chữ ký: server **tính lại** chữ ký từ đúng
 * những header nhận được và trả 403 nếu lệch, giống S3 thật.
 *
 * Chỗ này cũng bắt được lỗi "ký một đằng gửi một nẻo" (ví dụ sửa header sau khi
 * ký) — loại lỗi mà test bằng mock không bao giờ thấy.
 */

interface FakeObject {
  body: Buffer;
  contentType: string | undefined;
}

interface RecordedRequest {
  method: string;
  key: string;
  signatureOk: boolean;
  signatureError: string | null;
  payloadHash: string | undefined;
  signedHeaders: string;
}

class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: RecordedRequest[] = [];
  private server: http.Server | null = null;
  url = "";

  constructor(
    readonly bucket = "umaru-test",
    readonly credentials = {
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      region: "auto",
    },
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === null) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const url = new URL(request.url ?? "/", this.url);
    const prefix = `/${this.bucket}/`;
    const key = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    const method = request.method ?? "GET";

    const verification = this.verifySignature(method, url, request, body);
    this.requests.push({
      method,
      key,
      signatureOk: verification.ok,
      signatureError: verification.error,
      payloadHash: header(request, "x-amz-content-sha256"),
      signedHeaders: verification.signedHeaders,
    });

    if (!verification.ok) {
      response.writeHead(403, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>${verification.error}</Message></Error>`,
      );
      return;
    }

    if (method === "PUT") {
      this.objects.set(key, {
        body,
        contentType: header(request, "content-type"),
      });
      response.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
      response.end();
      return;
    }

    if (method === "DELETE") {
      this.objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

    const object = this.objects.get(key);
    if (object === undefined) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end(
        '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>Not Found</Message></Error>',
      );
      return;
    }

    const headers: Record<string, string> = {
      "content-length": String(object.body.length),
      etag: `"${createHash("md5").update(object.body).digest("hex")}"`,
    };
    if (object.contentType !== undefined) headers["content-type"] = object.contentType;
    if (method === "HEAD") {
      response.writeHead(200, headers);
      response.end();
      return;
    }

    // Range: bản thật trả 206 + phần được hỏi; `peek` dựa vào đây.
    const range = header(request, "range");
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (match !== null) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), object.body.length - 1);
      const slice = object.body.subarray(start, end + 1);
      response.writeHead(206, {
        ...headers,
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${object.body.length}`,
      });
      response.end(slice);
      return;
    }

    response.writeHead(200, headers);
    response.end(object.body);
  }

  /**
   * Tính lại chữ ký từ header **nhận được**. Đây là phần quan trọng nhất của S3
   * giả: nó khiến mọi sai lệch trong SigV4 thành 403, đúng như S3 thật.
   */
  private verifySignature(
    method: string,
    url: URL,
    request: http.IncomingMessage,
    body: Buffer,
  ): { ok: boolean; error: string | null; signedHeaders: string } {
    const authorization = header(request, "authorization") ?? "";
    const parsed = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
    if (parsed === null) {
      return { ok: false, error: `Authorization không đúng dạng: ${authorization}`, signedHeaders: "" };
    }
    const [, accessKeyId, dateStamp, region, signedHeaders, signature] = parsed as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (accessKeyId !== this.credentials.accessKeyId) {
      return { ok: false, error: `Sai access key: ${accessKeyId}`, signedHeaders };
    }

    const amzDate = header(request, "x-amz-date") ?? "";
    const dateMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    if (dateMatch === null) {
      return { ok: false, error: `x-amz-date sai dạng: ${amzDate}`, signedHeaders };
    }
    const [, y, mo, d, h, mi, s] = dateMatch as unknown as string[];
    const now = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    );

    // Header nào đã ký thì phải gửi đúng giá trị đã ký. Bỏ `host` (Node tự đặt
    // lại, và nó khớp URL) cùng hai header mà `signRequest` tự sinh.
    const reSignHeaders: Record<string, string> = {};
    for (const name of signedHeaders.split(";")) {
      if (["host", "x-amz-content-sha256", "x-amz-date"].includes(name)) continue;
      const value = header(request, name);
      if (value === undefined) {
        return { ok: false, error: `Header đã ký nhưng không gửi: ${name}`, signedHeaders };
      }
      reSignHeaders[name] = value;
    }

    const rebuilt = signRequest({
      method,
      url,
      headers: reSignHeaders,
      payloadHash: header(request, "x-amz-content-sha256") ?? "",
      credentials: {
        accessKeyId: this.credentials.accessKeyId,
        secretAccessKey: this.credentials.secretAccessKey,
        region: this.credentials.region,
      },
      now,
    });
    const rebuiltSignature = /Signature=([0-9a-f]{64})$/.exec(rebuilt["authorization"] ?? "")?.[1];
    if (rebuiltSignature !== signature) {
      return {
        ok: false,
        error: `Chữ ký không khớp (nhận ${signature}, tính lại ${rebuiltSignature})`,
        signedHeaders,
      };
    }
    if (dateStamp !== amzDate.slice(0, 8) || region !== this.credentials.region) {
      return { ok: false, error: "Scope (ngày/region) không khớp", signedHeaders };
    }
    // Payload hash phải khớp body thật — S3 thật cũng kiểm (trừ UNSIGNED-PAYLOAD).
    const hash = header(request, "x-amz-content-sha256");
    if (hash !== "UNSIGNED-PAYLOAD") {
      const actual = createHash("sha256").update(body).digest("hex");
      if (hash !== actual) {
        return { ok: false, error: "x-amz-content-sha256 không khớp body", signedHeaders };
      }
    }
    return { ok: true, error: null, signedHeaders };
  }
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** PNG 1×1 trong suốt — ảnh hợp lệ nhỏ nhất mà parser đọc được. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const BOUNDARY = "----umaruS3Boundary9a3";

function multipart(
  fields: Record<string, string>,
  files: Array<{ filename: string; mime: string; data: Buffer }>,
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

describe("kho S3: tải lên, tải về, xoá qua S3 giả", () => {
  let s3: FakeS3;
  let ctx: TestContext;
  let alice: RegisteredUser;
  let channelId: string;

  beforeAll(async () => {
    s3 = new FakeS3();
    await s3.start();
    ctx = await createTestContext({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: s3.bucket,
      S3_ENDPOINT: s3.url,
      S3_REGION: s3.credentials.region,
      S3_ACCESS_KEY_ID: s3.credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.credentials.secretAccessKey,
      S3_PREFIX: "umaru",
    });
    alice = await registerUser(ctx, "s3_alice");
    const guildId = await createGuild(ctx, alice.token, "S3 Server");
    channelId = (await listChannels(ctx, alice.token, guildId))[0]!.id;
  });

  afterAll(async () => {
    await ctx.close();
    await s3.close();
  });

  it("cấu hình đúng: dùng driver s3, không ghi gì xuống đĩa", () => {
    expect(ctx.config.storage).not.toBeNull();
    expect(ctx.config.storage?.bucket).toBe(s3.bucket);
  });

  it("gửi tin có tệp: tệp nằm trong bucket, chữ ký hợp lệ, hash khớp body", async () => {
    const body = multipart({ content: "kèm tệp" }, [
      { filename: "pixel.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(201);
    const message = response.json();
    const attachmentId = message.attachments[0].id as string;

    // Khoá đúng: `<prefix>/attachments/<id>`, không có tên gốc của tệp.
    const stored = s3.objects.get(`umaru/attachments/${attachmentId}`);
    expect(stored).toBeDefined();
    expect(stored?.body.equals(PNG_1x1)).toBe(true);
    expect(stored?.contentType).toBe("image/png");

    const put = s3.requests.find(
      (entry) => entry.method === "PUT" && entry.key === `umaru/attachments/${attachmentId}`,
    );
    expect(put?.signatureOk).toBe(true);
    expect(put?.signatureError).toBeNull();
    expect(put?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // `content-length` cố ý **không** ký (xem s3.ts) — chỉ gửi kèm.
    expect(put?.signedHeaders).not.toContain("content-length");
    expect(put?.signedHeaders).toContain("x-amz-content-sha256");

    // Kích thước ảnh đọc được từ kho qua Range request (`peek`), không cần
    // tệp cục bộ: ảnh 1×1.
    expect(message.attachments[0].width).toBe(1);
    expect(message.attachments[0].height).toBe(1);

    const ranged = s3.requests.filter((entry) => entry.method === "GET");
    expect(ranged.length).toBeGreaterThan(0);
  });

  it("tải tệp về: đúng byte, đúng content-type, đúng độ dài", async () => {
    const body = multipart({ content: "tải về" }, [
      { filename: "pixel.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const attachmentId = created.json().attachments[0].id as string;

    const downloaded = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: auth(alice.token),
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toBe("image/png");
    expect(downloaded.headers["content-length"]).toBe(String(PNG_1x1.length));
    expect(downloaded.rawPayload.equals(PNG_1x1)).toBe(true);
  });

  it("tệp không có trong kho → 404 (không phải 500)", async () => {
    const body = multipart({ content: "sẽ bị xoá khỏi kho" }, [
      { filename: "pixel.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const attachmentId = created.json().attachments[0].id as string;
    s3.objects.delete(`umaru/attachments/${attachmentId}`);

    const downloaded = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: auth(alice.token),
    });
    expect(downloaded.statusCode).toBe(404);
  });

  it("xoá tin nhắn → xoá luôn tệp trong kho", async () => {
    const body = multipart({ content: "xoá nhé" }, [
      { filename: "pixel.png", mime: "image/png", data: PNG_1x1 },
    ]);
    const created = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    const message = created.json();
    const attachmentId = message.attachments[0].id as string;
    expect(s3.objects.has(`umaru/attachments/${attachmentId}`)).toBe(true);

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
      headers: auth(alice.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect(s3.objects.has(`umaru/attachments/${attachmentId}`)).toBe(false);
  });

  it("avatar cũng đi vào kho (prefix riêng) và tải về được", async () => {
    const body = multipart({}, [{ filename: "pixel.png", mime: "image/png", data: PNG_1x1 }]);
    const uploaded = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { ...auth(alice.token), ...body.headers },
      payload: body.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const avatarUrl = uploaded.json().avatarUrl as string;
    const uploadId = avatarUrl.split("/").pop() as string;
    expect(s3.objects.has(`umaru/avatars/${uploadId}`)).toBe(true);

    const fetched = await ctx.app.inject({
      method: "GET",
      url: avatarUrl,
      headers: auth(alice.token),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload.equals(PNG_1x1)).toBe(true);

    // Đổi avatar: ảnh cũ phải bị xoá khỏi kho, không để rác vĩnh viễn.
    const second = multipart({}, [{ filename: "pixel2.png", mime: "image/png", data: PNG_1x1 }]);
    const replaced = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/@me/avatar",
      headers: { ...auth(alice.token), ...second.headers },
      payload: second.payload,
    });
    expect(replaced.statusCode).toBe(200);
    expect(s3.objects.has(`umaru/avatars/${uploadId}`)).toBe(false);
  });

  it("mọi request gửi tới kho đều có chữ ký hợp lệ", () => {
    const broken = s3.requests.filter((entry) => !entry.signatureOk);
    expect(broken.map((entry) => `${entry.method} ${entry.key}: ${entry.signatureError}`)).toEqual(
      [],
    );
  });
});

describe("cấu hình kho", () => {
  const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

  it("mặc định là đĩa cục bộ", () => {
    const config = loadConfig({ ...base });
    expect(config.storage).toBeNull();
  });

  it("STORAGE_DRIVER=s3 thiếu biến → ném lỗi nêu đúng tên biến thiếu", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(
      /S3_ENDPOINT.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/,
    );
  });

  it("STORAGE_DRIVER lạ → ném lỗi thay vì lặng lẽ dùng đĩa cục bộ", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "r2" })).toThrow(/STORAGE_DRIVER/);
  });

  it("đủ biến → cấu hình hợp lệ, region mặc định `auto`, prefix mặc định `umaru`", () => {
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "umaru",
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config.storage).toEqual({
      bucket: "umaru",
      endpoint: "https://acct.r2.cloudflarestorage.com/",
      region: "auto",
      accessKeyId: "key",
      secretAccessKey: "secret",
      prefix: "umaru",
    });
  });
});

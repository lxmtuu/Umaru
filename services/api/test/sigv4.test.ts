import { describe, expect, it } from "vitest";
import {
  EMPTY_SHA256,
  canonicalUri,
  formatAmzDate,
  signRequest,
  uriEncode,
} from "../src/uploads/sigv4.js";

/**
 * Vector lấy từ tài liệu AWS "Signature Calculations for the Authorization
 * Header" (S3, sig-v4-header-based-auth). Khoá và ngày mốc là giá trị ví dụ của
 * tài liệu, không phải credential thật.
 *
 * Đây là cách duy nhất biết chắc phần ký đúng: tự viết SigV4 mà chỉ test bằng
 * chính nó thì sai cũng không ai phát hiện — S3 sẽ trả 403 lúc chạy thật.
 */
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
const now = new Date("2013-05-24T00:00:00.000Z");

function signatureOf(headers: Record<string, string>): string {
  const authorization = headers["authorization"] ?? "";
  const match = /Signature=([0-9a-f]{64})/.exec(authorization);
  return match?.[1] ?? `<không tìm thấy chữ ký trong: ${authorization}>`;
}

function signedHeadersOf(headers: Record<string, string>): string {
  const match = /SignedHeaders=([^,]+)/.exec(headers["authorization"] ?? "");
  return match?.[1] ?? "";
}

describe("sigv4: vector chính thức của AWS", () => {
  it("GET object có header Range", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
      credentials,
      now,
    });
    expect(signatureOf(headers)).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(signedHeadersOf(headers)).toBe("host;range;x-amz-content-sha256;x-amz-date");
    expect(headers["authorization"]).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    // Ngày gửi lên phải đúng định dạng AWS (không dấu `:`/`-`, có `Z`).
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("PUT object: đường dẫn có ký tự cần encode (`$`) và header phụ", () => {
    const body = "Welcome to Amazon S3.";
    const headers = signRequest({
      method: "PUT",
      // Cố ý truyền URL **đã** encode, đúng như client thật dựng URL.
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      credentials,
      now,
    });
    expect(body.length).toBeGreaterThan(0);
    expect(signatureOf(headers)).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
    expect(signedHeadersOf(headers)).toBe(
      "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
    );
  });

  it("GET bucket có query một khoá rỗng (?lifecycle)", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle="),
      payloadHash: EMPTY_SHA256,
      credentials,
      now,
    });
    expect(signatureOf(headers)).toBe(
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it("GET bucket có query nhiều khoá (?max-keys=2&prefix=J) — phải sort", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      payloadHash: EMPTY_SHA256,
      credentials,
      now,
    });
    expect(signatureOf(headers)).toBe(
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("sigv4: chi tiết dễ sai", () => {
  it("encode=%20 nếu ký tự lạ nằm trong query hoặc đoạn đường dẫn", () => {
    expect(uriEncode("a b")).toBe("a%20b");
    // `encodeURIComponent` giữ nguyên bốn ký tự này; AWS thì không.
    expect(uriEncode("!*'()")).toBe("%21%2A%27%28%29");
    expect(uriEncode("tiếng-việt")).toBe("ti%E1%BA%BFng-vi%E1%BB%87t");
  });

  it("canonicalUri chỉ encode MỘT lần dù đầu vào đã encode hay chưa", () => {
    expect(canonicalUri("/a/test$file.text")).toBe("/a/test%24file.text");
    expect(canonicalUri("/a/test%24file.text")).toBe("/a/test%24file.text");
    expect(canonicalUri("/umaru/attachments/240329223191920640")).toBe(
      "/umaru/attachments/240329223191920640",
    );
    expect(canonicalUri("/")).toBe("/");
  });

  it("khoảng trắng trong header được gộp và trim trước khi ký", () => {
    const a = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/x"),
      headers: { "x-amz-meta-note": "  hai   khoảng   trắng  " },
      payloadHash: EMPTY_SHA256,
      credentials,
      now,
    });
    expect(a["x-amz-meta-note"]).toBe("hai khoảng trắng");
  });

  it("đổi một byte của payload hash là đổi chữ ký (không ký rỗng)", () => {
    const base = {
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/x"),
      credentials,
      now,
    };
    const withBody = signRequest({ ...base, payloadHash: "44ce7dd6" + "0".repeat(56) });
    const empty = signRequest({ ...base, payloadHash: EMPTY_SHA256 });
    expect(signatureOf(withBody)).not.toBe(signatureOf(empty));
  });

  it("host có cổng vẫn phải được ký (MinIO chạy ở :9000)", () => {
    // Đã từng là lỗi thật khi đối chiếu với một implementation khác: nếu ai đó
    // "chuẩn hoá" host thành `url.hostname` thì chữ ký không còn khớp header
    // `Host: minio:9000` mà Node gửi đi → MinIO trả 403 dù R2/S3 vẫn chạy.
    const base = {
      method: "GET",
      headers: {},
      payloadHash: EMPTY_SHA256,
      credentials,
      now,
    };
    const withPort = signRequest({ ...base, url: new URL("http://minio.internal:9000/x") });
    const withoutPort = signRequest({ ...base, url: new URL("http://minio.internal/x") });
    expect(signatureOf(withPort)).not.toBe(signatureOf(withoutPort));
    // Header gửi đi **không** kèm `host`: Node tự đặt từ URL, phải khớp y hệt.
    expect(withPort["host"]).toBeUndefined();
  });

  it("formatAmzDate đúng định dạng, không phụ thuộc múi giờ máy chạy", () => {
    expect(formatAmzDate(new Date("2026-10-26T13:05:09.123Z"))).toBe("20261026T130509Z");
  });
});

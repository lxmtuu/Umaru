/**
 * Khai báo tối thiểu cho `http_ece` — thư viện giải mã push mà `web-push` dùng.
 *
 * Chỉ dùng trong **test**: để test mở được payload đã mã hoá bằng đúng khoá của
 * "trình duyệt" giả, thay vì tin rằng nội dung gửi đi là đúng. Gói này không có
 * types riêng và ta không muốn thêm một `@types` chỉ để mô tả một hàm.
 */
declare module "http_ece" {
  export function decrypt(
    input: Uint8Array | Buffer,
    params: {
      version: "aes128gcm" | "aesgcm";
      privateKey: unknown;
      authSecret: string | Buffer;
      dh?: string;
      salt?: string;
    },
  ): Buffer;
}

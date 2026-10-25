# Văn bản pháp lý (Terms & Privacy)

## Nội dung nằm ở đâu

| Thứ | Vị trí |
|---|---|
| Nội dung Điều khoản + Chính sách (EN/VI) | [`apps/web/src/lib/legal.ts`](../../apps/web/src/lib/legal.ts) |
| Phiên bản văn bản (ngày hiệu lực) | [`packages/protocol/src/legal.ts`](../../packages/protocol/src/legal.ts) — `LEGAL_VERSION` |
| Trang hiển thị | `/terms`, `/privacy` (`?lang=en|vi`) — xem `apps/web/src/components/LegalPage.tsx` |
| Bằng chứng đồng ý | `users.terms_accepted_at`, `users.terms_version` (migration `0005_terms_consent.sql`) |

Chỉ có **một nguồn**: sửa `legal.ts` rồi tăng `LEGAL_VERSION`, **đừng** copy văn bản sang file khác
(tránh hai bản lệch nhau). Test `apps/web/src/lib/legalRoute.test.ts` kiểm bản EN/VI có cùng số mục
và cùng ngày hiệu lực, nên quên dịch một mục sẽ fail test.

## Trạng thái: **BẢN NHÁP** — chưa thay thế tư vấn pháp lý

Văn bản do kỹ thuật viết, mô tả đúng những gì hệ thống đang làm. Trước khi phát hành công khai cần:

- [ ] **Luật sư rà soát** (Việt Nam: Luật An ninh mạng 2018, Nghị định 72/2013/NĐ-CP,
      Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân; EU: GDPR).
- [ ] Xác nhận **tư cách pháp lý của người vận hành** ("Yami, lxmtuu" hiện là nhóm dự án, không phải
      pháp nhân) — có thể cần đăng ký hộ kinh doanh/doanh nghiệp tuỳ mô hình.
- [ ] Kiểm chứng email liên hệ `lexuanminhtufw@gmail.com` dùng được và có người theo dõi
      (yêu cầu về quyền dữ liệu phải phản hồi trong 30 ngày).
- [ ] Cân nhắc email riêng cho quyền riêng tư (`privacy@…`) thay vì hộp thư cá nhân.

## Những cam kết trong văn bản **chưa** được mã nguồn bảo đảm

Đây là danh sách việc phải làm để văn bản không nói sai (ưu tiên trước khi public):

1. **Log kỹ thuật giữ tối đa 30 ngày** — hiện Fastify ghi log ra stdout, **chưa có** cơ chế xoay vòng/xoá.
   Cần: logrotate hoặc cấu hình nền tảng giữ 30 ngày.
2. **Tự xoá tài khoản** — hiện chỉ có đường "gửi email yêu cầu". Nên có nút xoá tài khoản trong app
   (xoá cascade đã đúng nhờ `ON DELETE CASCADE`).
3. **Xuất dữ liệu (data export)** — chưa có; hiện xử lý thủ công khi có yêu cầu.
4. **Thông báo khi sửa điều khoản** — chưa có cơ chế broadcast; hiện dựa vào việc đổi `LEGAL_VERSION`.
   Khi cần, thêm bước "yêu cầu đồng ý lại" nếu `users.terms_version` khác bản hiện hành.
5. **Xoá log/tệp khi xoá tài khoản** — tệp đính kèm đã xoá theo tin nhắn, nhưng chưa có job dọn tệp mồ côi.

## Quy ước khi sửa văn bản

1. Sửa cả `vi` và `en` trong `apps/web/src/lib/legal.ts`.
2. Tăng `LEGAL_VERSION` (định dạng `YYYY-MM-DD`) trong `packages/protocol/src/legal.ts`.
3. `pnpm --filter @umaru/web test` (test kiểm parity EN/VI) rồi `pnpm typecheck && pnpm build`.
4. Nếu thay đổi ảnh hưởng quyền người dùng: ghi rõ trong PR và cân nhắc yêu cầu đồng ý lại.

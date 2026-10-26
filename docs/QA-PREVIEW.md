# QA trong trình duyệt — checklist ngắn

Mục tiêu: kiểm những thứ **test tự động không thể** kiểm (hành vi trình duyệt,
layout, quyền hệ thống), không lặp lại việc `pnpm test` đã lo.

## Dựng môi trường (khoảng 1 phút)

```bash
scripts/dev-pg.sh up                 # PostgreSQL nhúng ở cổng 55432 (.cache/dev-pg)
pnpm --filter @umaru/api build
pnpm --filter @umaru/api migrate
node scripts/seed-dev.mjs            # 3 user + server demo + DM + group DM
pnpm --filter @umaru/api start       # API :4000
pnpm --filter @umaru/web build && pnpm --filter @umaru/web preview   # web :4173
```

Tài khoản demo (mật khẩu giống nhau: `mat-khau-123`):

| Email | Vai |
| --- | --- |
| `demo@example.com` | `demo_user` — chủ server, có quyền quản trị, thấy `/admin/reports` |
| `minh@example.com` | thành viên |
| `linh@example.com` | thành viên |

Mở **http://localhost:4173** (hoặc cổng preview của sandbox). Hai tài khoản nên
mở ở **hai cửa sổ riêng tư khác nhau** để kiểm realtime.

## Checklist

Đánh dấu khi đã thử; nếu sai, ghi lại bước tái hiện.

### Đăng nhập & khung chat

- [ ] Đăng nhập `demo@example.com` → vào thẳng server "Umaru Demo", thấy kênh
      `chung` + `Phòng smoke`.
- [ ] Gửi tin có `**đậm**`, `*nghiêng*`, `` `code` ``, `~~gạch~~` → hiển thị
      đúng định dạng, không lộ dấu `*`.
- [ ] Gửi `@minh` → hiện gợi ý mention; sau khi gửi, mention được tô sáng.
- [ ] Bấm "trả lời" một tin → ô nhập hiện dòng trích dẫn, tin mới có khung reply.
- [ ] Sửa tin (menu → sửa) → hiện nhãn "đã sửa"; xoá tin → biến mất ở cả hai cửa sổ.
- [ ] Tải lên ảnh < 5 MB → hiện thumbnail; thử tệp > 10 MB → báo lỗi rõ ràng,
      không treo.
- [ ] Ô tìm kiếm: gõ `markdown` → ra tin cũ; bấm kết quả → nhảy tới đúng tin.
- [ ] Ghim một tin → hiện trong danh sách ghim; bỏ ghim → mất khỏi danh sách.

### Realtime (hai cửa sổ)

- [ ] Cửa sổ B (minh) đang mở kênh `chung`: tin từ A hiện **ngay** không cần F5.
- [ ] A gõ tin → B thấy "đang gõ".
- [ ] B đang ở kênh khác → kênh `chung` có chấm chưa đọc; mở ra thì hết.
- [ ] Kéo tab B sang nền (không active) → có tin mới thì tiêu đề tab đổi, và nếu
      đã bật "Thông báo trên máy" thì có thông báo hệ thống.

### Bạn bè & tin nhắn chờ

- [ ] A vào Danh bạ → thêm `linh` → B (linh) thấy lời mời, chấp nhận → hai bên
      thấy nhau trong danh sách bạn.
- [ ] Người lạ (tạo user mới) gửi tin nhắn cho A → A thấy mục "Tin nhắn chờ",
      chấp nhận mới đọc được; từ chối thì người kia không gửi được nữa.
- [ ] Chặn một người → không nhận được tin từ họ nữa.

### Group DM

- [ ] A tạo nhóm với minh + linh, đặt tên "Đội QA" → cả ba thấy nhóm trong
      danh sách DM, tên nhóm đúng.
- [ ] A đổi tên nhóm → B thấy tên mới; thử mời người thứ 11 → báo lỗi giới hạn.

### Kênh thoại & chia sẻ màn hình

> ⚠️ Không có `LIVEKIT_*` trong môi trường QA thì **không có âm thanh** — chỉ
> kiểm được trạng thái giao diện. Muốn có tiếng, đặt ba biến `LIVEKIT_URL`,
> `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` rồi khởi động lại API.

- [ ] Bấm `Phòng smoke` → thanh thoại hiện tên kênh, nút mic/tai nghe bấm được,
      trạng thái âm thanh nói rõ "chưa cấu hình" hoặc "đang kết nối".
- [ ] Bật/tắt mic → biểu tượng và nhãn đổi ngay, B thấy trạng thái của A đổi.
- [ ] Nếu đã cấu hình LiveKit: nói vào mic → B nghe thấy, đèn xanh "đang nói"
      sáng theo âm lượng; rút mạng 5 giây → tự nối lại.
- [ ] Chia sẻ màn hình (Chrome/Edge) → B thấy hình; bấm dừng → hình biến mất,
      không còn thẻ `<video>` mồ côi.
- [ ] Đóng tab khi đang trong phòng → B thấy A rời phòng sau vài giây.

### Thông báo

- [ ] Hồ sơ → "Thông báo đẩy (khi đã đóng tab)": bật → trình duyệt hỏi quyền;
      cho phép → hộp kiểm chuyển sang bật, có nút "Gửi thử".
- [ ] Từ chối quyền ở cài đặt trang → dòng gợi ý nói rõ phải mở cài đặt, hộp
      kiểm **vẫn bấm được** (không khoá im lặng).
- [ ] Server không có VAPID → hộp kiểm bị khoá + ghi "Server chưa bật thông báo
      đẩy" (không phải lỗi của người dùng).
- [ ] Đóng hẳn tab (đã bật push + có VAPID) → nhắn từ tài khoản khác → thông báo
      hiện trên khay hệ thống.

### Giao diện & phụ trợ

- [ ] Thu cửa sổ về ~380 px → thanh bên thu gọn, ô nhập tin vẫn dùng được.
- [ ] `/terms`, `/privacy` mở trực tiếp bằng URL vẫn ra trang (không 404).
- [ ] Đăng nhập bằng `demo_user` → vào `/admin/reports` thấy hàng đợi báo cáo;
      tài khoản thường không thấy mục này.
- [ ] Đổi ngôn ngữ EN ⇄ VI ở hồ sơ → không còn chuỗi tiếng Việt sót lại.
- [ ] Đăng xuất rồi F5 → vẫn ở màn đăng nhập (không tự vào lại).

## Cái gì **chưa** kiểm được ở đây

- Âm thanh thật, chia sẻ màn hình giữa hai máy khác nhau, chất lượng mạng thật.
- Thông báo đẩy khi trình duyệt đã đóng hẳn trên iOS/Safari (giới hạn nền tảng).
- `docker compose up` / nginx thật (sandbox không có Docker) — xem `DEPLOY.md`.
- Nhiều node API cùng lúc (chưa có Redis; xem ROADMAP).

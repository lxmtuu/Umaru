# ADR-0004 — Backend G1 dùng TypeScript (Fastify + `ws`), Rust/Go chỉ khi có ngưỡng đo được

- **Trạng thái:** Accepted
- **Ngày:** 2026-10-22
- **Liên quan:** [ROADMAP §4.2](../../ROADMAP.md), [ADR-0001](0001-monorepo-shared-protocol.md), [gateway-protocol.md](../gateway-protocol.md)

## Bối cảnh

ROADMAP §4.2 đề xuất gateway bằng **Rust/Go** và API bằng **Go hoặc NestJS**. G0 cần chốt để bắt đầu G1.

Thực tế dự án: ngân sách **0đ**, đội nhỏ (1–2 người ở G1), mục tiêu G1 là **100 user đồng thời / 1 server 500 người**, p95 message < 300 ms trong nước. Gateway "khó" của Discord (hàng trăm nghìn kết nối, sharding) là bài toán **chưa tồn tại** ở quy mô này.

Đồng thời, `packages/protocol` đã là TypeScript và chứa codec + permission bitfield. Viết gateway bằng ngôn ngữ khác nghĩa là **viết lại và duy trì song song** phần dễ sai nhất (validate khung, bitfield quyền, thứ tự snowflake).

## Quyết định

**G1–G2: toàn bộ backend bằng TypeScript**, dùng lại `@umaru/protocol`.

| Thành phần | Lựa chọn | Ghi chú |
|---|---|---|
| Runtime | **Node 24 LTS** | `ws` ổn định nhất; hệ sinh thái auth/argon2 trưởng thành |
| REST API | **Fastify** | overhead thấp, schema validation, plugin rõ ràng; không cần NestJS cho quy mô này |
| Gateway | **`ws` + Fastify plugin** cùng process (tách process ở G2 khi voice webhook xuất hiện) | Upgrade tay qua `server.on("upgrade")`, kiểm tra JWT trước khi chấp nhận socket |
| DB access | **Kysely** hoặc **Drizzle** + `pg` | `pg` trả `int8` dạng **string** → khớp trực tiếp type `Snowflake`, không cần convert (xem [data-model.md §1](../data-model.md)) |
| Validation | **Zod** (request body) + validate tay trong codec cho gateway | Dùng chung type đã suy ra từ protocol |
| Background | Cron trong process / `pg-boss` sau | Không cần Kafka/NATS ở G1; fan-out trong một process |
| Hosting | Fly.io / Koyeb / Render (free, hỗ trợ WS sống lâu) | Cloudflare Workers **không** phù hợp cho gateway kiểu này (không có process sống lâu, cần Durable Objects) |

**Kiến trúc chống "khoá cứng" vào Node:**
- Gateway là lớp **mỏng**: xác thực → session → gán `s` → fan-out. Toàn bộ ngữ nghĩa khung nằm trong spec + codec dùng chung.
- Permission resolution là **một hàm thuần** trong `packages/protocol` (test độc lập), cả REST và gateway gọi cùng hàm.
- Giao thức có version và spec viết độc lập với ngôn ngữ → thay implementation không đổi client.

## Ngưỡng chuyển gateway sang Rust/Go (đo, không đoán)

Chuyển khi **bất kỳ** điều kiện sau đúng:

1. > **5.000** kết nối đồng thời trên một node mà RSS > 1 GB hoặc CPU > 70%.
2. p95 **event-loop lag** > 50 ms kéo dài 5 phút (dấu hiệu GC/serialize thành nút cổ chai).
3. Tỷ lệ frame bị đóng do `4008` (slow consumer) > 0,5% ở tải bình thường — tức Node không đẩy kịp.
4. Cần sharding nhiều gateway node mà fan-out qua NATS bắt đầu tốn CPU parse JSON (xem ADR-0002).

Khi đó, chỉ **gateway** viết lại (API giữ TS); client không đổi vì giao thức giữ nguyên.

## Hệ quả

**Tích cực**
- Một ngôn ngữ, một bộ type, một pipeline build → tốc độ ra G1 nhanh nhất với 1–2 người.
- Chia sẻ codec/permission giữa REST và gateway → không có "hai định nghĩa quyền" (lỗ hổng bảo mật phổ biến).
- Tuyển người dễ hơn nhiều so với "Rust gateway + Go API + TS client" ở thị trường VN.
- Deploy free tier đơn giản: 1 service, 1 lệnh.

**Tiêu cực / phải chấp nhận**
- Node tốn RAM/kết nối hơn Rust (ước ~10–30 KB/conn + heap); không phù hợp 100k conn.
- Single-threaded: một tác vụ đồng bộ nặng (hash mật khẩu, resize ảnh) chặn mọi socket → **cấm** chạy CPU-heavy trong process gateway, phải tách worker.
- Khi scale ngang phải giữ fan-out đúng node: dùng NATS + Redis session map (đã thiết kế trong ADR-0003), không dựa vào sticky session.
- Nếu sau này cần Rust, chi phí viết lại gateway ~3–6 tuần (đã giới hạn bề mặt bằng spec).

## Phương án đã loại (ở G1)

| Phương án | Lý do loại |
|---|---|
| Rust gateway ngay từ đầu | +4–8 tuần trước khi có tính năng nào; lợi ích chỉ xuất hiện ở quy mô chưa có |
| Go cho API + gateway | Mất codec/permission dùng chung; hai pipeline; chậm G1 |
| NestJS | Nhiều abstraction, bundle/decorator, không cần cho ~10 module |
| Cloudflare Workers + Durable Objects | Mô hình khác hẳn (mỗi object 1 state), khó làm replay log + fan-out đơn giản; free tier hạn chế |
| Elixir/Phoenix | Rất hợp bài toán realtime nhưng lệch toàn bộ stack TS và khó tuyển ở VN |

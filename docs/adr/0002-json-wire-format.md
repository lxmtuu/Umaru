# ADR-0002 — Wire format gateway v1: JSON text, chưa dùng binary

- **Trạng thái:** Accepted (xem lại ở G3)
- **Ngày:** 2026-10-22
- **Liên quan:** [gateway-protocol.md §1](../gateway-protocol.md), [codec.ts](../../packages/protocol/src/codec.ts)

## Bối cảnh

Gateway truyền tải mọi sự kiện realtime. Lựa chọn wire format ảnh hưởng tới: băng thông (chi phí 0đ ở giai đoạn đầu), CPU serialize ở gateway, khả năng debug, và tốc độ phát triển client trên 3 nền tảng.

Các ứng viên: JSON text, MessagePack, CBOR, Protobuf/FlatBuffers.

## Quyết định

**JSON text (UTF-8) cho v1.** Một frame = một object JSON, `op` là trường đầu tiên theo quy ước.

Lý do:
1. Debug trực tiếp trong DevTools/`wscat` — với dự án nhỏ, khả năng quan sát quan trọng hơn vài chục % băng thông.
2. Snowflake được serialize thành **string** trong JSON, tránh mất chính xác của `number` (JS mất bit sau 2^53). Đây là ràng buộc đã xử lý sẵn trong protocol.
3. `decodeGatewayPayload` chỉ cần `JSON.parse` + validate — chạy được trong browser, React Native, Node, Worker, không cần WASM.
4. Payload v1 nhỏ (message ~300–800 byte); overhead của JSON chấp nhận được ở mức beta.

Ràng buộc kèm theo:
- **Không nén per-message deflate** ở v1 (tiết kiệm CPU gateway, tránh lỗi cấu hình qua proxy).
- Frame ≤ **4 KiB**; frame lớn hơn phải chia (hiếm: attachment gửi qua URL, không nhúng base64).
- Server **không** gửi key `undefined`/`null` tùy tiện: field vắng mặt = không đổi (với `MESSAGE_UPDATE`).
- `GatewayVersion = 1` nằm trong protocol; thêm **event** không tăng version, chỉ thêm **trường bắt buộc/đổi nghĩa** mới tăng.

## Hệ quả

**Tích cực**
- Vòng lặp phát triển nhanh, không cần sinh code, không cần schema compile.
- Log gateway đọc được bằng mắt khi debug sự cố production.
- Ba nền tảng dùng chung codec, không có 3 bản encoder khác nhau.

**Tiêu cực / phải chấp nhận**
- Băng thông ~2–4× so với MessagePack; mỗi dispatch `TYPING_START` vẫn tốn ~120 byte.
- `JSON.parse` chặn event loop ở gateway: ở 10k sự kiện/s sẽ thấy rõ. Đây là lý do có ngưỡng xem lại bên dưới.
- Không có schema cứng → validate phải viết tay trong codec (đã có phần khung, chưa validate sâu từng event; sẽ bổ sung khi có gateway thật).

## Phương án đã loại

| Phương án | Lý do loại ở v1 |
|---|---|
| MessagePack | Giảm băng thông nhưng cần thêm dependency ở 3 client; lợi ích chưa đáng ở < 1k user |
| CBOR | Tương tự, ít thư viện ổn định cho RN hơn |
| Protobuf | Cần pipeline sinh code cho TS/RN + server; đổi schema phức tạp; khó debug |
| WebSocket + SSE fallback | Chưa cần; proxy hiện đại đều hỗ trợ WS |

## Ngưỡng xem lại (đo, không đoán)

Chuyển sang **MessagePack** (hoặc nén toàn frame) khi **bất kỳ** điều kiện sau đúng trong 7 ngày liên tiếp:

1. Băng thông gateway > 200 GB/tháng (vượt ngân sách 0đ ở §4.4 ROADMAP).
2. p95 độ trễ event-loop của gateway > 50 ms do serialize/parse.
3. Trung bình > 5.000 dispatch/giây trên một node.

Khi đó: giữ **cùng** `op`/`t`/`s`, chỉ đổi lớp mã hoá (thêm frame type `1` = MessagePack), giữ JSON làm fallback trong 1 chu kỳ client.

# ADR-0003 — Resume gateway bằng session + Redis Streams replay log

- **Trạng thái:** Accepted (đã hiện thực — xem [ADR-0006](0006-session-replay-redis.md): chọn Redis **list** thay cho Stream)
- **Ngày:** 2026-10-22
- **Liên quan:** [gateway-protocol.md §4](../gateway-protocol.md), [sdk/gateway.ts](../../packages/sdk/src/gateway.ts)

## Bối cảnh

Nghiệm thu G1 yêu cầu: *"Reconnect sau ngắt mạng 30s: không mất tin nhắn, không cần reload trang."* Mạng di động và Wi-Fi ở VN ngắt liên tục; nếu mỗi lần rớt mạng client tải lại toàn bộ state thì trải nghiệm gãy và tốn băng thông.

Cần chọn cách server giữ lại phần sự kiện client bị lỡ trong khoảng ngắt.

Ràng buộc:
- Gateway có thể chạy nhiều node (dù v1 chỉ 1 node, thiết kế phải không chặn).
- Ngân sách 0đ: không được cần Kafka/Elasticsearch chỉ để làm việc này.
- Mất tối đa vài giây sự kiện là chấp nhận được; **không** chấp nhận mất tin nhắn.

## Quyết định

1. Mỗi kết nối có **session** (`session_id` ngẫu nhiên, không phải snowflake) lưu trong Redis:
   `gw:session:{id} = { user_id, node, last_seq, status, disconnected_at }`, **TTL 5 phút** sau khi ngắt.
2. Mỗi session có một **Redis Stream** `gw:replay:{id}` làm replay log:
   - `XADD` cho mỗi dispatch **cần replay**, `MAXLEN ~2000`, `EXPIRE 300`.
   - Field: `s` (sequence), `t` (event), `d` (JSON payload).
3. Reconnect: client gửi `RESUME { token, sessionId, seq }` → server `XRANGE ... (seq +` và phát lại tuần tự **với `s` gốc**, rồi `RESUMED`.
4. Không resume được (session hết TTL, `seq` cũ hơn entry đầu tiên, token khác user) → `INVALID_SESSION d=false` → client identify lại và full resync.
5. **Sequence `s`** do node đang sở hữu session gán, tăng đơn điệu, bắt đầu từ 1. Chỉ node sở hữu được `XADD` vào stream của session đó (lock nhẹ `gw:lock:{id}`).
6. Dispatch **transient** (`TYPING_START`, `PRESENCE_UPDATE`, `speaking`) **không** vào stream — chúng vô nghĩa sau 30 s và làm phình log.

## Hệ quả

**Tích cực**
- Resume hoạt động **qua nhiều node**: node mới chỉ cần đọc Redis, không cần gọi node cũ → rolling deploy không mất event của ai.
- Không thêm hạ tầng mới: Redis đã có trong stack (presence, rate limit, pub/sub) theo ROADMAP §4.2.
- Giới hạn bộ nhớ rõ ràng: `MAXLEN` + `EXPIRE` chặn stream phình vô hạn.
- Client SDK đã hỗ trợ đúng giao thức này (`getSession()`, tự gửi `RESUME`, xử lý `INVALID_SESSION`).

**Tiêu cực / phải chấp nhận**
- Mỗi dispatch tốn thêm 1 lệnh Redis cho mỗi session nhận → với fan-out lớn (kênh 500 người) đây là điểm nóng; phải pipeline và theo dõi `redis_cmd_latency`.
- 2000 event/session ≈ vài trăm KB RAM mỗi session đang bận; 1000 session đồng thời ~ vài trăm MB → cần giám sát, có thể hạ `MAXLEN` xuống 500.
- Redis là **single point of failure** cho resume: mất Redis = mọi client phải full resync (chấp nhận được: không mất dữ liệu, chỉ mất trải nghiệm mượt).
- Replay là **at-least-once**: client phải dedupe theo `s`/`id` (đã ghi trong spec §4.3).

## Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| Buffer trong RAM của node | Không resume được khi reconnect vào node khác; mất khi deploy — đúng lúc cần nhất |
| Không resume, full resync mỗi lần | Đơn giản nhưng trái nghiệm tệ trên mạng di động; tải REST tăng vọt khi mạng chập chờn |
| Lưu mọi event vào Postgres rồi query lại | Ghi DB cho typing/presence là không thể; riêng message thì đã có sẵn để backfill |
| Kafka/NATS JetStream per-session | Đúng hướng nhưng nặng và tốn tài nguyên cho beta 0đ |
| Client tự polling `GET /messages?after=` | Chỉ cứu được message, không cứu được channel/role/presence; vẫn cần gateway |

## Khi nào xem lại

- Fan-out kênh > 1.000 người → chuyển sang **gán `s` theo kênh** hoặc cho client đọc một shared stream thay vì stream riêng/session.
- Redis memory > 70% free tier (Neon/Upstash) → giảm `MAXLEN`, tăng TTL ngắn lại, hoặc gộp stream theo node.
- Nếu sau này gateway viết lại bằng Rust/Go (ADR-0004) → giữ nguyên giao thức, chỉ đổi nơi thực thi; đây là lý do spec tách khỏi implementation.

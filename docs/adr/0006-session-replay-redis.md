# ADR-0006 — Session + replay log trong Redis (nốt ADR-0003)

- **Trạng thái:** Accepted (thay phần "replay trong RAM" của ADR-0003; ADR-0003 vẫn đúng về ý tưởng)
- **Ngày:** 2026-10-26
- **Liên quan:** [ADR-0003](0003-gateway-resume-redis-streams.md), [ADR-0005](0005-gateway-multi-node-bus.md), [gateway-protocol.md §4](../gateway-protocol.md)

## Bối cảnh

ADR-0005 đã cho sự kiện đi qua node. Nhưng **session** và **replay log** vẫn nằm trong RAM
của node đang giữ session, nên còn ba lỗ hổng:

1. Client mất mạng rồi reconnect vào **node khác** → `INVALID_SESSION` → full resync (mất
   tin nhắn đã lỡ nếu người dùng không mở lại kênh).
2. **Restart API** (deploy, `docker compose up`, OOM) → mọi session đang resume biến mất.
3. Rolling deploy: mỗi lần thay bản, toàn bộ client phải tải lại từ đầu.

Đây là lý do ADR-0003 chọn "session + replay trong Redis" ngay từ đầu; phần này là lúc
làm nốt.

## Quyết định

1. **`SessionStore` là một cổng nhỏ** (`gateway/sessionStore.ts`): `save`, `load`, `claim`,
   `appendReplay`, `readReplay`, `delete`. Hub quyết định *khi nào* ghi và *ai* được
   resume; store chỉ giữ chữ. Nhờ vậy logic resume test được mà không cần Redis
   (`MemorySessionStore`), và đổi backend (Redis → Postgres/KV khác) không đụng hub.
2. **Khoá Redis** (`{prefix}:session:{id}`, `{prefix}:replay:{id}`): hash cho metadata
   (`userId`, `seq`, `node`, `disconnectedAt`), **list** cho frame.
3. **List thay vì Stream** (khác câu chữ ADR-0003): yêu cầu thật chỉ là "đọc phần đuôi sau
   `s`", không cần consumer group/ack/nhiều consumer. `RPUSH` + `LTRIM -maxFrames` +
   `LRANGE` là đủ và ít chỗ sai hơn. Stream sẽ đổi khi cần nhiều node cùng đọc một replay.
4. **Một lượt pipeline cho mỗi frame** (`RPUSH`+`LTRIM`+`PEXPIRE`): `dispatch` là hàm đồng
   bộ gọi từ hàng chục chỗ, nên `appendReplay` **không** trả promise — lỗi chỉ log. Mất một
   frame replay không làm hỏng dữ liệu thật (Postgres vẫn là nguồn sự thật).
5. **Resume ở node khác**: đọc metadata, dựng lại session từ Postgres (`loadBootstrap`
   + bạn bè), **đòi quyền sở hữu** (`claim` + `__SESSION_CLAIM` qua bus) rồi mới phát
   tiếp. Node cũ bỏ bản cục bộ, đóng socket cũ với `4003`, **không** phát offline (người
   dùng đang online ở node mới). Điều này chặn hai node cùng gán `s` cho một session.
6. **Khoảng trống replay bị phát hiện, không bị giấu**: nếu `meta.seq > seq` của client mà
   không có frame nào để bù, server trả `INVALID_SESSION d=false` (client identify lại)
   thay vì resume thiếu tin.
7. **TTL**: mọi lần ghi đều `PEXPIRE` cả hai khoá theo `SESSION_TTL_MS` (mặc định 5 phút),
   nên session bị bỏ quên tự biến mất, không cần job dọn.

## Hệ quả

**Tích cực**
- Resume đúng khi client đổi node (LB, mạng di động chuyển Wi-Fi) và khi API restart:
  nhận đúng những frame đã lỡ, có test hai node thật dùng chung store.
- Rolling deploy không còn làm mọi người full resync (miễn Redis sống).
- Bỏ được yêu cầu **sticky LB** chỉ để resume (sticky vẫn nên có để giảm nhiễu, nhưng
  không còn là điều kiện đúng/sai).

**Tiêu cực / còn thiếu (ghi nhận trung thực)**
- **Cửa sổ mất frame khi node chết**: frame chỉ được ghi vào replay bởi node đang sở hữu
  session. Nếu node đó chết rồi người khác nhắn vào kênh, những tin đó **không** vào replay
  của session; resume sẽ không thấy chúng (và cũng không phát hiện được để báo khoảng
  trống, vì `seq` cũng do node chết giữ). Cách chữa đúng là để node phục vụ REST ghi replay
  cho *mọi* session của kênh — đắt hơn nhiều; hoặc client tải lại kênh đang mở sau
  `RESUMED` khi lần resume trước đó thất bại. Ghi ở [§9 gateway-protocol](../gateway-protocol.md#9-việc-còn-thiếu-so-với-spec-này-ghi-nhận-trung-thực).
- **Chi phí ghi**: mỗi dispatch thêm 3 lệnh Redis (một pipeline). Kênh 500 người × 10 tin/s
  là 15k lệnh/s — phải theo dõi; nếu thành điểm nóng thì gộp replay theo kênh thay vì theo
  session (đánh đổi: dedupe theo `s` phức tạp hơn).
- `LRANGE 0 -1` đọc cả list (≤ `MAX_REPLAY_EVENTS`, mặc định vài nghìn frame) mỗi lần
  resume — chấp nhận được vì resume là sự kiện hiếm; nếu list phình thì đổi sang Stream.
- Không có test với **Redis thật** trong sandbox: giao thức kiểm bằng Redis giả nói RESP
  thật (`test/fake-redis.ts`, `scripts/fake-redis.mjs`). Hành vi TTL/eviction/cluster phải
  xem trên Redis thật khi deploy.

## Khi nào xem lại

- Thấy "client mất tin sau khi node chết" trong thực tế → làm phương án ghi replay ở node
  phục vụ REST, hoặc cho web tải lại kênh đang mở sau mỗi lần resume.
- Redis memory > 70% → giảm `MAX_REPLAY_EVENTS`/`SESSION_TTL_MS`.
- Cần nhiều node cùng đọc replay (vd. fan-out gateway tách khỏi API) → chuyển list sang
  Stream có consumer group.

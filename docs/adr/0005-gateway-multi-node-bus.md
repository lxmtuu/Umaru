# ADR-0005 — Nhiều node gateway: bus Redis pub/sub + mỗi node tự lọc

- **Trạng thái:** Accepted (một phần của ADR-0003)
- **Ngày:** 2026-10-26
- **Liên quan:** [gateway-protocol.md §5](../gateway-protocol.md), [ADR-0003](0003-gateway-resume-redis-streams.md), `services/api/src/gateway/{bus,cluster,redis-bus}.ts`

## Bối cảnh

Một kết nối WebSocket chỉ sống trên **một** tiến trình API. Khi chạy từ hai instance
trở lên sau load balancer, người A nối vào node 1, người B nối vào node 2. A gửi tin
qua REST — request đó có thể rơi vào **bất kỳ** node nào. Nếu node phục vụ request chỉ
phát sự kiện cho session của chính nó, B không bao giờ nhận tin.

Đây là loại lỗi khó thấy nhất: chạy một máy thì hoàn hảo, deploy hai máy thì nửa số
người dùng "không thấy tin nhắn mới" mà log không có một lỗi nào. Hoặc tệ hơn: smoke
test một node vẫn xanh, chỉ người dùng thật gặp.

Ràng buộc: ngân sách 0đ (không Kafka/NATS), đã có Postgres; Redis rẻ và đã nằm trong
kế hoạch hạ tầng (ROADMAP §4.2, ADR-0003) nên dùng lại thay vì thêm dịch vụ mới.

## Quyết định

1. **Bus chỉ chở sự kiện, không quyết định ai nhận.** `EventPublisher` (đã có từ trước)
   là ranh giới; thêm `ClusterPublisher` bọc lấy nó:
   - `publishToChannel/Guild/User/VoiceState` → fan-out **tại chỗ trước**, rồi publish
     một `BusMessage` lên bus.
   - Node nhận message của node khác → gọi lại đúng hàm fan-out **cục bộ**
     (`deliverToChannel`, `deliverToGuild`, …) để lọc theo session của mình.
   - Lọc theo quyền **luôn** do node sở hữu session làm. Không tin node gửi: một node
     bị lỗi không thể làm rò tin của kênh riêng tư sang node khác.
2. **Bỏ qua message của chính mình** theo `origin` (tên node), vì đã fan-out tại chỗ.
   Đây cũng là lý do `GATEWAY_NODE_ID` phải khác nhau giữa các node — trùng tên thì
   node kia *im lặng bỏ qua* toàn bộ sự kiện, không có lỗi nào hiện ra.
3. **Redis pub/sub** chứ không phải Streams: sự kiện gateway là tức thời, không cần
   phát lại (client có `RESUME` + replay riêng). Streams thêm chi phí lưu trữ + phải
   trim cho nhu cầu không tồn tại. Chấp nhận **at-most-once**: đứt bus thì mất sự kiện
   transient (typing, presence) — client tự hồi qua REST + presence snapshot.
4. **Tự viết client RESP tối giản** (`redis-bus.ts`) thay vì thêm `ioredis`: chỉ cần
   `PUBLISH` + `SUBSCRIBE`, kèm tự nối lại và hàng đợi publish lúc chưa nối xong. Gói
   chính thức kéo theo hàng chục phụ thuộc, parser RESP3, cluster/Sentinel — không dùng.
   Giao thức được test bằng Redis **giả** nói RESP thật; hành vi Redis thật thì phải
   thử khi deploy (ghi trong DEPLOY.md).
5. **Presence cũng đi qua bus.** `broadcastPresence` gọi relay → node khác nhận
   `__PRESENCE` (kèm `guildIds` của người đó) và tự lọc người xem theo quan hệ của
   session cục bộ. Node mới vào gửi `__PRESENCE_SYNC`, node khác trả `__PRESENCE_STATE`
   để `READY` của người vào sau vẫn thấy đúng ai đang online.
6. **Lệnh nội bộ dùng `scope: "control"`** (không bao giờ gửi tới client):
   `__REFRESH_FRIENDS` để node khác tính lại danh sách bạn cho session của user vừa kết
   bạn — nếu chỉ tính cục bộ thì bạn mới kết phải reconnect mới thấy nhau online.

## Hệ quả

**Tích cực**
- Tin nhắn, typing, DM, voice state, presence hoạt động đúng khi người dùng nằm trên
  node khác nhau. Có test dựng **hai app thật** dùng chung DB, mỗi app một bus, kiểm
  đúng những đường này (`gateway-cluster.test.ts`).
- Chế độ một node **không đổi gì**: không đặt `REDIS_URL` thì route phát thẳng qua hub,
  không tốn thêm lớp, không thêm phụ thuộc runtime.
- Ranh giới rõ: muốn đổi công nghệ bus (NATS, Postgres LISTEN/NOTIFY) chỉ cần viết
  thêm một `EventBus`.

**Tiêu cực / còn thiếu (ghi nhận trung thực)**
- **Replay buffer + session vẫn nằm trong RAM của node sở hữu** (phần còn lại của
  ADR-0003 chưa làm). Hệ quả: client `RESUME` phải tới **đúng node cũ**, nếu không sẽ
  nhận `INVALID_SESSION` và full resync. Vì vậy load balancer cần **sticky session**
  (hoặc chờ làm replay bằng Redis Streams). Mất event khi resume sai node ≠ mất tin
  nhắn: client identify lại và tải bằng REST — chỉ mất trải nghiệm mượt.
- `selectedStatus` (tự chọn ẩn/idle) vẫn cục bộ, nhưng mọi **thay đổi** đều được relay
  nên node khác luôn biết trạng thái hiện tại; nếu node sở hữu chết, trạng thái đó coi
  như offline cho tới khi họ nối lại.
- Rate limit (`Bucket`) và throttle typing đếm **theo node**, không theo cụm: hai node
  thì giới hạn thực tế ×2. Với beta 0đ, chấp nhận; muốn chặt thì chuyển sang Redis
  (cùng chỗ với ADR-0003).
- `__PRESENCE_STATE` gửi **toàn bộ** danh sách presence node biết: với vài nghìn người
  online, một message có thể vài trăm KB mỗi lần node mới vào. Ở quy mô đó phải lọc
  theo audience trước khi trả lời.
- Pub/sub of Redis **không đảm bảo giao**: node đang bận hoặc vừa restart sẽ lỡ message.
  Sự kiện bền (tin nhắn) vẫn nằm trong Postgres để client tải lại.

## Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| Sửa `publish*` để tự mở kết nối Redis | Trộn I/O vào hub; test một node phải có Redis |
| Redis Streams cho mọi sự kiện | Đúng cho replay, thừa cho fan-out tức thời |
| Sticky session thay cho bus | Vẫn sai: A gửi REST vào node của B là chuyện bình thường |
| Chuyển gateway sang một tiến trình duy nhất | Không scale, và không giải quyết REST rơi vào node khác |
| Postgres LISTEN/NOTIFY | Dùng được, nhưng giới hạn payload 8KB và làm nghẽn connection của DB |

## Khi nào xem lại

- Làm nốt ADR-0003 (session + replay trong Redis) → bỏ yêu cầu sticky LB.
- Fan-out > ~2.000 session/node → đo chi phí publish, cân nhắc gộp theo kênh.
- Nếu presence `__PRESENCE_STATE` phình to → lọc theo audience, hoặc chuyển hẳn
  presence sang Redis key (một nguồn sự thật chung thay vì mỗi node một bản).

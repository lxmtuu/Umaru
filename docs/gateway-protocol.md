# Umaru — Gateway Protocol v1

> Nguồn sự thật về type: [`packages/protocol/src/gateway.ts`](../packages/protocol/src/gateway.ts) (opcode + event map) và [`codec.ts`](../packages/protocol/src/codec.ts) (validate).
> Client tham chiếu: [`packages/sdk/src/gateway.ts`](../packages/sdk/src/gateway.ts).
> Data model: [data-model.md](data-model.md). Quyết định kiến trúc: [ADR-0003](adr/0003-gateway-resume-redis-streams.md).

Trạng thái: **v1 đã được triển khai một phần trong [services/api](../services/api/src/gateway/hub.ts)** (`GatewayVersion = 1`) — HELLO/IDENTIFY/READY, heartbeat, fan-out tin nhắn, resume và lọc quyền đã có test tích hợp với Postgres + WebSocket thật. Thay đổi phá vỡ tương thích phải tăng version và giữ server đọc được version cũ trong ít nhất 1 chu kỳ client.

---

## 1. Nguyên tắc

| Nguyên tắc | Hệ quả bắt buộc |
|---|---|
| **Transport = WebSocket, wire format = JSON text** | 1 frame = 1 object JSON. Binary được đóng khung nhưng **chưa dùng** ở v1 (xem [ADR-0002](adr/0002-json-wire-format.md)). |
| **Mọi dispatch có `s` tăng đơn điệu** | `s` do server gán theo từng session, bắt đầu từ `1`. Client chỉ cần so sánh số. |
| **Session có thể resume** | `session_id + last_seq` được persist phía client; reconnect gửi `RESUME`, server replay phần thiếu. |
| **Thứ tự tin nhắn lấy từ snowflake ID, không từ timestamp** | Hai máy chủ lệch đồng hồ vẫn cho cùng thứ tự; cursor phân trang = `id < before`. |
| **Trạng thái ephemeral không ghi DB** | `TYPING_START`, `PRESENCE_UPDATE`, `speaking` chỉ sống trong Redis/bộ nhớ. |
| **Permission kiểm tra ở server, không ở client** | Gateway lọc theo `VIEW_CHANNEL` **trước khi** gửi; client ẩn kênh chỉ là trang trí. |
| **Client → server frames không được retry ngẫu nhiên** | Chỉ `RESUME` được gửi lại; hành động ghi (gửi tin) đi qua REST kèm `nonce`. |

Giới hạn v1: frame ≤ **4 KiB**, tối đa **1 kết nối/session**, không sharding (single gateway node), không compression.

---

## 2. Vòng đời kết nối

```
client                                     gateway
  │  GET /api/v1/gateway  ─────────────────▶  { url: "wss://…", version: 1 }
  │  WS connect  ────────────────────────▶
  │  ◀───── OP 10 HELLO { heartbeat_interval }
  │  ─────▶ OP 2 IDENTIFY { token, properties }        (bắt buộc trong 5s)
  │  ◀───── OP 0 DISPATCH READY { user, sessionId } s=1
  │  ─────▶ OP 1 HEARTBEAT { d: last_seq }   ↻ mỗi interval
  │  ◀───── OP 11 HEARTBEAT_ACK
  │  ◀───── OP 0 DISPATCH MESSAGE_CREATE  s=2,3,4…
```

1. Client lấy URL qua `GET /api/v1/gateway` (REST, cần Bearer access token) — không hardcode host.
2. Server gửi `HELLO` **ngay** khi socket mở. `heartbeat_interval` v1 = **41.250 ms**.
3. Client gửi `IDENTIFY` (hoặc `RESUME`) với access token JWT. Quá **5 s** không có → đóng `4001`.
   > SDK hiện gửi frame này **ngay khi socket `open`**, không chờ `HELLO` → server phải chấp nhận `IDENTIFY` đến trước khi client kịp đọc `HELLO` (không được đóng vì "sai thứ tự").
4. Server xác thực → mở session → gửi `READY` (là dispatch đầu tiên, `s = 1`).
5. Timers, typing, presence chỉ bắt đầu sau `READY`/`RESUMED`.

### 2.1 Close codes

| Code | Tên | Client làm gì |
|---|---|---|
| `1000` | Normal | Không reconnect (user đóng). |
| `1001` | Going away (server drain) | Reconnect sau backoff — server đang deploy. |
| `1009` | Frame quá lớn | Không reconnect; log lỗi. |
| `4000` | Auth failed / token hết hạn | Refresh access token **rồi** reconnect (v1: chưa tự refresh → đăng xuất mềm). |
| `4001` | Identify timeout | Reconnect có backoff. |
| `4002` | Invalid payload / opcode sai | Không reconnect ngay; đóng để tránh loop. |
| `4003` | Session không tồn tại (resume thất bại, không resumable) | Xoá session, reconnect bằng `IDENTIFY`. |
| `4004` | Rate limited (quá nhiều frame) | Reconnect sau ≥ 5 s. |
| `4008` | Slow consumer (buffer gửi > 1 MiB) | Reconnect; client phải xử lý dispatch nhanh hơn hoặc bỏ transient. |

`INVALID_SESSION (op 9, d=false)` tương đương `4003` nhưng **giữ kết nối** — client tự quyết định identify lại (SDK hiện làm vậy).

---

## 3. Khung dữ liệu

### 3.1 Client → server

| Op | Tên | Payload `d` | Ghi chú |
|---|---|---|---|
| `1` | Heartbeat | `number \| null` = `last_seq` | `null` khi chưa nhận dispatch nào. |
| `2` | Identify | `{ token, properties: { os, browser, device } }` | 1 lần/session, tối đa 1 lần/5 s. |
| `6` | Resume | `{ token, sessionId, seq }` | `seq` = dispatch cuối đã xử lý. |
| `3` | PresenceUpdate | *chưa dùng ở v1* | Presence đi qua REST `PATCH /users/@me/presence` để có rate limit tập trung. |
| `4` | VoiceStateUpdate | *chưa dùng ở v1* | Join/mute đi qua LiveKit token + REST; gateway chỉ **phát** trạng thái. |

Opcode `5` và `8` để trống. Mọi opcode client gửi ngoài `{1,2,6}` → đóng `4002`.

### 3.2 Server → client

| Op | Tên | Payload `d` |
|---|---|---|
| `0` | Dispatch | `{ t: EventName, s: number, d: object }` |
| `1` | Heartbeat (yêu cầu) | `null` — client phải gửi heartbeat **ngay** |
| `7` | Reconnect | `null` — client đóng socket, reconnect (server đang drain) |
| `9` | InvalidSession | `boolean` — `true` = còn resume được, `false` = phải identify lại |
| `10` | Hello | `{ heartbeat_interval: number }` |
| `11` | HeartbeatAck | `null` |

Validate (đã có trong `decodeGatewayPayload`): `op` phải thuộc tập trên; dispatch thiếu `t`/`s`/`d` → `ProtocolError` → client đóng socket. Server **không bao giờ** gửi `op 2/6`; nếu client nhận được thì coi là frame rác.

### 3.3 Heartbeat & phát hiện zombie

- Client gửi `OP 1` mỗi `heartbeat_interval`. Nếu **ack trước chưa tới** mà đã tới lượt kế tiếp → coi kết nối đã chết, đóng socket và reconnect (SDK đã làm). Nội dung `d` là `s` gần nhất client đã nhận (hoặc `null` khi chưa có) — dùng để server biết client tụt lại bao xa.
- Server phải trả `OP 11` trong **cùng interval**; trễ 2 interval liên tiếp → server đóng `4001`.
- Server gửi `OP 1` (không kèm dữ liệu) khi cần heartbeat ngay (ví dụ sau khi resume replay xong) — client phản hồi tức thì.
- **Nhịp đầu có jitter** (SDK đã làm): sau `HELLO`, client chờ ngẫu nhiên `[0, heartbeat_interval)` rồi mới gửi heartbeat đầu, sau đó đều theo interval. Hàng nghìn client nhận `HELLO` cùng lúc mà gửi đúng chu kỳ sẽ dồn thành "thundering herd" mỗi lần server restart; lệch ngẫu nhiên một interval là đủ tản tải. Jitter đặt nhịp đầu **muộn hơn**, không sớm hơn, nên không vượt trần 2 frame dư của bucket HEARTBEAT (§7).

---

## 4. Session & Resume

### 4.1 Trạng thái session (server)

```
gw:session:{session_id} = {
  user_id, gateway_node, shard: 0,
  last_seq, connected_at, status: "online" | "disconnected",
  disconnected_at
}
```

- TTL **5 phút** kể từ lúc ngắt. Quá hạn → `INVALID_SESSION d=false`.
- Một user có thể có nhiều session (web + desktop + mobile). Mọi session của user đều nhận dispatch của user đó; presence tính "online" khi **còn ≥ 1** session `online`.
- Nếu user identify lại khi đã có session `online` cùng `device` → server đóng session cũ bằng `4003` (tránh 2 tab tranh nhau).

### 4.2 Replay log

Mỗi session có một **Redis Stream** `gw:replay:{session_id}`:

- `XADD` mỗi dispatch **được replay** (xem cột *Replay* ở §6), `MAXLEN ~ 2000`, `EXPIRE 300`.
- Khi resume: `XRANGE gw:replay:{session_id} (seq +` … lấy các entry có `s > seq`, gửi tuần tự với **đúng `s` ban đầu**, rồi gửi `RESUMED` (cũng là dispatch, `s` = số mới).
- **Không** replay: `READY`, transient event, sự kiện người dùng không còn quyền xem.
- Nếu `seq` nhỏ hơn entry cũ nhất trong stream (client offline quá lâu) → `INVALID_SESSION d=false`.
- Nếu session thuộc node khác: node hiện tại đọc stream từ Redis (không cần gọi node cũ) — đây là lý do chọn Redis Streams thay vì buffer trong RAM (ADR-0003).
- Client nhận `READY` mới thì **phải xoá cache channel/message cục bộ** và nạp lại qua REST; `RESUMED` thì giữ nguyên cache.

### 4.3 Quy tắc đồng bộ phía client

1. Xử lý dispatch **theo đúng thứ tự `s`**; nếu nhận `s` ≤ `last_seq` đã xử lý thì bỏ qua (bảo vệ khi replay bị lặp).
2. Persist `session_id` + `last_seq` sau khi xử lý xong dispatch (IndexedDB/AsyncStorage), để resume được sau khi tắt app.
3. `MESSAGE_CREATE` đến trùng `id` với tin đã có (optimistic UI) → **thay thế**, không chèn thêm.
4. Mất mạng > 5 phút → chấp nhận `READY` mới và full resync.

---

## 5. Phát sự kiện (fan-out)

```
REST handler ──(1 transaction)──▶ Postgres
      │
      └─(sau commit)─▶ NATS subject chan:{channel_id} / guild:{guild_id}
                                  │
                    gateway node (subscribe theo shard)
                                  │  lọc quyền (cache 30s) + gán s
                                  ▼
                    XADD gw:replay:{session}  +  WS send
```

Quy tắc:

1. **Chỉ publish sau khi transaction commit** — tránh client thấy tin chưa tồn tại.
2. Gateway **không** đọc DB cho mỗi event; nó dùng cache quyền + snapshot member. Cache invalidation qua subject `perm:{user_id}`.
3. **Fan-out theo kênh**: subscriber của node giữ map `channel_id → sessions`; event tới chỉ đi tới session có `VIEW_CHANNEL`.
4. **Gán `s` tuần tự trong 1 node/session** bằng lock nhẹ theo session (node sở hữu session là node duy nhất ghi stream). Node khác không được ghi stream của session nó không sở hữu.
5. **Mất quyền giữa phiên**: khi permission thay đổi, server gửi `CHANNEL_DELETE` cho các session không còn `VIEW_CHANNEL` (giống hành vi Discord) — client không cần logic riêng.
6. **Backpressure**: nếu buffer gửi > 1 MiB, bỏ transient frame trước; vẫn tắc → đóng `4008`.
7. **At-least-once, không exactly-once**: resume replay có thể lặp; client dedupe theo `s` và theo `id` của entity.

### 5.1 Typing

- Client gửi `POST /channels/{id}/typing`, throttle **1 lần/8 s/kênh** (server trả `429` nếu vượt).
- Server phát `TYPING_START { channelId, userId, timestamp }` tới các session có `VIEW_CHANNEL`, trừ chính tác giả.
- **Không** persist, **không** replay, không ghi audit.

### 5.2 Presence

- Nguồn: session online/offline (Redis key `presence:{user_id}:{session_id}` TTL 60 s, refresh bằng heartbeat).
- `PRESENCE_UPDATE { userId, status }` phát tới: member chung guild + bạn bè đã accept. Coalesce **1 s/user**.
- Trạng thái manual (`idle`/`dnd`) lưu trong `users` — presence hiển thị = `manual` nếu manual ≠ `online`, ngược lại lấy từ session.
- Không replay. Client lấy snapshot presence qua `READY` (kèm guild) và REST khi mở profile.

### 5.3 Voice state

**Đã hiện thực (G2 — phần state, chưa có âm thanh).** Nguồn sự thật là bảng
`voice_states` trong Postgres (mỗi người **một** phòng thoại mỗi server, PK
`(user_id, guild_id)`); REST `PUT/DELETE /channels/{id}/voice` và
`PATCH /guilds/{id}/voice-state` là nơi duy nhất đổi trạng thái.

- `VOICE_STATE_UPDATE` là event **bền** (vào replay log, resume được) cho cả
  join/leave/`selfMute`/`selfDeaf`.
- Payload dùng **cùng shape** với `VoiceState` trong `READY` để client chỉ cần một
  mapper: `{ guildId, channelId, userId, selfMute, selfDeaf, joinedAt }`.
  `channelId: null` = người đó đã rời phòng.
- Người nhận: session có `VIEW_CHANNEL` của kênh + **chính người liên quan** (họ
  phải biết mình đã bị đưa ra khỏi phòng khi mất quyền xem).
- Snapshot đầy đủ nằm trong `READY.voiceStates` (lọc theo `visibleChannels`).
- Mất quyền xem kênh thoại → bị đưa ra khỏi phòng ngay (`dropVoiceStates`), không
  cần client tự kiểm.
- Hết mọi session gateway của user (đóng app, resume quá TTL) → rời phòng; dòng
  "mồ côi" (join qua REST rồi biến mất) bị `sweep` dọn sau 30 phút.
- **Chưa có `speaking`**: chỉ có nghĩa khi có audio thật, tần suất cao nên sẽ đi
  qua data channel của SFU khi cắm LiveKit, không qua gateway (§9).

### 5.4 Friends & quyền riêng tư DM

Quan hệ bạn bè dùng lại bảng `relationships` (migration 0001) theo quy ước có
hướng: bạn bè = **hai dòng** `friend`, lời mời = `pending_out` (người gửi) +
`pending_in` (người nhận), chặn = một dòng `blocked`. Không có bảng mới.

- `FRIEND_REQUEST_CREATE` → người **nhận** lời mời; payload mang **người gửi**
  (`FriendRequestSummary`). Response của `POST /users/@me/friends` thì mang
  **người được mời** (khớp tab "đã gửi" của người gọi).
- `FRIEND_ADD` → **cả hai** phía khi thành bạn (đồng ý, hoặc hai người gửi lời
  mời chéo nhau — lần gửi thứ hai là đồng ý luôn).
- `FRIEND_REMOVE` → **cả hai** phía khi huỷ kết bạn, từ chối/huỷ lời mời, hoặc
  khi một bên **chặn** bên kia (chặn cắt luôn quan hệ bạn bè).
- `USER_SETTINGS_UPDATE` → chỉ các session của chính mình (tab/thiết bị khác).

Không cần replay: danh sách đầy đủ lấy bằng `GET /users/@me/friends`, event chỉ
để cập nhật tại chỗ; client chưa mở panel thì bỏ qua event (`friends === null`)
và tải lại khi mở.

Cổng quyền riêng tư DM nằm ở server (`POST /users/@me/channels`): `dm_privacy =
'friends'` chỉ áp cho việc **mở cuộc mới**, DM đã tồn tại vẫn mở và nhắn được
(không cắt ngang cuộc đang có). Cuộc mở mới khi đó thành **yêu cầu nhắn tin**
(bảng `dm_requests`): với người nhận, kênh không nằm trong `READY.dms` và không
vào `visibleChannels` → không nhận `MESSAGE_CREATE`; họ thấy nó trong
`GET /users/@me/message-requests` (người gửi + preview) và tự đồng ý/từ chối.
Người gửi thấy kênh bình thường kèm `requestPending: true`. Block vẫn thắng
(403 vì chặn). Mặc định `'everyone'` để không đổi hành vi sau deploy.

---

## 6. Danh mục sự kiện v1

`Replay` = có vào stream resume. `Scope` = đối tượng nhận.

| Event | Scope | Replay | Payload |
|---|---|---|---|
| `READY` | session | ✗ | `{ user, sessionId, guilds: [{ guild, channels, roles, members }], dms: [{ channel, recipient }], readStates: [{ channelId, lastReadMessageId, unread, mentions }], channelPermissions: { [channelId]: "<bitfield thập phân>" } }` — `roles` sắp theo `position` giảm dần; mỗi member có `roleIds` (không gồm `@everyone`) |
| `RESUMED` | session | ✗ | `{}` |
| `PERMISSIONS_UPDATE` | session | ✓ | `{ channelPermissions: { [channelId]: "<bitfield thập phân>" } }` — quyền hiệu dụng của **chính user đó** vừa đổi (được gán/thu role, đổi overwrite, kênh mới, vừa vào server); gửi cả map nên client chi việc thay thế |
| `MESSAGE_CREATE` | channel | ✓ | `Message` đầy đủ (author snapshot, attachments, reply refs) |
| `MESSAGE_UPDATE` | channel | ✓ | `{ id, channelId, content, editedAt }` — chỉ field đổi |
| `MESSAGE_DELETE` | channel | ✓ | `{ id, channelId }` — client tự xoá khỏi mọi view |
| `TYPING_START` | channel | ✗ | `{ channelId, userId, timestamp }` |
| `PRESENCE_UPDATE` | guild + friends | ✗ | `{ userId, status }` |
| `CHANNEL_CREATE` / `CHANNEL_UPDATE` | guild | ✓ | `Channel` — `CHANNEL_CREATE` cũng được gửi khi user **vừa được cấp quyền xem** một kênh (overwrite mới, vừa vào server) để sidebar hiện ra ngay. `CHANNEL_UPDATE` cũng là event **đổi thứ tự**: `PATCH /channels/:id { position }` renumber cả nhóm rồi gửi `CHANNEL_UPDATE` cho từng kênh đổi `position` (kể cả kênh không phải kênh vừa kéo), theo đúng thứ tự mới nên client chỉ việc sort lại |
| `CHANNEL_DELETE` | guild | ✓ | `{ id, guildId }` — cũng dùng khi **mất quyền xem** |
| `DM_CHANNEL_CREATE` | user | ✗ | `DmChannelSummary` — có người mở DM/group DM với mình. `channel.type` là `"dm"` hoặc `"group_dm"`; `recipients` là **mọi người khác trong cuộc** (góc nhìn của người nhận), `recipient` chỉ có ở DM 1-1, `ownerId`/`name` chỉ có ở group DM |
| `DM_CHANNEL_UPDATE` | user | ✗ | `DmChannelSummary` — tên nhóm hoặc danh sách thành viên vừa đổi; gửi **toàn bộ** summary để client thay tại chỗ, không tự ghép diff |
| `DM_CHANNEL_DELETE` | user | ✗ | `{ channelId }` — bị mời ra khỏi nhóm (hoặc nhóm bị xoá). Trên đường `CHANNEL_DELETE` thì `guildId = null`, client hiểu là bỏ DM khỏi sidebar |
| `GUILD_CREATE` | session | ✗ | `{ guild, channels, roles, members }` — snapshot đầu tiên của guild mới/chưa cache |
| `GUILD_MEMBER_ADD` | guild | ✓ | `{ guildId, member: { userId, username, displayName, avatarUrl, roleIds } }` — có người vào server qua invite |
| `GUILD_MEMBER_UPDATE` | guild | ✓ | `{ guildId, member: { userId, username, displayName, avatarUrl, roleIds } }` — role của thành viên vừa được gán/thu; gửi **summary đầy đủ** để client chỉ việc thay thế, không tự ghép diff |
| `MESSAGE_PIN_UPDATE` | channel | ✗ | `{ id, channelId, pinned }` — ghim/bỏ ghim. Tách khỏi `MESSAGE_UPDATE` vì sửa nội dung (quyền tác giả) và ghim (`MANAGE_MESSAGES`) là hai thao tác khác nhau; client chỉ cập nhật đúng trường `pinned` |
| `USER_UPDATE` | guild + session của chính user | ✗ | `{ user: { id, username, displayName, avatarUrl } }` — hồ sơ công khai đổi (hiện tại: avatar). Gửi tới **mọi guild mà user là thành viên** và tới các session của chính họ (tab/thiết bị khác). Không kèm `status`: presence vẫn đi qua `PRESENCE_UPDATE` để hai nguồn không ghi đè nhau |
| `ROLE_CREATE` / `ROLE_UPDATE` | guild | ✓ | `{ guildId, role: Role }` — role vừa tạo/sửa (kèm `isEveryone`); quyền **hiệu dụng** của từng user vẫn do `PERMISSIONS_UPDATE` đẩy riêng. Kéo-thả đổi cấp (`PATCH /guilds/:id/roles/:roleId { position }`, `position` = thứ hạng **trên xuống**) renumber cả dãy nên phát `ROLE_UPDATE` cho **đúng những role đổi `position`**, theo thứ tự mới — client chỉ cần sort lại; kéo vào đúng chỗ cũ không phát gì |
| `ROLE_DELETE` | guild | ✓ | `{ guildId, roleId }` — `member_roles` cascade theo FK nên client tự coi như role đã gán cho ai cũng biến mất |
| `FRIEND_REQUEST_CREATE` | user (người nhận) | ✗ | `FriendRequestSummary` = `{ user: { id, username, displayName, avatarUrl }, createdAt }` — mang **người gửi** lời mời |
| `FRIEND_ADD` | user (cả hai phía) | ✗ | `FriendSummary` = `{ user, since }` — thành bạn (đồng ý, hoặc hai lời mời chéo nhau) |
| `FRIEND_REMOVE` | user (cả hai phía) | ✗ | `{ userId }` — huỷ kết bạn, từ chối/huỷ lời mời, hoặc do một bên **chặn** (chặn cắt luôn quan hệ bạn bè) |
| `USER_SETTINGS_UPDATE` | session của chính user | ✗ | `UserSettings` = `{ dmPrivacy: "everyone" \| "friends" }` — cài đặt của chính mình vừa đổi (tab/thiết bị khác cập nhật theo) |
| `MESSAGE_REQUEST_CREATE` | user (người nhận) | ✗ | `MessageRequestSummary` = `{ channelId, sender, createdAt, preview, messageCount }` — người lạ vừa mở DM với mình trong khi mình đặt "chỉ bạn bè". Không kèm `DM_CHANNEL_CREATE` (họ chưa được thấy kênh) |
| `MESSAGE_REQUEST_REMOVE` | user (người nhận) | ✗ | `{ channelId }` — yêu cầu đã xử lý xong: đồng ý, từ chối, kết bạn với người gửi, hoặc bị chặn |
| `VOICE_STATE_UPDATE` | channel + chính người liên quan | ✓ (bền) | `{ guildId, channelId \| null, userId, selfMute, selfDeaf, joinedAt }` — `channelId: null` = rời phòng; cùng shape với `VoiceState` (xem §5.3). Chưa có `speaking` (đi qua SFU khi có audio) |

Quy ước payload: `camelCase` khớp type trong `@umaru/protocol`; snowflake luôn là **string**; thời gian là ISO-8601 UTC (trừ `TYPING_START.timestamp` là epoch ms).

### 6.1 Sự kiện dự kiến thêm (không phải v1)

`GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_MEMBER_REMOVE`, `MESSAGE_REACTION_ADD/REMOVE`, `CHANNEL_PINS_UPDATE`, `READ_STATE_UPDATE`, `INVITE_CREATE/DELETE`, `VOICE_SPEAKING` (tách khỏi `VOICE_STATE_UPDATE` nếu tần suất gây nhiễu). Thêm event = thêm key vào `GatewayEventMap`, **không** tăng version (client bỏ qua event lạ).

---

## 7. Rate limit & giới hạn

| Hành động | Giới hạn | Vượt |
|---|---|---|
| `IDENTIFY` / `RESUME` | 1 lần/5 s/socket | đóng `4004` |
| `HEARTBEAT` | 1 lần/interval (dư 2 frame) | bỏ qua và log |
| Frame client → server | 120 frame/phút/session | đóng `4004` |
| Frame size | 4 KiB | đóng `1009` |
| `POST /channels/{id}/typing` | 1/8 s/user/channel | `429` + `retry_after` |
| `POST /channels/{id}/messages` | 5/5 s/user/channel, 30/phút/kênh | `429` (không phát dispatch) |
| `PUT/DELETE /channels/{id}/voice`, `PATCH /guilds/{id}/voice-state` | 10 lần/10 s/user | `429` + `retry_after` |
| Kết nối/user | 5 session | session cũ nhất bị đóng `4003` |

Bảng trên **đã được hiện thực** (`services/api/src/rateLimit.ts` + `gateway/hub.ts` + `messages/routes.ts`), có test riêng ở `services/api/test/rate-limit.test.ts` và `services/api/test/rate-limit-gateway.test.ts`.

Cách đếm:

- **Token bucket** chứ không phải "đếm trong cửa sổ cố định": cửa sổ cố định cho phép bắn 2× giới hạn ở ranh giới hai cửa sổ, bucket thì làm mượt theo thời gian thật. Body `429` luôn là `{ error: { code: "RATE_LIMITED", message }, retry_after }` với `retry_after` tính bằng **giây** (làm tròn lên, tối thiểu 1) để client hiện được "thử lại sau N giây".
- **Frame/phút tính cả frame rác** (sai JSON, opcode lạ): đếm trước khi parse, nếu không kẻ tấn công chỉ cần gửi rác để ép server parse liên tục.
- **HEARTBEAT** có bucket riêng (1 + 2 dư mỗi interval) vì client gửi dày thường do jitter — đóng kết nối sẽ tạo vòng reconnect vô ích. Vượt thì **im lặng bỏ qua**, không đóng; chỉ log lần đầu của mỗi chuỗi dư (log từng frame thì log lại thành kênh tấn công).
- **`IDENTIFY` và `RESUME` đếm riêng**, mỗi loại 1 lần/5 s/socket. Gộp chung một bộ đếm sẽ đóng `4004` oan cho luồng hợp lệ `RESUME` → `INVALID_SESSION` → `IDENTIFY` ngay trên cùng kết nối (§2.1) — đúng lỗi một test có sẵn đã bắt được.
- **Tin nhắn** kiểm *trước* khi đọc multipart/ghi đĩa, nên bị chặn thì không có tệp mồ côi, không ghi DB và **không phát `MESSAGE_CREATE`**. Hai bucket độc lập: người bình thường không chạm trần kênh, còn kênh bị nhiều tài khoản spam thì trần kênh (30/phút) mới là thứ cứu server.
- **Trần session/user** đóng session **cũ nhất còn sống** (không phải session vừa mở) trước khi tạo session mới — đúng ca "mất mạng rồi mở lại nhiều lần".

Tinh chỉnh bằng biến môi trường: `RATE_LIMITS=off` (mặc định bật), `RATE_LIMIT_MESSAGES_PER_USER` (5), `RATE_LIMIT_MESSAGES_PER_CHANNEL` (30), `RATE_LIMIT_GATEWAY_FRAMES_PER_MINUTE` (120), `RATE_LIMIT_SESSIONS_PER_USER` (5). Test dùng chung đặt các trần này rất cao để không phải chờ, test riêng của rate limit hạ thấp để kiểm hành vi chặn.

> **Đa node**: bộ đếm nằm trong bộ nhớ từng process (§9), nên với N node thì giới hạn thực tế là N × cấu hình. Muốn đúng tuyệt đối phải chuyển sang Redis (`INCR` + `EXPIRE`) cùng lúc với replay log.

---

## 8. Nghiệm thu G1 (test phải có)

1. **Golden frame**: `encodeGatewayPayload`/`decodeGatewayPayload` round-trip cho mọi opcode; frame thiếu `t`/`s`/`d` bị từ chối (`ProtocolError`).
2. **Resume**: ngắt socket sau `s=5`, gửi `RESUME { seq: 5 }` → nhận đúng các dispatch `6,7,…`, rồi `RESUMED`; không trùng, không thiếu. (Test SDK fake socket đã có; cần thêm bản server thật.)
3. **Replay hết hạn**: session > 5 phút → `INVALID_SESSION d=false`, client identify lại.
4. **Ordering**: 2 client nhận `MESSAGE_CREATE` cùng thứ tự `id` trong cùng kênh.
5. **Permission leak**: user bị `deny VIEW_CHANNEL` không nhận **bất kỳ** frame nào của kênh đó (kể cả typing, message, và không có trong `READY`).
6. **Zombie**: chặn `HEARTBEAT_ACK` → client tự đóng & reconnect trong ≤ 2 interval.
7. **Backpressure**: client chậm (không đọc) → transient bị bỏ trước, cuối cùng đóng `4008`, không OOM node.
8. **Multi-session**: cùng user 3 session nhận cùng event; đóng 1 session → presence vẫn online.

---

## 9. Việc còn thiếu so với spec này (ghi nhận trung thực)

- **Replay log đang nằm trong bộ nhớ một process** (`MAX_REPLAY_EVENTS`, TTL session), chưa phải Redis Streams như §4.2. Resume qua nhiều node và qua restart server chưa hoạt động — phải thay `GatewayHub` phần replay khi lên đa node (ADR-0003).
- **Rate limit đã có** cho `IDENTIFY`/`RESUME`/frame/session và cho `POST /messages` (spec §7), nhưng bộ đếm **nằm trong bộ nhớ từng process** — đa node thì giới hạn thực tế nhân lên theo số node, và restart server là mất trạng thái (chấp nhận được: cửa sổ ngắn). Chuyển sang Redis khi lên đa node.
- Đóng `1009` (frame quá lớn) hiện **vẫn để client reconnect** theo backoff chung; spec §2.1 nói "không reconnect". Hành vi hiện tại an toàn hơn (client gửi frame lớn thường do bug, reconnect một lần rồi bỏ), nhưng chưa khớp câu chữ.
- `READY` đã có `guilds[]` (`{ guild, channels, roles, members }` — member kèm `roleIds`), `dms[]` (`DmChannelSummary`: `channel`, `recipients`, `recipient` (chỉ DM 1-1, group DM = `null`), `ownerId`/`name` cho group DM), `readStates[]` (`{ channelId, lastReadMessageId, unread, mentions }`), `channelPermissions` (channelId → bitfield của **chính user nhận**, server tính bằng `resolvePermissions`; gồm cả DM) và `voiceStates[]` (chỉ kênh user xem được).
- **Voice mới có lớp state, chưa có âm thanh**: `PUT/DELETE /channels/{id}/voice` + `PATCH /guilds/{id}/voice-state`, `VOICE_STATE_UPDATE` / `READY.voiceStates`, quyền `CONNECT` (vào phòng) và `VIEW_CHANNEL` (thấy ai trong phòng). Chưa có SFU, chưa có `speaking`, chưa có token phòng — cắm LiveKit Cloud là bước tiếp theo của G2 và **không kiểm chứng được trong sandbox** này.
- Thay đổi role của **thành viên** phát `GUILD_MEMBER_UPDATE` cho cả server; THAY ĐỔI role (tạo/sửa/xoá) phát `ROLE_CREATE/UPDATE/DELETE`. `ROLE_DELETE` không tự phát `GUILD_MEMBER_UPDATE` cho từng người — client dựa vào `member_roles` cascade và bỏ `roleId` khỏi chip của mọi member.
- `channelPermissions` được đẩy lại qua `PERMISSIONS_UPDATE` mỗi khi `refreshUserVisibility`/`refreshGuildVisibility` chạy: tạo/sửa/xoá kênh, tạo guild, nhận invite, các thao tác role (`PATCH`/`DELETE` role, gán/thu role) và **mọi thay đổi overwrite theo kênh**. Cùng lúc đó gateway gửi `CHANNEL_DELETE` cho kênh vừa mất quyền xem và `CHANNEL_CREATE` cho kênh vừa được xem — client không cần reconnect. Client luôn coi đây là gợi ý UI: quyền thật vẫn do server kiểm tra ở REST/gateway.
- Overwrite đặt trên **category** được kế thừa xuống channel con (category áp trước, kênh đè sau) — danh sách `CHANNEL_*` phản ánh đúng những gì server đã tính sẵn, client không tự suy luận. `PATCH /channels/:id` đổi `parentId` cũng phát `CHANNEL_UPDATE` + `PERMISSIONS_UPDATE` vì quyền hiệu dụng có thể đổi theo category mới; chỉ đổi `position` (kéo-thả) thì **không** gọi `refreshGuildVisibility` — chỉ phát `CHANNEL_UPDATE` cho các kênh đổi vị trí, vì tập kênh hiển thị không đổi.
- Chỉ số `position` trong `Channel` là thứ tự **trong nhóm kênh cùng `parentId`**. Client gửi lại chính chỉ số này khi thả (`PATCH { parentId?, position }`), không gửi cả thứ tự; server kẹp chỉ số về 0..n nên client không cần đồng bộ danh sách đầy đủ trước khi thả.
- **Badge chưa đọc không phát event qua gateway**: client tự tăng đếm khi nhận `MESSAGE_CREATE` (bỏ qua tin của chính mình) và gọi `POST /channels/:id/read` khi mở kênh. Đổi trạng thái đã đọc từ thiết bị khác chưa đồng bộ realtime — mở lại app (READY) mới cập nhật; event `READ_STATE_UPDATE` để P1.
- Khi user tạo guild hoặc join invite, server đồng bộ lại quyền hiển thị cho session đang mở (`refreshUserVisibility`) vì READY đã chạy trước đó.
- **DM** là `Channel` có `type: "dm"`, `guildId: null`; quyền xem suy ra từ bảng `channel_members` (không qua role/overwrite) và được nạp vào `visibleChannels` khi READY, khi tạo DM (`grantChannelAccess`) và khi resume. `DM_CHANNEL_CREATE` không vào replay log (transient) — client lấy lại danh sách qua `GET /users/@me/channels` nếu lỡ.
- **Client đã dedupe theo `s`**: `READY` (session mới) đặt lại bộ đếm, mọi dispatch khác phải có `s` lớn hơn `s` đã nhận, frame trùng/`s` cũ bị bỏ. Trước đây server replay đã lọc `s > seq` nên chưa lỗi, nhưng chồng lấn khi replay là chuyện có thể xảy ra và hậu quả thấy được (tin nhắn lặp).
- **Client đã tự refresh token khi gặp `4000`**: SDK nhận hook `onAuthFailure` (web nối vào `refreshSession()` dùng chung với REST), refresh xong resume lại session cũ; refresh hỏng hoặc không có hook → `closed` (đăng xuất mềm) chứ không thử lại vô hạn (giới hạn 2 lần liên tiếp). Đã xử lý cả `4003` (xoá session để IDENTIFY lại) và `4004` (chờ ≥ 5 s).
- Chưa có sharding (`shard` luôn 0).
- Chưa có nén frame; `OP 3`/`OP 4` (client → server) để trống có chủ đích ở v1.
- Presence hiện là in-memory theo session của process; chưa đọc/ghi Redis.

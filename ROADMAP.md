# Umaru — Phân tích chức năng Discord & Lộ trình phát triển

> Tài liệu định hướng sản phẩm + kỹ thuật. Cập nhật: 10/2026.
> Mục tiêu: xây dựng ứng dụng chat/voice cộng đồng ("Discord-like") chạy trên **Web, Desktop, Mobile**.

---

## 0. Tóm tắt điều hành

Discord **không phải một ứng dụng**, mà là 5 sản phẩm ghép lại:

| # | Sản phẩm | Tầng kỹ thuật khó nhất |
|---|----------|------------------------|
| 1 | Nền tảng nhắn tin nhóm (server/channel/message) | Realtime gateway, permission model |
| 2 | Nền tảng thoại/video (voice channels, Go Live) | SFU WebRTC, multi-region, bitrate/codec |
| 3 | Mạng xã hội (Friends, DM, presence) | Social graph, notification fan-out |
| 4 | Nền tảng nhà phát triển (bots, slash commands, App Directory, Activities SDK) | API stability, OAuth2, sandbox |
| 5 | Nền tảng thương mại (Nitro, Server Boosts, Monetization API) | Thanh toán, entitlement, pricing |

**Khuyến nghị:** không clone 100% từ đầu. Xây dựng theo trục cốt lõi trước (text chat → voice → social → platform → monetization), mỗi giai đoạn đều có thể phát hành công khai được.

### 0.1 Quyết định chiến lược đã chốt (10/2026)

| Hạng mục | Quyết định | Hệ quả lên lộ trình |
|----------|------------|----------------------|
| **Định vị sản phẩm** | **"Workspace cho Dev & Nhóm học tích hợp AI"** — song song VN + Quốc tế, dễ demo portfolio | Giữ nguyên lõi Discord; **thêm track AI** (§3, Track song song); tính năng game (overlay, Clips, rich presence) neo P3; ưu tiên render code block, chia sẻ file, threads cho nhóm học |
| **Thoại** | **LiveKit Cloud** (SDK có sẵn, multi-region, không cần tự viết SFU) | G2 không còn bước chọn/self-host SFU; không cần tuyển voice-engineer chuyên sâu, chỉ cần người tích hợp WebRTC client |
| **Ngân sách** | **0đ/tháng** (free tier, region Singapore) | Stack bị khóa vào free tier (§4.4); mọi phase có "ngưỡng nâng cấp"; AI dùng credit miễn phí/BYOK |
| **Thị trường** | Song song **VN + Quốc tế** | i18n EN chính + toggle VI **làm từ G1**; voice region Singapore; **Stripe (VNĐ + USD)** cho phase monetization; **Terms/Privacy song ngữ** (GDPR + Luật VN) trước bản public đầu tiên |

---

## 1. Bản đồ chức năng Discord (phân tích đầy đủ)

Chú thích cột **ƯU TIÊN (Umaru)**:

- **P0** — lõi MVP, không có thì không phải "Discord-like"
- **P1** — cần cho bản public đầu tiên
- **P2** — bản trưởng thành (v6+)
- **P3** — để sau / cân nhắc lại (độ khó rất cao hoặc giá trị thấp khi mới ra)

### 1.1 Tài khoản & Hồ sơ (Identity)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Đăng ký/đăng nhập email + xác thực email | Credential cơ bản, gửi mail xác minh — ✅ đã có (SMTP qua `SMTP_URL`, dev ghi mail ra log) | P0 |
| Đăng nhập OAuth2 (Google, Apple, GitHub...) | Giảm ma sát đăng ký | P1 |
| Username + Display name (hệ thống mới, không còn `#0001`) | Discord đã bỏ discriminator | P0 |
| Avatar, banner, bio, pronouns | Hồ sơ hiển thị — ✅ đã có **avatar** (tải/gỡ ảnh ≤5MB, magic bytes, `USER_UPDATE` realtime); banner/bio/pronouns chưa | P1 |
| Trạng thái: Online / Idle / DND / Invisible + custom status | Presence là "linh hồn" Discord | P0 (online/offline), P1 (các loại còn lại) |
| Rich Presence (đang chơi game/đang nghe nhạc) | Cần SDK tích hợp game bên thứ ba | P3 |
| Xác thực 2 yếu tố (TOTP) | Bảo mật | P1 |
| Thông tin thiết bị đã đăng nhập, đăng xuất từ xa | Bảo mật | P2 |
| Cài đặt client: giao diện, ngôn ngữ, thông báo, phím tắt, quyền riêng tư | Settings center | P1 (từng phần) |
| Hồ sơ theo từng server (profile per-guild) | 2025 Discord có profile card nhiều hoạt động đồng thời | P3 |

### 1.2 Bạn bè & Tin nhắn riêng (Social graph)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Thêm bạn bằng username (không phải mã) | Mô hình add-friend hiện đại | P1 |
| Danh sách bạn, lời mời chờ, đã chặn | Core social | P1 |
| DM 1-1 | Bắt buộc | P0 — ✅ đã có (kèm chặn/bỏ chặn) |
| Group DM (tới 10 người, không thuộc server nào) | Rất hay dùng — ✅ đã có (thêm/mời ra, đổi tên, rời nhóm, realtime) | P1 |
| Cuộc gọi thoại/video trong DM | Dùng chung hạ tầng voice | P1 (sau khi có voice channels) |
| "Bạn chung", "Server chung" | Mutuals | P2 |
| Tin nhắn yêu cầu (Message Requests) từ người lạ | An toàn cho người dùng nữ/bị làm phiền | P1 |
| DM folders, ghim tin nhắn DM | Organization | P3 |

### 1.3 Server (Guild)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Tạo server, chọn tên/avatar | Core | P0 |
| **Hệ thống Roles & Permissions phân cấp** | Permission bitmask + overwrites theo channel/category — *đây là trái tim Discord* | P0 (permission cơ bản), P1 (overwrites chi tiết) |
| Category (nhóm channel kéo thả) | Cấu trúc server | P0 |
| Cài đặt server: tổng quan, emoji, sticker, integrations, webhook, ban, audit log | Admin center | P1 (audit log P1, phần còn lại P2) |
| Mời server (link mời, mã mời, giới hạn lượt dùng, mời tạm) | Core growth | P0 (link mời đơn giản), P1 (tùy chọn nâng cao) |
| Onboarding server (câu hỏi gán role/channel khi vào) | Server community | P2 |
| Rules screening (tôi đồng ý nội quy trước khi tham gia) | 16 quy tắc tối đa | P2 |
| Server Boost (hệ thống boost cấp 2/7/14 → perk) | Levers kinh doanh | P3 (sau monetization) |
| Server Tags, Enhanced Role Styles (perk 2025, riêng 3 boosts) | Perk mới của Discord | P3 |
| Template server | Tạo nhanh từ mẫu | P2 |
| Discovery server (danh mục tìm server công khai) | Discord đang thử nghiệm lại "Discover tab" | P2–P3 |
| Giới hạn thành viên (Discord 2025: 25 triệu/server mặc định) | Cực đoan — target của mình: 10k–100k là đủ | P3 |

### 1.4 Kênh & Tin nhắn (Messaging)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Kênh văn bản, phân loại theo category | Core | P0 |
| Tin nhắn realtime (gửi/nhận < 200ms, có "đang gõ...") | Core | P0 |
| Markdown: **in đậm**, `code`, ```block```, quote, link tự động | Core UX | P0 |
| Mention @user, @role, @everyone, reply, edit, delete | Core | P0 (mention user + edit/delete), P1 (reply, @role) |
| Reaction emoji | Core | P1 |
| Emoji tùy chỉnh theo server + sticker | P1 (emoji), P3 (sticker/GIF picker) |
| Ghim tin nhắn (pin limit 250 trên Discord 2025) | P1 |
| Tải file lên (10MB free / 50MB Nitro Basic / 1GB Nitro; preview ảnh, AV1 2025) | P0 (→10MB), P1 (giới hạn theo gói) |
| Embed link preview (OG metadata) | P1 |
| **Threads** (tin nhắn thành luồng, tự archive) | P1 |
| **Polls** (10 đáp án, chọn nhiều, tối đa 1 tuần, không ẩn danh) | P2 |
| **Voice message** (tối đa 20 phút, chỉ ghi trên mobile) | P2 |
| **Forum channel** (channel kiểu diễn đàn, có tag, layout list/gallery) | P2 |
| **Announcement channel** (kênh phát thanh, follow/crosspost, 10 lần/giờ) | P2 |
| Tìm kiếm tin nhắn (toàn server, lọc theo người/loại file) | ✅ P1 cơ bản đã có (keyword trong kênh/toàn server, cursor); P2 (lọc theo người/loại file, ngữ pháp tìm kiếm phong phú) |
| Slowmode, quyền gửi tin theo role | P1 |
| Nháp tin nhắn (drafts), gửi theo lịch | P2 / P3 |
| Kho tin đã gửi (Library: ảnh, file, link) | P2 |
| Đánh dấu chưa đọc (mark unread), tab Mentions, badge | P0 (badge), P1 (mentions inbox) |
| Ghim tin nhắn (pin) | ✅ đã có: ghim/bỏ ghim (tối đa 50/kênh), panel tin ghim, `MESSAGE_PIN_UPDATE` realtime | P1 |
| Giới hạn độ dài: 2000 ký tự (free) / 4000 (Nitro) | P1 |

### 1.5 Thoại & Video (Voice/Video) — *khó nhất*

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Voice channel "luôn mở" (vào/ra tự do, có text chat kèm) | *Đặc trưng số 1 của Discord so với Zoom/Slack* | **P0 của phase voice** |
| Chất lượng: Opus, bitrate theo tier (128/256/384 Kbps theo boost level; free 64 Kbps) | Codec + adaptive bitrate | P0 (64–128kbps), P2 (tier) |
| Push-to-talk / voice activity, cảm biến độ nhạy | Input pipeline | P0 |
| **Noise suppression (Krisp), echo cancellation, AGC** | WebRTC processing stack (dùng thư viện: Krisp SDK / RNNoise / libfilter) | P0/P1 |
| Go Live / share màn hình: 720p30 free → 4K60 Nitro; tối đa 50 người stream + 50 người xem | SFU + simulcast/SVC + transcoding | P1 (720p), P3 (4K) |
| Video call: camera trong DM & voice channel, tối đa 25 người | P1 |
| Stage channel (diễn giả/ khán giả, giơ tay, tối đa 10.000 người nghe) | P2 |
| Soundboard (âm thanh server, slot theo boost) | P2 |
| Clips (quay lại stream 30s/60s/2p — hiện chỉ Windows, Nitro) | P3 |
| Chọn vùng voice (multi-region) | P2 |
| Tùy chọn video: nền ảo, portrait mode | P2–P3 |
| Tích hợp Xbox/PlayStation | P3 (bỏ qua, cần đối tác) |
| Activities (web app chạy trong iframe ở voice: game, xem phim chung) — dùng Embedded App SDK | P3 |

### 1.6 Thông báo (Notifications)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Notification per-channel, per-server, mute | Core | P0 (mute + badge), P1 (tinh chỉnh) |
| Push notification mobile (FCM/APNs) | Bắt buộc trên mobile | P0 (mobile) |
| Web push cho browser | P1 |
| Mentions-only mode, @everyone theo permission | P1 |
| Email notification khi offline | P2 |
| Nhắc sự kiện (scheduled events, RSVP) | P2 |

### 1.7 An toàn, kiểm duyệt (Trust & Safety) — *chi phí âm thầm rất lớn*

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Block, report (gửi tới team Umaru + report về server admin) | P0 — ✅ đã có: block + report, hàng đợi `/admin/reports` cho người vận hành (env `ADMIN_USERNAMES`/`ADMIN_USER_IDS`). Còn thiếu: gửi mail báo cho team, report riêng cho admin server (hiện chỉ có hàng đợi nền tảng) |
| Timeout (60 giây → 1 tuần), kick, ban + lý do ghi audit log | P1 |
| Audit log (ai làm gì, khi nào) | P1 |
| **AutoMod**: block từ cấm, chống spam, chống mention spam, chặn link, lọc ML, channel cảnh báo mod riêng | P1 (keyword + spam), P2 (ML) |
| Quyền riêng tư: ai được nhắn DM, ai gửi lời mời kết bạn, lọc nội dung nhạy cảm khi tải lên | P1 |
| Bộ lọc media quét ảnh/video (scan khi upload) | P2 |
| Warning system cảnh báo thành viên | P2 |
| Family Center (phụ huynh xem hoạt động tổng hợp hàng tuần) | P3 |
| Age assurance / "teen by default" (Discord công bố 2026, **hoãn đến nửa cuối 2026**) | P3 — phụ thuộc pháp luật từng quốc gia |
| Chống raid (CAPTCHA khi vào ồ ạt) | P2 |

### 1.8 Nền tảng nhà phát triển (Developer Platform)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Bot API: REST + Gateway websocket, OAuth2 scopes | P2 — **không có bot thì cộng đồng không sống** |
| Slash commands, context menu, button/select/modal components | P2 |
| Webhooks + tích hợp sẵn (GitHub, YouTube, Twitch...) | P2 |
| App Directory (cửa hàng app) + App Launcher | P3 |
| Activities SDK (embedded app trong voice) | P3 |
| Monetization API cho app (SKU, entitlement, mua một lần + subscription) | P3 |
| Trang dev portal, rate limit, versioning, docs | P2 |

### 1.9 Thương mại hóa (Monetization)

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Gói thuê bao kiểu Nitro (giá tham chiếu US: Basic **$2.99/th**, Nitro **$9.99/th**): upload lớn, HD streaming, emoji toàn cục, tin 4000 ký tự, theme | P2–P3 |
| Server Boost (2/7/14 boost → perk: bitrate, emoji, upload) | P3 |
| Server subscriptions (trả tiền cho server creator) | P3 |
| Thanh toán: Stripe/PayPal + **cổng nội địa VN (MoMo, ZaloPay, VNPay)** nếu phục vụ thị trường VN | P2 |

### 1.10 Nền tảng & trải nghiệm client

| Chức năng | Mô tả | ƯU TIÊN |
|-----------|-------|---------|
| Web app (SPA) | P0 |
| Desktop (Electron/Tauri): global hotkey (push-to-talk), system tray, overlay | P0 (frame), P2 (hotkey/tray), P3 (overlay) |
| Mobile iOS + Android | P1 |
| 4 base theme + 3 mức density, light/dark (refresh desktop 2025) | P1 (dark/light), P3 (custom theme Nitro) |
| Accessibility: font scaling, reduce motion, screen reader, always-underline | P2 |
| Đa ngôn ngữ (30+ ngôn ngữ trên Discord) | P2 (EN + VI) |
| Console (Xbox/PlayStation integration) | P3 |

### 1.11 Hạ tầng ngầm (không thấy trên UI nhưng bắt buộc)

- **Realtime gateway**: websocket, reconnect + resume, heartbeat, sharding cho hàng triệu kết nối, presence fan-out.
- **Voice infra**: SFU (Selective Forwarding Unit) WebRTC, multi-region, DTLS-SRTP, simulcast, latency/jitter buffer.
- **CDN media**: upload phân tán, transform ảnh (WebP/AVIF), transcoding video.
- **Search index**: Elasticsearch/Meilisearch cho tìm tin nhắn.
- **Notification infra**: FCM/APNs/web-push, tiêu đề, duyệt quyền.
- **Observability**: metrics, tracing, log — không có thì không vận hành được voice.

---

## 2. Khoanh vùng phạm vi: làm gì, **không** làm gì

### 2.1 Những thứ nên **hoãn/bỏ** giai đoạn đầu

| Mục | Lý do |
|-----|-------|
| Go Live 4K, Clips, Stage 10k người, Activities SDK | Chi phí băng thông & độ phức tạp cực cao, không ảnh hưởng cảm nhận "Discord-like" |
| Tích hợp console, Age assurance, Family Center | Cần đối tác/pháp lý, giá trị với người dùng mới thấp |
| Boost system, Nitro đầy đủ | Chưa có user thì không có gì để bán |
| Overlay game, rich presence | Đòi hỏi client desktop trưởng thành |
| Clone permission model 30+ bit ngay từ đầu | Bắt đầu với ~10 permission thiết yếu, thiết kế bitfield **để mở rộng** |

### 2.2 Những thứ **không được cắt** (nếu cắt thì sản phẩm không còn là Discord)

1. Voice channel **luôn mở** — vào/ra tự do, không link mời, không lịch hẹn.
2. Mạng lưới server/channel/category + roles & permissions.
3. Presence realtime (ai online, ai đang gõ, ai đang trong voice) — hiện ngay trên UI.
4. Tốc độ nhắn tin tức thì và cảm giác mượt (undo/edit optimistic, virtualized message list).
5. Bot/slash command sẵn sàng cho cộng đồng tự mở rộng.

---

## 3. Lộ trình chi tiết (Roadmap)

> Giả định đội hình tham chiếu: **6–9 kỹ sư** (2 backend, 2 frontend web, 1–2 mobile, 1 voice/media, 1 DevOps, 1 design kiêm product). Nếu đội nhỏ hơn, nhân thời gian tương ứng.

### Giai đoạn 0 — Nghiên cứu & nền tảng kiến trúc *(Tuần 1–4)*

**Mục tiêu:** chốt scope, chốt stack, có skeleton chạy được.

- [x] **Định vị đã chốt (10/2026):** "Workspace cho Dev & Nhóm học tích hợp AI", song song VN + Quốc tế (chi tiết §0.1).
- [x] Chốt stack (đề xuất ở §4) và tiêu chí chọn: **một ngôn ngữ dùng lại được cho gateway + client logic** → [ADR-0004](docs/adr/0004-backend-typescript-first.md) (backend TS cho G1, ngưỡng chuyển Rust/Go ghi rõ), [ADR-0001](docs/adr/0001-monorepo-shared-protocol.md) (monorepo + protocol dùng chung).
- [x] Thiết kế data model nháp: `User, Guild, Channel, Role, PermissionOverwrite, Message, Member, Attachment, Relationship` → [docs/data-model.md](docs/data-model.md) + [db/migrations/0001_init.sql](db/migrations/0001_init.sql) (14 bảng, đã validate grammar PostgreSQL).
- [x] Thiết kế **permission bitmask** mở rộng (ghép bit theo hành động × đối tượng) → `packages/protocol/src/permissions.ts` (12 bit G1–G2 + `ADMINISTRATOR`), thuật toán phân giải quyền ở [data-model.md §4](docs/data-model.md).
- [x] Thiết kế **realtime protocol**: sự kiện server→client (`MESSAGE_CREATE`, `PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`...), thứ tự, idempotency, resume sau reconnect → [docs/gateway-protocol.md](docs/gateway-protocol.md) (opcode, close code, session TTL, replay log, fan-out, rate limit, 8 tiêu chí nghiệm thu).
- [x] Chọn wire format (JSON cho phase 1 → xem xét MessagePack/CBOR sau), thứ tự tin nhắn bằng snowflake ID (timestamp+worker+sequence — như Discord) → [ADR-0002](docs/adr/0002-json-wire-format.md) + `packages/protocol/src/snowflake.ts` (42-bit ms | 10-bit worker | 12-bit seq).
- [x] Skeleton monorepo (xem §4) → pnpm + Turborepo, `packages/protocol`, `packages/sdk`, `apps/web` (React 19 + Vite + Tailwind 4); typecheck/build/test đều xanh.
- [x] CI/CD: [.github/workflows/ci.yml](.github/workflows/ci.yml) — GitHub Actions `install --frozen-lockfile` → `typecheck` → `build` → `test` trên Node 22 + **PostgreSQL 16 service**, chạy khi push `main` và mọi PR. *(Môi trường staging vẫn chưa có — deploy thử lên Vercel/Neon là việc của G1.)*
- [x] Soạn **Terms/Privacy song ngữ EN/VI** cho hai thị trường: Luật An ninh mạng 2018 + Nghị định 72/2013 + Nghị định 13/2023/NĐ-CP (VN) và **GDPR** (EU/quốc tế), độ tuổi tối thiểu 13 — nội dung ở [apps/web/src/lib/legal.ts](apps/web/src/lib/legal.ts), trang `/terms` + `/privacy`, phiên bản ở `LEGAL_VERSION`, đăng ký bắt buộc tick đồng ý và lưu `users.terms_accepted_at/terms_version`. **Bản nháp đã xong phần kỹ thuật; còn luật sư rà soát + danh sách việc phải làm trước public ở [docs/legal/README.md](docs/legal/README.md).**

**Nghiệm thu:** ✅ 4 ADR ([docs/adr/](docs/adr/README.md)) + data model + protocol nháp + repo build được + Terms/Privacy EN/VI (bản nháp kỹ thuật, cần luật sư rà soát trước public — xem [docs/legal/README.md](docs/legal/README.md)). **G0 hoàn tất phần kỹ thuật.**

### Giai đoạn 1 — MVP nhắn tin *(Tháng 1–3)*

**Mục tiêu:** "Discord bằng được ở chế độ text", chạy trên **web** trước.

Scope:

- Auth: email/password + verify email, JWT (access + refresh), 2FA để sau.
- User: username/display name, avatar, trạng thái online/offline.
- Server: tạo, mời bằng link, category, kênh text, **roles + permission overwrites cơ bản** (~10 quyền: view channel, send messages, manage messages, manage channels, kick, ban, mention everyone...).
- Message: CRUD, markdown, edit/delete có nhãn, reply, mention, pin, optimistic UI, virtualized list, phân trang cursor (snowflake).
- Realtime gateway: websocket + reconnect/resume, typing indicator, presence.
- DM 1-1.
- Upload file ≤ 10MB, preview ảnh.
- Notification badge + đánh dấu đã đọc.
- Search tin nhắn cơ bản (cùng channel + toàn server).
- Block/report cơ bản.
- **i18n ngay từ G1**: Tiếng Anh là default, toggle Tiếng Việt, toàn bộ string nằm trong file localization — không hardcode.

**Tiến độ (10/2026):** đã chạy end-to-end trong [services/api](services/api) — auth email/password + JWT xoay vòng, guild + role `@everyone` + kênh mặc định, invite, message CRUD + cursor + typing, **DM 1-1** (`GET/POST /users/@me/channels`) dùng lại nguyên kênh message + fan-out, **badge chưa đọc + badge mention** theo bảng `read_states` + `message_mentions` (`POST /channels/:id/read`, `readStates` gồm `unread`/`mentions` trong `READY`, badge đỏ khi bị @) + **mentions inbox** (`GET /users/@me/mentions`, cursor `before`, lọc `VIEW_CHANNEL` trong SQL trước `LIMIT`), gateway ws (READY/fan-out/`RESUME`) và lọc quyền dùng chung `resolvePermissions`, **quản lý role qua API** (`GET/POST/PATCH/DELETE /guilds/:id/roles` + `PUT/DELETE /guilds/:id/members/:userId/roles/:roleId` — phân cấp `position`, mask quyền không cho cấp/giao ngoài tầm mình có, `@everyone` không xoá/gán được, fan-out `ROLE_CREATE/UPDATE/DELETE` + `PERMISSIONS_UPDATE` cho session đang mở, gán/thu role phát `GUILD_MEMBER_UPDATE` kèm `roleIds` để mọi client đổi chip ngay), **permission overwrite theo kênh** (`GET/PUT/DELETE /channels/:id/overwrites[/:targetType/:targetId]` — allow/deny không chồng bit, mask quyền actor, phân cấp target, `allow=deny=0` = xoá dòng; đổi quyền xem phát `CHANNEL_CREATE`/`CHANNEL_DELETE` + `PERMISSIONS_UPDATE` cho session đang mở; **kế thừa overwrite từ category** — `inheritedOverwrites` áp trước, kênh đè sau — và `PATCH /channels/:id { parentId }` di chuyển kênh giữa category, tính lại quyền ngay), **kéo-thả sắp xếp sidebar** (`PATCH /channels/:id { position }` = chỉ số trong nhóm kênh cùng category; server renumber lại 0..n rồi phát `CHANNEL_UPDATE` cho từng kênh đổi vị trí, chỉ số sai → 400, thiếu `MANAGE_CHANNELS` → 403; UI kéo hàng kênh/tiêu đề danh mục với vạch xanh chỉ vị trí thả, kéo danh mục đổi thứ tự giữa các danh mục, kéo kênh vào/ra category không cần mở dropdown); `READY` mang `roles` của từng server + `roleIds` trong mỗi member summary; **220 test backend** với PostgreSQL thật (+ 29 protocol, 38 SDK, 96 web). Web ([apps/web](apps/web)) đã có UI chat thật: đăng nhập, rail server, kênh, **view Home + sidebar DM + badge chưa đọc/mention**, **tab Mentions** (nút 🔔 trên rail, danh sách tin `@mình` từ `listMentions()` của SDK, bấm là nhảy đúng kênh + ack), **UI quản lý role** (panel Server Settings → Roles: ⚙ cạnh tên server khi có `MANAGE_ROLES`, danh sách role theo cấp, tạo/sửa tên-màu-10 quyền/xoá có xác nhận, `@everyone` không xoá được, bảng thành viên bấm chip để gán/thu role, lỗi server hiện tại chỗ), **UI ghi đè quyền theo kênh** (panel Channel Settings: chọn role/thành viên, bấm từng quyền xoay vòng theo role → cho phép → từ chối, lưu ngay + đặt lại; kênh trong category hiện phần kế thừa chỉ đọc + đổi category bằng dropdown; tạo được category từ nút ➕ và có ⚙ riêng trên sidebar), gửi tin realtime qua WebSocket, **sửa/xoá tin trong khung chat** (ô soạn tại chỗ + xác nhận xoá, nhãn `(đã sửa)`; moderator có `MANAGE_MESSAGES` sửa/xoá được tin người khác nhờ `channelPermissions` gửi kèm READY), **tệp đính kèm** (`POST /channels/:id/messages` nhận cả JSON lẫn multipart: tối đa 4 tệp × 10MB, tin chỉ có tệp vẫn hợp lệ; chặn `image/svg+xml`/`text/html` vì file phục vụ từ origin API; `GET /attachments/:id` kiểm `VIEW_CHANNEL`, người ngoài → 404, có `nosniff` + cache `immutable`; lưu trên đĩa cục bộ theo id snowflake, xoá tin là dọn file; server đọc `width`/`height` ảnh từ header PNG/GIF/JPEG/WebP; UI có nút 📎, kéo-thả tệp, dán ảnh từ clipboard, chip chờ gửi, ảnh inline + chip tải tệp, tải bằng fetch kèm token → blob URL), typing, **markdown render** (parser tự viết trong `apps/web/src/lib/markdown.ts`: fence/code/đậm/nghiêng/gạch chân/gạch ngang lồng nhau, quote, link tự động, highlight `@mention`; render bằng React element nên HTML thô hiện nguyên văn, có test chống XSS), **avatar người dùng** (magic bytes PNG/JPEG/WebP, trần 2MB, `USER_UPDATE`), **ghim tin nhắn** (trần 50/kênh, quyền `MANAGE_MESSAGES` hoặc chủ tin, DM được nếu còn là thành viên, `MESSAGE_PIN_UPDATE`), **group DM tới 10 người** (`POST /users/@me/channels` với `recipientIds`, `POST/DELETE /channels/:id/recipients[/:target]`, `PATCH /channels/:id { name }`; mọi thành viên mời được, chỉ chủ nhóm mời người khác ra, người cuối rời → xoá kênh + tin + tệp; `DM_CHANNEL_CREATE/UPDATE/DELETE`; UI chọn nhiều người trong hộp thoại "Tin nhắn mới" + panel 👥 đổi tên/thêm/mời ra/rời nhóm), i18n EN/VI. **Kéo-thả đổi cấp role** (`PATCH /guilds/:id/roles/:roleId { position }` = thứ hạng **trên xuống**, 0 = trên cùng, không tính `@everyone`; server renumber cả dãy `position` rồi phát `ROLE_UPDATE` cho **đúng những role đổi chỗ**, `@everyone` luôn ở đáy → 400, non-admin không đẩy role lên trên cấp cao nhất của mình → 403 và rollback sạch; UI kéo hàng role trong Server Settings với vạch xanh chỉ vị trí thả, thả đúng chỗ cũ thì không gọi API). **Chưa có:** di chuyển kênh vào category **bằng kéo-thả** (đã kéo được vào/ra category trên sidebar; panel Channel Settings vẫn đổi bằng dropdown). **Đã có thêm:** **tìm kiếm tin nhắn** (trong kênh + toàn server, cursor, tô sáng từ khoá — `GET /channels/:id/messages/search`, `GET /guilds/:id/messages/search`) và **xác thực email** (token sha256 dùng một lần hạn 24h, `SMTP_URL` hoặc ghi mail ra log ở dev, `POST /auth/verify-email` + `/resend`, thanh nhắc trong app).

**Nghiệm thu (playtest thật):**
- 100 user hoạt động đồng thời / 1 server 500 người không lag.
- Nhắn 1-1 và trong group: p95 latency < 300ms trong nước.
- Reconnect sau ngắt mạng 30s: không mất tin nhắn, không cần reload trang.
- Permission: user không có `view channel` **không thấy** kênh (kiểm tra cả ở API và gateway).

### Giai đoạn 2 — Thoại *(Tháng 4–6)* — *giai đoạn khó nhất*

**Mục tiêu:** voice channel luôn mở, vào/ra tự do, chất lượng ổn định.

- **SFU: LiveKit Cloud (đã chốt)** — dùng SDK chính thức (web/iOS/Android), không tự vận hành SFU, region **Singapore**. Dev/test trên plan **Build ($0)**; xem quota free tier & ngưỡng nâng cấp ở §4.4.
- Voice channel: join/leave, danh sách người trong kênh (voice state), speaking indicator, mute/deafen riêng.
- Âm thanh: Opus, 64→128kbps, VAD/PTT, AEC/AGC/noise suppression.
- Text chat đi kèm voice channel (Discord có sẵn).
- DM call 1-1 (dùng lại hạ tầng).
- Push notification mobile phase 1 (bắt đầu từ đây).
- Clients: bắt đầu port **desktop (Electron/Tauri)** và **mobile (React Native)** — voice là lý do người dùng cần app native.

**Nghiệm thu:**
- 10 người nói trong 1 kênh, p95 latency âm thanh < 150ms trong nước, không drop sau 30 phút.
- Tự động lấy region gần nhất; kill network → tự rejoins voice.
- Trên 3 nền tảng (web/desktop/mobile) chất lượng tương đương.

### Giai đoạn 3 — Social & media phong phú *(Tháng 7–9)*

- Friends system đầy đủ + message requests (anti-harassment).
- Group DM (≤10), call video nhóm.
- Reaction, threads, emoji tùy chỉnh, embed link preview, slowmode.
- Go Live 720p30 (share màn hình) + xem chung.
- Mentions inbox, per-channel notification settings, web push + push mobile hoàn chỉnh.
- Forum channel, announcement channel, polls, voice message (2 levels P2 nhưng khớp "Discord cảm giác").
- Onboarding + rules screening cho server community.
- Audit log + timeout/kick/ban đầy đủ + **AutoMod (keyword + spam)**.
- Client polish: dark/light theme, phím tắt, tray, push-to-talk global hotkey.

**Nghiệm thu:** 1 server community 1.000 thành viên tự vận hành được mà không cần admin can thiệp tay từng tin.

### Giai đoạn 4 — Nền tảng & độ trưởng thành *(Tháng 10–14)*

- **Bot API v1**: REST + gateway intents, OAuth2 scopes, slash commands + components, webhooks, dev portal + docs + sandbox app.
- App Directory cơ bản (danh sách app cài vào server).
- Search toàn văn (Elasticsearch), kho file đã gửi.
- Stage channel (mở rộng từ voice), soundboard.
- 2FA, đăng nhập thiết bị, thiết lập quyền riêng tư chi tiết, upload media scan.
- Đa ngôn ngữ EN/VI, accessibility cơ bản.
- Tăng trưởng: template server, discovery (nội bộ trước, không cần public directory).

**Nghiệm thu:** có ≥ 10 bot bên thứ ba thật sự chạy trên Umaru (kể cả team tự viết 2–3 bot mẫu) mà không cần hỗ trợ thủ công.

### Giai đoạn 5 — Monetization & Scale *(Tháng 15+)*

- Gói thuê bao kiểu Nitro (upload lớn, HD stream, emoji toàn cục, 4000 ký tự).
- Server Boost.
- Multi-region voice thật sự (SG/JP/EU/US), CDN toàn cầu, target 100k user đồng thời.
- Discovery public, Quests/sự kiện, Activities SDK (nếu cộng đồng đủ lớn).
- App monetization (SKU/entitlement) — chỉ khi dev platform sống.

**Metric chính:** DAU/MAU, thời gian trong voice/người/ngày, % server có ≥ 5 bot, retention D7/D30, tỷ lệ upload lỗi, p95 message latency.

### Track song song — AI & song ngữ (áp dụng xuyên suốt G1→G5)

**A. AI (theo định vị "tích hợp AI")** — không nằm trong phase riêng, bám theo từng giai đoạn:

| Giai đoạn | Chức năng AI | ƯU TIÊN |
|-----------|--------------|---------|
| G1–G2 | **TL;DR channel/thread**: tóm tắt 10–20 tin cuối khi vào trễ, có cache | P1 |
| G2 | **Biên bản họp voice**: tóm tắt phiên thoại khi rời kênh (cần transcripts) | P1 |
| G4 | **@umaru trong chat**: trả lời câu hỏi, giải thích code, gợi ý bài tập cho nhóm học (EN/VI) | P2 |
| G4 | **Tìm kiếm bằng ngôn ngữ tự nhiên** (song song search keyword) | P2 |
| G5 | AI hỗ trợ kiểm duyệt (gợi ý flag cho AutoMod — chỉ gợi ý, không tự hành động) | P3 |

- **Chi phí 0đ:** dùng credit miễn phí (LiveKit Inference credits trên plan Build) + model có free tier, hoặc **BYOK** để user tự trả API key của họ. Không trả tiền token khi chưa có doanh thu.
- **Ràng buộc:** mọi output AI phải hiển thị rõ là AI; AI không có quyền kick/ban — chỉ gợi ý cho mod.

**B. Song ngữ & pháp lý**

- i18n EN (default) + VI toggle, string tập trung từ G1 — retrofit sau rất tốn.
- Landing page + docs + email song ngữ.
- Terms/Privacy EN/VI (GDPR + Luật VN) trước bản public đầu tiên.
- **Stripe (VNĐ + USD)** chuẩn bị ở G5 (kèm phương án thuế/xuất hoá đơn tại VN).

**C. Tính năng game → giảm ưu tiên** theo định vị workspace: overlay, Clips, rich presence, game store → neo P3, không chặn milestone nào.

---

## 4. Kiến trúc & stack đề xuất

### 4.1 Frontend — dùng lại tối đa giữa 3 nền tảng

| Lớp | Lựa chọn đề xuất | Ghi chú |
|-----|-------------------|---------|
| Web | **React + TypeScript + Vite** (SPA), UI: Tailwind + Radix/shadcn, state: Zustand + TanStack Query | Không cần SSR cho app realtime |
| Desktop | **Tauri 2** (nhẹ, Rust shell) *hoặc* Electron (nếu team đã quen, nặng hơn ~3-4x RAM) | Dùng chung bundle web + shell native |
| Mobile | **React Native (Expo)** | Dùng chung domain logic với web |
| Chia sẻ logic | **Monorepo (pnpm/turborepo)**: `packages/protocol` (types + event codec), `packages/sdk` (API client, gateway client, reconnect), `packages/ui` (components thuần) | *Đầu tư đúng chỗ này để 3 client không phải viết 3 lần* |

### 4.2 Backend

| Lớp | Lựa chọn | Lý do |
|------|----------|-------|
| **Gateway (realtime ws)** | **G1–G2: TypeScript (`ws`) dùng lại `@umaru/protocol`** — [ADR-0004](docs/adr/0004-backend-typescript-first.md) | Ở quy mô beta, codec/quyền dùng chung quan trọng hơn benchmark; chuyển **Rust** (tokio/tungstenite) khi vượt ngưỡng ghi trong ADR (>5k conn/node, event-loop lag p95 >50ms) |
| **API (REST)** | **G1–G2: TypeScript (Fastify) + Kysely/Drizzle + `pg`** | Cùng type với client; `pg` trả `int8` dạng string khớp thẳng type `Snowflake`; Go chỉ khi có nhu cầu tối ưu riêng |
| **Voice SFU** | **LiveKit Cloud (đã chốt)** — hosted, SDK web/mobile, region Singapore | Không tự viết/self-host SFU; xem quota ở §4.4 |
| **Media/CDN** | S3-compatible (MinIO/R2/S3) + Cloudflare/R2 CDN, worker transform ảnh | |
| **DB chính** | **PostgreSQL** (+ logical replication) | Discord dùng MySQL/Cassandra; với Umaru, Postgres đơn giản hơn nhiều |
| **Cache / presence** | **Redis** (presence, pub/sub fan-out, rate limit) | |
| **Tìm kiếm** | OpenSearch/Elasticsearch (hoặc Meilisearch nếu muốn nhẹ) | |
| **Event bus** | NATS *hoặc* Kafka | Kafka nếu dự tính volume lớn; NATS nhẹ hơn cho start |
| **Push** | FCM + APNs + Web Push | |

**Lưu ý kiến trúc then chốt (bài học từ Discord):**
1. **Trạng thái gateway phải có thể resume** — client lưu `session_id + last_seq`, reconnect gửi lại, server replay. Không thì mỗi lần mạng yếu là mất trạng thái.
2. **Presence & typing là ephemeral** (Redis/Maps), **không** ghi DB.
3. **Fan-out ghi (message) = pub/sub + DB**, đọc = cursor pagination theo snowflake ID; tránh JOIN nặng bằng bảng phụ (hoặc denormalize `author` snapshot vào message).
4. **Permission kiểm tra tập trung** (một service function duy nhất) — mọi API và gateway đều đi qua đó; sai chỗ này là lỗ hổng bảo mật.
5. Tính **thứ tự tin nhắn** từ ID, không từ timestamp (clock skew).

> Chi tiết đã chốt ở G0: giao thức → [docs/gateway-protocol.md](docs/gateway-protocol.md); resume/replay → [ADR-0003](docs/adr/0003-gateway-resume-redis-streams.md); data model → [docs/data-model.md](docs/data-model.md).

### 4.3 Ước lượng nhân sự & thời gian

| Giai đoạn | Thời gian | Nhân sự cốt lõi |
|-----------|-----------|------------------|
| G0 Nền tảng | 1 tháng | CTO/architect + 1 fullstack |
| G1 Text MVP | 3 tháng | +2 backend, +1 web, +1 design |
| G2 Voice | 3 tháng | +1 kỹ sư rành **WebRTC client** (tích hợp LiveKit SDK — nhẹ hơn nhiều so với tự viết SFU) |
| G3 Social | 3 tháng | +1–2 mobile |
| G4 Platform | 5 tháng | +1 backend/devrel |
| G5 Scale/Money | liên tục | +1 DevOps/infra |

**Tham chiếu thực tế:** Discord mất nhiều năm với hàng trăm kỹ sư để đến hiện tại. Bản "người dùng thật sự thích" của Umaru ở mốc **~12–18 tháng với đội 7–10 người** là khả thi; clone full-functionality thì không — và **không nên đặt mục tiêu đó**.

### 4.4 Chi phí với ngân sách đã chốt: 0đ/tháng

Mọi thứ ở phase G1–G2 phải nằm trong free tier. Số liệu 10/2026 — **vào dashboard kiểm tra lại trước khi dựa vào**:

| Hạng mục | Free tier 0đ | Ghi chú / ngưỡng |
|----------|--------------|------------------|
| Voice/video | **LiveKit Cloud "Build" $0**: ~5.000 WebRTC phút + ~50GB băng thông downstream/tháng, kèm credit inference AI (nguồn: [livekit.com/pricing](https://livekit.com/pricing) + tổng hợp 10/2026) | 5.000 phút ≈ **83 giờ người/ngồi trong voice/tháng** — 10 người × 1 giờ = 600 phút ≈ 8 buổi → hết quota là phải nâng **Ship ($50/th)** |
| API + realtime gateway | Cloudflare Workers (100k req/ngày) hoặc free instance (Render/Koyeb/Fly) | Gateway websocket cần process sống lâu; free instance hay cold start — chấp nhận được ở beta |
| Database | Neon / Supabase / Turso free (~0,5GB) | Đạt ~400MB → nâng paid (~$19–25/th) |
| Object storage + CDN ảnh | Cloudflare R2 free (10GB, không phí egress) | **Bắt buộc có quota upload/người dùng ngay từ G1** (10MB/file, ~500MB/người/tháng) |
| Email (verify, reset) | Resend / Brevo free | |
| Push (FCM / APNs / Web Push) | Miễn phí theo nền tảng | |
| **AI** | LiveKit Inference credits (plan Build) + model có free tier, hoặc **BYOK** (user tự gắn API key) | BYOK là phương án 0đ tuyệt đối; trả token bằng tiền chỉ khi có doanh thu |

**Ngưỡng nâng cấp phải chấp nhận (vượt 0đ):**

1. LiveKit Build hết quota 2 tháng liên tiếp → nâng **Ship $50/th**.
2. Public beta từ G3 (user > ~200) → dự chi **$50–150/th** (Ship + DB paid + email).
3. Bật **Go Live** phải kèm giới hạn (tối đa ~5 streamer, 560–720p) vì mỗi phút stream cũng trừ quota LiveKit.

Ước chi phí theo mốc 1k / 10k / 100k user làm riêng khi tiếp cận G3.

---

## 5. Rủi ro & pháp lý

| Rủi ro | Mức độ | Giảm thiểu |
|--------|--------|------------|
| **Trust & Safety**: lạm dụng, spam, nội dung xấu, quấy rối | **Cao** | Dự ngân sách/moderation tool ngay từ G1; AutoMod ở G3; không thể "để sau" |
| **Chi phí bandwidth voice** | Cao | ABR, region giới hạn, quota upload, monitor cost/user/ngày |
| **Pháp lý 2 thị trường** — Luật VN (Nghị định 72/2013, Luật An ninh mạng 2018: lưu trữ, gỡ bỏ, báo cáo) + **GDPR** (EU) | Cao | **Terms/Privacy song ngữ EN/VI** trước bản public đầu; thuê pháp lý tại VN; thiết kế dữ liệu cho khả năng truy xuất theo yêu cầu; chính sách nội dung & cơ chế báo cáo/gỡ bỏ rõ ràng |
| **Độ tuổi & nội dung người lớn** | Trung bình–cao | Điều khoản tuổi tối thiểu, filter nhạy cảm, pathway age verification nếu cần |
| **Sao chép Discord**: brand, icon, tên, asset, reverse-engineer API | Trung bình | Đặt tên/visual riêng 100%, không đọc payload riêng tư của Discord để bắt chước |
| **Talent**: engineer voice/SFU khan hiếm | Cao | Ưu tiên LiveKit thay vì tự viết; thuê tư vấn phần đầu |
| **Chicken-egg: mạng lưới người dùng** | Cao | Chọn niche cộng đồng cụ thể (game team, lớp học, server VN) thay vì "Discord toàn cầu" |

---

## 6. Checklist tổng hợp theo mức ưu tiên

**P0 (MVP text, G1):** auth email · username/avatar · presence · server + category + channel · roles & permissions cơ bản · message realtime + markdown + edit/delete + mention · DM 1-1 · upload ảnh ≤10MB · invite link · badge thông báo · anti-abuse cơ bản (block/report).

**P0 (voice, G2):** voice channel luôn mở · SFU + Opus + VAD/PTT · voice state UI · noise suppression · DM call · push notification mobile · desktop/mobile client.

**P1 (public bản đầu):** friends đầy đủ · group DM · reaction/reply/thread · emoji tùy chỉnh · embed · search · mentions inbox · web+mobile push · timeout/kick/ban/audit log · AutoMod (keyword+spam) · Go Live 720p · video call · onboarding/rules screening.

**P2 (trưởng thành):** forum/announcement/polls/voice message · stage · soundboard · bot API + slash commands + webhooks + dev portal · 2FA · đa ngôn ngữ · multi-region · media scan · template/discovery nội bộ.

**P3 (nền tảng):** Nitro/Boosts · Activities SDK · App monetization · Clips · console · family center/age assurance · public discovery · overlay.

---

## 7. Quyết định đã chốt (10/2026)

1. ✅ **Định vị**: "Workspace cho Dev & Nhóm học tích hợp AI" — song song VN + Quốc tế, dễ demo portfolio.
2. ✅ **Thoại**: **LiveKit Cloud** (SDK có sẵn, multi-region, không cần tự viết SFU).
3. ✅ **Ngân sách**: **0đ/tháng** — free tier đủ dùng, server region Singapore.
4. ✅ **Thị trường song song VN + Quốc tế**:
   - Giao diện: Tiếng Anh chính + toggle Tiếng Việt
   - Server: Singapore (latency <50ms VN, <100ms ĐNÁ)
   - Thanh toán: chuẩn bị **Stripe (VNĐ + USD)** cho phase sau
   - Pháp lý: **Terms/Privacy song ngữ** (GDPR + Luật VN)

### Việc còn phải chốt (không chặn G1–G2)

- Chiến lược AI chi tiết: mô hình nào, BYOK hay chủ dự án trả token — xem Track song song ở §3.
- Ngưỡng vượt ngân sách 0đ — xem §4.4.
- Tên thương hiệu, domain, bộ nhận diện: kiểm tra xung đột trademark với "Umaru", không dùng asset/brand của Discord.

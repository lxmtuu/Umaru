# Umaru

Workspace chat/voice kiểu Discord cho **Dev & Nhóm học**, tích hợp AI. Song song VN + Quốc tế (EN mặc định, toggle VI).

> **Lộ trình & phân tích sản phẩm:** xem [ROADMAP.md](./ROADMAP.md) — các quyết định chiến lược ở §0.1 và §7.
> **Tài liệu kiến trúc:** [data-model.md](docs/data-model.md) · [gateway-protocol.md](docs/gateway-protocol.md) · [ADR](docs/adr/README.md) · DDL [db/migrations/0001_init.sql](db/migrations/0001_init.sql)

## Cấu trúc

```
umaru/
├── apps/
│   └── web/              # React + TypeScript + Vite + Tailwind (client web)
├── packages/
│   ├── protocol/         # Types + codec dùng chung: snowflake, permissions (resolve), gateway events
│   └── sdk/              # API client + Gateway WebSocket client (reconnect/resume)
├── services/
│   └── api/              # Fastify REST + gateway ws, PostgreSQL (G1)
├── docs/                 # data-model, gateway spec, ADR
├── db/migrations/        # PostgreSQL DDL (áp bằng services/api)
├── ROADMAP.md            # Phân tích chức năng Discord + lộ trình G0→G5
├── turbo.json            # Đồ thị task (build/dev/typecheck/test)
└── pnpm-workspace.yaml
```

Sau này thêm: `apps/desktop` (Tauri/Electron), `apps/mobile` (React Native), `packages/ui`.

## Chạy nhanh

```bash
pnpm install
pnpm build              # build protocol → sdk → api → web
pnpm typecheck && pnpm test
```

### Chỉ client web

```bash
pnpm dev:web            # http://127.0.0.1:5173
```

`pnpm dev` chạy **cả** web và API (API cần PostgreSQL đang chạy, xem dưới). Vite proxy `/api` (kể cả WebSocket) sang `127.0.0.1:4000` nên web gọi same-origin, không cần CORS.

### Backend G1 (REST + realtime gateway)

Cần PostgreSQL 16. Dev bằng Docker:

```bash
docker run -d --name umaru-pg-dev \
  -e POSTGRES_USER=umaru -e POSTGRES_PASSWORD=umaru -e POSTGRES_DB=umaru \
  -p 55432:5432 postgres:16-alpine

cd services/api
cp .env.example .env          # sửa JWT_SECRET khi deploy thật
pnpm dev                      # migrate + listen http://127.0.0.1:4000
```

Test backend cũng cần Postgres (tạo sẵn database `umaru_test`):

```bash
docker exec umaru-pg-dev createdb -U umaru umaru_test   # một lần
pnpm --filter @umaru/api test     # 187 test: auth, quyền, role, overwrite + category, thứ tự kênh, cursor, gateway ws, DM, read state + mention, tìm kiếm, xác thực email, chặn/báo cáo, hàng đợi báo cáo cho admin, path param, tệp đính kèm (multipart, quyền, dọn file), avatar (magic bytes, trần dung lượng, `USER_UPDATE`), ghim tin nhắn (quyền, trần 50, DM, block, `MESSAGE_PIN_UPDATE`)
pnpm test                          # toàn bộ: 187 api + 29 protocol + 36 SDK + 84 web (markdown, tệp đính kèm, avatar, ghim, session, tìm kiếm, xác thực email, pháp lý, render)
```

API đã có (`/api/v1`): `auth/register|login|refresh|logout`, `users/@me`, `users/@me/avatar` (PUT/DELETE), `users/:id/avatar/:uploadId` (phục vụ ảnh đại diện), `users/@me/guilds`, `users/@me/channels` (list/create **DM 1-1**), `users/@me/read-states`, `users/@me/mentions` (mentions inbox), `guilds` (+`channels`, `roles`), `channels/:id/messages` (cursor `before`; **multipart** khi gửi kèm tệp), `attachments/:id` (tải tệp, kiểm `VIEW_CHANNEL`), `channels/:id` (PATCH tên/topic/**category**/**position**), `channels/:id/overwrites` (ghi đè quyền theo kênh), `channels/:id/read`, `messages/:id`, `channels/:id/messages/search` + `guilds/:id/messages/search` (tìm tin, `q` 2–100 ký tự), `channels/:id/pins` (tin đã ghim), `messages/:id/pin` (PUT/DELETE), `channels/:id/typing`, invites, `auth/verify-email` (+`/resend`), `users/@me/blocks` (chặn/bỏ chặn), `reports` (báo cáo vi phạm), `admin/status` + `admin/reports` (hàng đợi cho người vận hành), `gateway` + `gateway/ws`.

## Stack (đã chốt — ROADMAP §4)

| Lớp | Chọn |
|------|------|
| Web | React + TS + Vite, Tailwind, Zustand (state + gateway), `@umaru/sdk` |
| Chia sẻ logic | pnpm + turborepo, `@umaru/protocol`, `@umaru/sdk` |
| API + gateway | TypeScript: Fastify + `ws` ([ADR-0004](docs/adr/0004-backend-typescript-first.md)) |
| DB | PostgreSQL 16 (Neon khi deploy), snowflake `BIGINT` làm khoá |
| Mật khẩu / token | argon2id (`@node-rs/argon2`), JWT HS256 access 15 phút + refresh opaque xoay vòng |
| Thoại | **LiveKit Cloud** (region Singapore) — kết nối từ G2 |
| Ngân sách | 0đ/tháng — free tier (ROADMAP §4.4) |

## Giai đoạn hiện tại

**G1 — MVP nhắn tin (đang làm).** Đã chạy được end-to-end:

- Auth email/password (argon2id), access + refresh token xoay vòng, logout thu hồi.
- Server (guild) + role `@everyone` + kênh `#general` mặc định, invite link.
- Kênh text/voice/category, sửa/xoá kênh theo `MANAGE_CHANNELS`.
- Tin nhắn: gửi/đọc (cursor theo snowflake)/sửa/xoá, reply, typing indicator.
- **DM 1-1** (`dm` channel, `guildId = null`, 2 dòng `channel_members`): mở lại cuộc cũ thay vì tạo trùng (advisory lock theo cặp user), tin nhắn chạy đúng cùng đường `messages` + fan-out như kênh thường; `DM_CHANNEL_CREATE` đẩy sang người nhận khi có người mới mở DM.
- **Badge chưa đọc + badge mention** (bảng `read_states` + `message_mentions`): `POST /channels/:id/read` (ack tới một tin hoặc tin mới nhất, `GREATEST` nên không lùi mốc), `GET /users/@me/read-states`; `READY` kèm `readStates[]` (`unread` + `mentions`) nên mở app là thấy đúng số tin. Tin do chính mình gửi không tính; đang mở kênh thì tự ack. Badge **đỏ** hiện số lượt bị `@`mention (tách khỏi badge xanh tin thường), parse `@username` khi gửi/sửa tin. **Mentions inbox**: `GET /users/@me/mentions` (cursor `before`, `limit`) trả tin có `@mình` mới nhất trước kèm kênh + tên server + người gửi (DM kèm người nhận); lọc `VIEW_CHANNEL` **trong SQL** trước `LIMIT` nên mất quyền là dòng biến mất, không lộ id kênh ẩn.
- **Xác thực email**: đăng ký xong là gửi mail kèm link `/?verifyToken=...` (token 32 byte base64url, DB chỉ lưu `sha256`; dùng một lần, hạn 24h). `POST /auth/verify-email` (công khai) và `POST /auth/verify-email/resend` (cooldown 60s → 429; đã xác thực → 409; gửi lại thì token cũ bị vô hiệu). Chưa có `SMTP_URL` thì mail ghi ra log server để dev tự bấm link; bật `SMTP_URL` là gửi thật. Response đăng ký kèm `devVerificationToken` **chỉ khi** `EMAIL_VERIFICATION_ECHO` bật (mặc định bật ở dev/test, tắt ở production). Chưa xác thực **không bị khoá đăng nhập** — app hiện thanh nhắc + nút gửi lại; token được xoá khỏi thanh địa chỉ ngay khi dùng.
- **Chặn & báo cáo**: `PUT/DELETE /users/@me/blocks/:userId` + `GET /users/@me/blocks`. Chặn **một chiều trong DB** (bảng `relationships` sẵn có, `type='blocked'`) nhưng **hiệu lực hai chiều**: không tạo được DM, không gửi được tin trong DM cũ, lịch sử DM không đọc được, DM biến khỏi danh sách của cả hai, và tin của người đã chặn nhau không còn trong mentions/search. Chặn cũng cắt quan hệ bạn bè/lời mời đang có. Tin trong **kênh server vẫn hiện** (block là chuyện giữa hai người, ẩn nội dung cộng đồng là việc của moderation). `POST /reports` (báo cáo tin hoặc người, 8 lý do, tối đa 20 báo cáo/giờ) **sao lưu nội dung tin vào báo cáo** để xoá/sửa tin sau đó không mất bằng chứng; báo cáo tin trong kênh không xem được → 404 (không dò được id tin riêng tư). UI: 🚩 báo cáo + 🚫 chặn khi hover tin của người khác, hộp thoại chọn lý do, panel 🛡 **Người đã chặn** để bỏ chặn.
- **Hàng đợi báo cáo cho người vận hành**: `GET /admin/status` (client biết có hiện lối vào không), `GET /admin/reports?status=open|reviewing|closed` (mới nhất trước, cursor `before`, kèm snapshot nội dung + số đếm theo tab) và `PATCH /admin/reports/:id { status }`. Admin khai báo bằng env `ADMIN_USERNAMES` / `ADMIN_USER_IDS` — **để trống thì không ai là admin** (mặc định đóng, an toàn khi quên cấu hình). Thiếu quyền → 403, chưa đăng nhập → 401. Không trả email của ai. UI: trang riêng `/admin/reports` (tab theo trạng thái, nút Đang xem xét / Đóng / Mở lại), lối vào ⚑ ở chân sidebar chỉ hiện khi tài khoản là admin.
- **Terms/Privacy EN/VI**: nội dung duy nhất ở `apps/web/src/lib/legal.ts` (phiên bản ở `LEGAL_VERSION` trong protocol), mở được khi chưa đăng nhập tại `/terms` và `/privacy` (`?lang=en|vi`). Đăng ký **bắt buộc tick đồng ý** — server kiểm `acceptedTerms === true` và ghi `users.terms_accepted_at` + `terms_version`. Trạng thái bản nháp và các việc còn phải làm trước public: [docs/legal/README.md](docs/legal/README.md).
- **Tìm kiếm tin nhắn**: nút 🔍 trong khung chat → `GET /channels/:id/messages/search` hoặc `GET /guilds/:id/messages/search` (`q` 2–100 ký tự, `before` + `limit` 1–50, mới nhất trước). Tìm toàn server chỉ trả kênh đang xem được (`VIEW_CHANNEL` lọc **trong SQL** trước `LIMIT`); `%`/`_`/`\` trong từ khoá được escape nên không thành wildcard. Kết quả tô sáng từ khoá, bấm vào là mở đúng kênh, lật thêm trang nếu tin cũ hơn trang đang giữ rồi cuộn tới và tô sáng tin đó. Migration `0003_message_search.sql` thêm `pg_trgm` + GIN trigram (best-effort: thiếu quyền thì vẫn chạy, chỉ chậm hơn).
- **Gateway thật**: HELLO → IDENTIFY → READY (kèm guild + kênh + **`roles`** + thành viên có **`roleIds`** + `dms` + `readStates` + **`channelPermissions`**: quyền hiệu dụng của chính user đó tại từng kênh, server tính sẵn nên client không phải chép lại thuật toán), heartbeat/ack, fan-out `MESSAGE_CREATE/UPDATE/DELETE`, `CHANNEL_*`, `GUILD_MEMBER_ADD`, **`GUILD_MEMBER_UPDATE`** (role của thành viên vừa gán/thu — cả server đổi chip ngay), `DM_CHANNEL_CREATE`, `TYPING_START`, `PRESENCE_UPDATE`, **`PERMISSIONS_UPDATE`** (quyền của chính user vừa đổi — kênh mới, được gán/thu role, vào server — nên nút sửa/xoá bật/tắt ngay, không cần reconnect), và **resume** phát lại tin nhắn bị lỡ sau khi mất mạng.
- Quyền: `resolvePermissions` trong `@umaru/protocol` dùng chung cho REST + gateway; mất `VIEW_CHANNEL` → 404 ở API và `CHANNEL_DELETE` qua gateway.
- **Quản lý role qua API**: `GET/POST /guilds/:id/roles`, `PATCH/DELETE /guilds/:id/roles/:roleId`, `PUT/DELETE /guilds/:id/members/:userId/roles/:roleId` — phân cấp theo `position` (không đụng role cao hơn cấp mình, owner/ADMIN bỏ qua) + mask quyền (**không tạo/sửa/giao role ngoài tập quyền mình có** — chặt hơn Discord nên mod không tự phong ADMIN được), `@everyone` không xoá/gán được; đổi quyền → `PERMISSIONS_UPDATE` đẩy lại cho session đang mở, tạo/sửa/xoá role phát `ROLE_CREATE/UPDATE/DELETE` cho cả server, gán/thu role phát `GUILD_MEMBER_UPDATE`.
- **Permission overwrite theo kênh**: `GET/PUT/DELETE /channels/:id/overwrites[/:targetType/:targetId]` cho cả role và thành viên; `allow`/`deny` không được chồng bit (400), `allow` phải nằm trong quyền actor đang có (**mask** — mod không tự mở `MANAGE_MESSAGES`), target không cao hơn cấp actor (owner/ADMIN bỏ qua), `@everyone` được phép. `allow = deny = 0` = xoá override. Overwrite của **category được kế thừa** xuống kênh con (category áp trước, kênh cùng target đè sau) — `resolvePermissions` nhận `inheritedOverwrites`, backend nạp `parent_id` ở REST lẫn READY; `PATCH /channels/:id { parentId }` di chuyển kênh giữa category (`null` = ra gốc) và tính lại quyền. Mỗi thay đổi → `refreshGuildVisibility`: người mất quyền xem nhận `CHANNEL_DELETE`, người vừa được cấp nhận **`CHANNEL_CREATE`** + `PERMISSIONS_UPDATE` (trước đây chỉ có chiều mất quyền).
- **UI chat thật** ([apps/web](apps/web)): đăng ký/đăng nhập, rail server (chấm xanh khi server có tin chưa đọc), nút **Home** với danh sách DM (`@tên`) + **badge số tin chưa đọc** và **badge đỏ số lượt bị nhắc** (DM có tin mới/mention nổi lên đầu, tự xoá khi mở), modal chọn người để mở DM, danh sách kênh, **tab Mentions** (nút 🔔 trên rail kèm badge đỏ tổng lượt nhắc, danh sách tin `@mình` 50 dòng/trang có tên người gửi/kênh/server/thời gian, nút **Xem thêm** nạp trang cũ hơn qua cursor `before`, bấm một dòng là nhảy đúng kênh và ack), gửi tin hiện ngay qua WebSocket, typing indicator, **sửa/xoá tin ngay trong khung chat** (nút hiện khi hover: ✎ mở ô soạn tại chỗ, Enter lưu — Esc huỷ; 🗑 hỏi xác nhận rồi xoá; nút có ở tin của mình, và ở tin của người khác khi mình có `MANAGE_MESSAGES` ở kênh đó — lấy từ `channelPermissions` của READY; nhãn `(đã sửa)` hiện sau khi lưu; tin bị xoá biến mất khỏi cả khung chat lẫn tab Mentions), đăng xuất; **panel Server Settings → Roles** (nút ⚙ cạnh tên server, chỉ hiện khi là owner hoặc có `MANAGE_ROLES`: danh sách role xếp theo cấp, tạo role mới, sửa tên/màu 10 quyền/xoá role có xác nhận, `@everyone` không xoá được; bảng **thành viên** bấm chip để gán/thu role — mọi client khác trong server thấy đổi ngay qua `GUILD_MEMBER_UPDATE`; lỗi 403/400 của server hiện ngay trong panel), **panel Channel Settings → ghi đè quyền** (nút ⚙ trên header khi xem kênh text và có `MANAGE_CHANNELS`/`MANAGE_ROLES`: danh sách override hiện có kèm số bit cho/ từ chối, chọn target trong dropdown (`@everyone`, role, thành viên), bấm từng quyền để xoay vòng **theo role → cho phép → từ chối** và lưu ngay, nút đặt lại; kênh nằm trong category hiện **phần kế thừa (chỉ đọc)** + nút sửa category, và đổi được category chứa kênh bằng dropdown; nút ➕ tạo kênh có chọn **text channel / category**, category có ⚙ riêng trên sidebar); token tự refresh khi 401; i18n EN/VI (lưu lựa chọn).

- **Ghim tin nhắn** (`services/api/src/messages/routes.ts` + `apps/web/src/lib/chatStore.ts`): `PUT`/`DELETE /messages/:id/pin` (idempotent) và `GET /channels/:id/pins` (mới ghim trước, tối đa **50 tin/kênh** — ghim tin thứ 51 → **400** kèm hướng dẫn bỏ ghim). Quyền: server cần **`MANAGE_MESSAGES`** (thiếu → 403), **DM** thì người trong cuộc ghim được tin của nhau (DM không có role); DM đang bị chặn → không ghim được và danh sách ghim rỗng (cùng quy tắc với lịch sử). Ghim/bỏ ghim phát **`MESSAGE_PIN_UPDATE`** (tách khỏi `MESSAGE_UPDATE` vì khác quyền) nên client khác thấy chip 📌 ngay; ghim lại tin đã ghim không phát event trùng. UI: nút 📌 trên header mở panel tin ghim (bấm một dòng để nhảy tới tin và tô sáng, tải thêm trang cũ nếu cần), nút 📍/📌 trong thanh công cụ của từng tin, chip "Đã ghim" cạnh tên tác giả. Index bộ phận `messages(channel_id, id DESC) WHERE pinned` (migration `0008`) giữ truy vấn ghim rẻ dù lịch sử lớn.

- **Ảnh đại diện** (`services/api/src/users/routes.ts` + `apps/web/src/lib/avatars.ts`): `PUT /users/@me/avatar` (`multipart`, một ảnh **≤ 5MB**, chỉ PNG/JPEG/GIF/WebP/AVIF — **không** SVG/HTML), `DELETE /users/@me/avatar`, `GET /users/:id/avatar/:uploadId` (yêu cầu đăng nhập). Ba lớp kiểm: MIME khai báo → **magic bytes** (`detectImageMime`, file `.exe` đổi tên thành `.png` vẫn bị 415) → trần byte (413, file dở bị xoá). File lưu ở `<UPLOADS_DIR>/avatars` (tách khỏi tệp đính kèm) và **file cũ bị xoá sau khi DB đã trỏ sang ảnh mới**. URL chứa `uploadId` nên đổi avatar là đổi URL → `cache-control: immutable` an toàn; bảng riêng `user_avatars` (migration `0007`) lưu MIME/kích thước để phục vụ đúng `content-type`. Đổi avatar phát **`USER_UPDATE`** tới mọi server mà người đó là thành viên **và** các session của chính họ, nên tab khác/người khác thấy ảnh mới ngay. Client tải ảnh bằng fetch + Bearer → **blob URL** (cache theo `avatarUrl`), hiện chữ cái đầu khi chưa có ảnh; hộp thoại hồ sơ có sẵn ở góc dưới sidebar (bấm vào avatar của mình).

- **Markdown trong tin nhắn** (`apps/web/src/lib/markdown.ts` + `components/MessageContent.tsx`): parser tự viết (**không** dùng `dangerouslySetInnerHTML`, chỉ ánh xạ cây node sang React element nên HTML thô trong tin luôn hiện nguyên văn — an toàn XSS mà không cần sanitizer) hỗ trợ `` ```fence``` `` có nhãn ngôn ngữ, `` `code` ``, `**đậm**`, `*nghiêng*`, `__gạch chân__`, `~~gạch ngang~~`, `***cả hai***`, lồng nhau, `> quote` nhiều dòng, link tự động (`http(s)`, `rel="noopener noreferrer nofollow ugc"`, dấu chấm cuối câu không dính vào link); `snake_case` và email không bị hiểu nhầm thành in nghiêng/mention, dấu chưa đóng hiện nguyên văn; `@username` được highlight theo đúng bộ ký tự username của backend. 23 test web phủ parser + render (gồm test HTML thô bị escape).

- **Trả lời tin nhắn (reply)**: `POST /channels/:id/messages` nhận `replyToId` (phải là tin **cùng kênh**, sai → 400) và trả về trong `Message.replyToId`; UI có nút ↩ khi hover tin, thanh "Đang trả lời …" phía trên ô soạn (✕ hoặc **Esc** để huỷ), khối trích tin gốc ngay trên nội dung — bấm vào là cuộn tới tin gốc; tin gốc không còn trong trang đã tải/đã bị xoá thì hiện "tin nhắn gốc không còn" thay vì im lặng.
- **Tệp đính kèm** (P0 G1, `services/api/src/uploads/`): `POST /channels/:id/messages` nhận **cả JSON lẫn `multipart/form-data`** trên cùng đường dẫn — text + tối đa **4 tệp × 10MB** (trần đặt ở Fastify `limits` **và** khi ghi đĩa), tin chỉ có tệp (không text) cũng hợp lệ. Cho phép ảnh raster/PDF/text/zip/Office; **chặn `image/svg+xml` + `text/html`** vì file phục vụ từ chính origin API (XSS). Tên tệp bị lọc đường dẫn/ký tự điều khiển; file lưu theo id snowflake (không dùng tên gốc) nên không thể thoát thư mục. `GET /attachments/:id` kiểm `VIEW_CHANNEL` của kênh chứa tin (người ngoài server → **404**, không lộ sự tồn tại) + `nosniff`, CSP `sandbox`, cache `immutable`; ghi DB lỗi thì file bị xoá, xoá tin thì dọn file trên đĩa. Server đọc **`width`/`height` ảnh** từ header (PNG/GIF/JPEG/WebP, tự viết — không thêm dependency) để client giữ đúng tỉ lệ trước khi ảnh tải xong. UI: nút 📎, kéo-thả tệp vào khung chat, **dán ảnh từ clipboard**, chip tệp chờ gửi (bỏ từng cái, hiện dung lượng), lỗi định dạng/quá cỡ hiện ngay, ảnh hiện inline (bấm mở tab mới), tệp khác là chip tải về. Client tải tệp bằng fetch kèm Bearer token → **blob URL** (cache theo token) nên token không bao giờ nằm trong URL/`<img src>`.

- **Kéo-thả sắp xếp sidebar** (`PATCH /channels/:id { position }`): `position` là chỉ số **trong nhóm kênh cùng category** (`parentId` kèm theo nếu thả sang danh mục khác, `null` = gốc) — server renumber lại 0..n cho cả nhóm rồi phát `CHANNEL_UPDATE` cho đúng những kênh đổi vị trí, nên client khác xếp lại ngay không cần tải lại. Chặn `position` không phải số nguyên 0–100000 (400) và category lồng vào category (400); cần `MANAGE_CHANNELS`/owner (403 với thành viên thường). UI: kéo hàng kênh hoặc tiêu đề danh mục, vạch xanh hiện đúng vị trí thả (trước/sau), thả lên tiêu đề danh mục = vào đầu hoặc cuối danh mục; kéo danh mục đổi thứ tự giữa các danh mục; hàng kênh voice vẫn kéo được dù chưa bấm được.

**Chạy sau proxy TLS:** `GET /gateway` trả URL `wss://` khi có `x-forwarded-proto: https` (nếu không, trang https sẽ bị chặn mixed content và gateway im lặng không kết nối). Guard xác thực đọc `Authorization: Bearer` **hoặc** `x-umaru-token` — client web gửi cả hai vì một số reverse proxy bỏ header `Authorization`; khi request tới mà không có token, server log kèm `url` + header nào có mặt để biết ngay là client quên hay proxy nuốt.

**G0:** xong phần kỹ thuật, gồm cả Terms/Privacy EN/VI (bản nháp — cần luật sư rà soát trước public, xem [docs/legal/README.md](docs/legal/README.md)). **CI/CD đã có:** [.github/workflows/ci.yml](.github/workflows/ci.yml) — GitHub Actions chạy `pnpm install --frozen-lockfile` → `typecheck` → `build` → `test` với **PostgreSQL 16** service (test backend chạy trên DB thật, không mock), bước `lint` tự bỏ qua cho tới khi thêm ESLint.

### Giới hạn đã biết của backend hiện tại

- Replay log nằm **trong bộ nhớ của một process** (đúng cho 1 node). Đa node cần Redis Streams theo [ADR-0003](docs/adr/0003-gateway-resume-redis-streams.md) — giao thức không đổi.
- Presence/ephemeral chưa dùng Redis; khởi động lại server làm mất session đang resume.
- Chưa rate limit theo user cho REST (chỉ typing 1/8s), chưa sharding, chưa nén frame.
- Tệp đính kèm lưu **trên đĩa của process API** (đúng cho 1 node) — đa node/CDN cần R2/S3 presign; chưa quét virus, chưa thumbnail/resize, chưa có quota theo user (mới chỉ trần 10MB/tệp và 4 tệp/tin).
- Path param dạng id được kiểm snowflake một lần ở hook `preValidation` trong [app.ts](services/api/src/app.ts) → sai định dạng là **400 `BAD_REQUEST`** thay vì 500 kèm log lỗi DB (chạy trước cả guard xác thực, nên request không token + id sai nhận 400).
- `READY` chưa gửi `voiceStates` (G2); chưa có event đổi thứ tự role/lên cấp role — kéo-thả đổi **cấp** role chưa làm (thứ tự **kênh** thì đã có `CHANNEL_UPDATE` kèm `position`).
- UI hiển thị **ảnh đại diện** ở danh sách DM, khung tin nhắn, tab Mentions/tìm kiếm, panel gán role và người đã chặn (chưa có ảnh đại diện server, banner, bio); chưa có panel liệt kê thành viên đầy đủ (role chỉ hiện trong panel Server Settings), chưa phân quyền ẩn kênh trên sidebar bằng tay (server đã lọc kênh không xem được).
- Chưa có **kéo-thả đổi cấp role** (vẫn chỉ đổi thứ tự role bằng thao tác trong panel); kéo-thả đổi thứ tự kênh/category đã có.
- `PERMISSIONS_UPDATE` được phát từ: tạo/sửa/xoá kênh, tạo guild, nhận invite, mọi thao tác role (sửa/xoá quyền, gán/thu role) và mọi thay đổi overwrite. REST vẫn là nơi kiểm quyền thật — `channelPermissions` chỉ gợi ý ẩn/hiện UI.
- DM chưa gộp nhóm, chưa chặn người lạ nhắn (privacy setting ở P1).

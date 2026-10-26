# Deploy Umaru

Hướng dẫn ngắn, đủ để chạy một node thật. Kiến trúc: **nginx (SPA + proxy) → API
→ PostgreSQL**, tất cả trong `docker-compose.yml`. LiveKit Cloud và dịch vụ push
là dịch vụ ngoài, không nằm trong compose.

```
Internet ──► web (nginx :80) ──► /api/* ──► api (:4000) ──► db (postgres)
                    └──► /usr/share/nginx/html (SPA đã build)
```

Chỉ **web** mở cổng ra ngoài. API và DB nằm trong network nội bộ của compose —
API không bao giờ được phơi trực tiếp ra Internet: nó tin `X-Forwarded-For` khi
`TRUST_PROXY=1`, nên phơi ra là client tự khai IP và vô hiệu hoá rate limit.

## 1. Chuẩn bị

```bash
cp .env.example .env

# Hai biến BẮT BUỘC — compose dừng ngay nếu thiếu:
openssl rand -base64 24   # → POSTGRES_PASSWORD
openssl rand -base64 48   # → JWT_SECRET
```

Điền tiếp theo nhu cầu (xem chú thích trong `.env.example`):

| Biến | Bỏ trống thì sao |
|---|---|
| `PUBLIC_WEB_URL` | link trong mail xác thực trỏ về localhost — mail vô dụng |
| `SMTP_URL` | mail **ghi ra log** (không ai nhận được) — chưa dùng được thật |
| `LIVEKIT_URL/API_KEY/API_SECRET` | âm thanh + chia sẻ màn hình tắt (route token trả 503) |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY` | thông báo đẩy tắt (503) |
| `ADMIN_USERNAMES` | không ai xem được hàng đợi báo cáo |

## 2. Chạy

```bash
docker compose up -d --build
docker compose ps          # migrate phải "exited (0)", api/web "healthy"
curl -s localhost:8080/api/v1/../health   # → {"ok":true,...}
```

Mở `http://localhost:8080`.

**Không muốn build trên máy chủ?** CI build sẵn image cho mỗi lần merge vào `main`
và mỗi tag `v*`, đẩy lên GHCR (`ghcr.io/lxmtuu/umaru/api`, `.../web`). Trên máy
chủ có thể `docker compose pull` thay cho `--build` — nhưng **vẫn phải xem log
lần chạy đầu**, và image cần đăng nhập GHCR nếu repo để private.

`migrate` là container **one-shot** chạy trước `api` (`service_completed_successfully`).
API cũng tự áp migration lúc khởi động với advisory lock, nên chạy lại nhiều lần
hoặc nhiều bản song song vẫn an toàn; `migrate` chỉ để lỗi schema hiện rõ ràng và
để API không phải chờ.

## 3. Ba chỗ đã từng làm hệ thống chết lặng lẽ

Ghi lại vì đây là loại lỗi không có thông báo lỗi nào:

1. **Thiếu `Upgrade`/`Connection` header ở proxy.** HTTP vẫn trả 200, client chờ
   mãi frame `HELLO`, app treo ở "đang kết nối". `deploy/nginx.conf` đã có `map`
   + `proxy_http_version 1.1`; `proxy_read_timeout 1h` phải **lớn hơn** heartbeat
   (41,25 s), nếu không nginx cắt kết nối đang khoẻ và client reconnect liên tục.
2. **`client_max_body_size` mặc định 1MB.** Trần tệp đính kèm là 10MB, avatar
   5MB → upload lớn nhận 413 **từ nginx**, không phải từ API, nên thông điệp lỗi
   không khớp với gì người dùng thấy. Đã đặt 12m (dư cho multipart nhiều tệp).
3. **`TRUST_PROXY` sai.** Đã thử cả hai chiều bằng API thật:
   - `TRUST_PROXY=1` (đúng, có nginx): IP A sai 3 lần → **429**, IP B khác vẫn
     đăng nhập được (401 vì sai mật khẩu). Rate limit tách đúng từng người.
   - Không bật: IP B **cũng bị 429** vì mọi request mang IP của proxy → một kẻ
     tấn công khoá đăng nhập của toàn bộ người dùng.

## 4. TLS

Compose chỉ nói HTTP (:8080). Đặt **Caddy** phía trước để tự lo chứng chỉ:

```caddyfile
umaru.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy tự chuyển tiếp `Upgrade` và `X-Forwarded-*`. Nếu dùng ALB/Cloudflare, nhớ
bật WebSocket (ALB: target group dùng giao thức HTTP/1.1) và đặt
`GATEWAY_PUBLIC_URL=wss://umaru.example.com/api/v1/gateway/ws` cho chắc.

Sau khi có TLS, `PUBLIC_WEB_URL=https://umaru.example.com` để link trong mail đúng.

## 5. Dữ liệu

| Volume | Nội dung | Mất thì sao |
|---|---|---|
| `umaru_db-data` | toàn bộ DB | mất tài khoản, tin nhắn |
| `umaru_uploads` | tệp đính kèm + avatar | ảnh hỏng, tệp 404 (DB vẫn trỏ tới) |

Sao lưu:

```bash
docker compose exec db pg_dump -U umaru umaru | gzip > backup-$(date +%F).sql.gz
docker run --rm -v umaru_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

Mặc định tệp nằm trên đĩa của một node. Chạy nhiều node thì phải chuyển sang
object storage trước (§7), nếu không node nào upload thì node khác 404.

## 6. Trước khi cho người thật dùng

- [ ] **Xoay `LIVEKIT_API_SECRET`** nếu khoá cũ từng xuất hiện trong chat/log.
- [ ] **Sinh lại `VAPID_*`** cho bản production (không dùng khoá dev).
- [ ] `NODE_ENV=production` (compose đã đặt) — API **từ chối khởi động** nếu
      `JWT_SECRET` còn là giá trị dev, đã kiểm bằng cách chạy thật.
- [ ] `ADMIN_USERNAMES` có ít nhất một người.
- [ ] Sao lưu thử một lần và **phục hồi thử** — backup chưa restore thử là chưa
      có backup.
- [ ] Giới hạn `WEB_PORT` bằng firewall nếu đặt Caddy trên cùng máy.

## 7. Lưu tệp: đĩa cục bộ hay S3/R2

Mặc định (không đặt gì) là **đĩa cục bộ**: tệp nằm trong volume `uploads`. Chỉ
đúng khi chạy một node và không xoá volume.

Đặt `STORAGE_DRIVER=s3` để tệp nằm trong object storage tương thích S3 — R2, S3,
MinIO, B2 đều được. Đây là thứ **bắt buộc** trước khi chạy nhiều node, và cũng
là thứ khiến việc thay container không còn làm mất tệp.

```bash
# R2: tạo bucket + API token (Object Read & Write) rồi điền
STORAGE_DRIVER=s3
S3_BUCKET=umaru
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=umaru
```

Bốn biến `S3_BUCKET`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` là
**bắt buộc khi driver là `s3`**: thiếu một biến thì API dừng ngay lúc khởi động
và nói rõ biến nào thiếu. Cố ý không lùi về đĩa cục bộ — lùi im lặng nghĩa là
tệp đi vào volume của container, mất ở lần deploy sau, còn người vận hành thì
tưởng đã bật object storage. `STORAGE_DRIVER` gõ sai (`r2`, `S3`) cũng dừng
ngay thay vì đoán ý.

Quyết định đã chốt trong `services/api/src/uploads/s3.ts`:

- **Path-style URL** (`…/<bucket>/<key>`), không virtual-host: hợp cả R2, MinIO
  và S3, không cần DNS theo bucket.
- **Tải lên buffer trong RAM có trần** (10 MB) để ký được payload hash. Tải
  xuống thì stream thẳng, không nạp cả tệp vào bộ nhớ.
- **API vẫn là nơi kiểm quyền và vẫn stream tệp qua chính nó** (chưa dùng
  presigned URL). Đổi lại: bucket có thể để **private**, không cần cấu hình
  CORS, và huỷ kết bạn/gỡ quyền là mất quyền tải ngay. Cái giá là băng thông tệp
  đi qua API — chấp nhận được ở quy mô này, đổi sang presigned URL khi cần.
- **Không ký `content-length`**; chữ ký có test bằng vector chính thức của AWS
  (`services/api/test/sigv4.test.ts`) và bằng một S3 giả **tính lại chữ ký** từ
  header nhận được (`storage-s3.test.ts`) — lệch là 403, đúng như S3 thật.

Chuyển tệp cũ từ đĩa lên bucket (chưa có script tự động — khoá chỉ là id nên
`rclone`/`aws s3 cp` là đủ):

```bash
docker run --rm -v umaru_uploads:/data -v "$PWD":/w alpine tar czf /w/uploads.tar.gz -C /data .
mkdir -p uploads && tar xzf uploads.tar.gz -C uploads
# tệp đính kèm ở <prefix>/attachments/<id>, avatar ở <prefix>/avatars/<id>
rclone copy uploads/avatars r2:umaru/umaru/avatars
rclone copy uploads r2:umaru/umaru/attachments --exclude "/avatars/**"
```

Sau khi chuyển xong mới đặt `STORAGE_DRIVER=s3`: tệp cũ **không** tự chuyển, chỉ
tệp mới đi vào bucket. Trộn hai nơi thì tệp cũ sẽ 404.

## 8. Giới hạn đã biết của bản deploy này

- **Một node.** Rate limit, session gateway và replay buffer nằm trong bộ nhớ
  process; chạy `--scale api=2` sẽ ra hành vi sai (mỗi node đếm riêng, WebSocket
  của người A không tới được người B). Cần Redis trước khi scale. Riêng **tệp**
  thì đã hết ràng buộc này khi đặt `STORAGE_DRIVER=s3` (§7).
- **Image do CI build, nhưng chỉ một kiến trúc** (`linux/amd64`). Chạy trên
  ARM (Mac M-series, Ampere) sẽ phải build lại. `.github/workflows/docker.yml`
  build cả hai target rồi **chạy thật** container (`scripts/ci-image-smoke.sh`):
  `/health` 200 sau migration, SPA + fallback `/terms`, header `sw.js`, asset
  vào được, **đăng ký tài khoản qua nginx → Fastify → argon2 → Postgres**, và
  **WebSocket nâng cấp 101 qua proxy**. Image chỉ được đẩy lên GHCR **sau khi**
  smoke xanh, nên registry không bao giờ nhận bản chưa từng chạy được.
- **Chưa có `docker compose up` đầu-cuối nào được chạy bởi người viết code**
  (sandbox không có Docker). Thứ đã chạy thật: từng bước `pnpm deploy --legacy`
  ngoài Docker (runtime 25 MB tự chạy, `/health` 200), và toàn bộ kịch bản
  `scripts/ci-image-smoke.sh` chạy với API + web preview thật (mọi bước xanh trừ
  bước `docker inspect` cần container). Phần **chỉ CI kiểm được**: bản thân
  `docker build`, `USER node`, volume `/data/uploads`. Lần `docker compose up
  --build` đầu tiên trên máy chủ vẫn nên xem log.

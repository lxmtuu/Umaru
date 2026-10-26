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

**Chưa có S3/R2**: tệp nằm trên đĩa của một node. Chạy nhiều node thì phải
chuyển sang object storage trước, nếu không node nào upload thì node khác 404.

## 6. Trước khi cho người thật dùng

- [ ] **Xoay `LIVEKIT_API_SECRET`** nếu khoá cũ từng xuất hiện trong chat/log.
- [ ] **Sinh lại `VAPID_*`** cho bản production (không dùng khoá dev).
- [ ] `NODE_ENV=production` (compose đã đặt) — API **từ chối khởi động** nếu
      `JWT_SECRET` còn là giá trị dev, đã kiểm bằng cách chạy thật.
- [ ] `ADMIN_USERNAMES` có ít nhất một người.
- [ ] Sao lưu thử một lần và **phục hồi thử** — backup chưa restore thử là chưa
      có backup.
- [ ] Giới hạn `WEB_PORT` bằng firewall nếu đặt Caddy trên cùng máy.

## 7. Giới hạn đã biết của bản deploy này

- **Một node.** Rate limit, session gateway và replay buffer nằm trong bộ nhớ
  process; chạy `--scale api=2` sẽ ra hành vi sai (mỗi node đếm riêng, WebSocket
  của người A không tới được người B). Cần Redis trước khi scale.
- **Chưa có CI/CD**: pipeline trong `.github/workflows/ci.yml` chỉ typecheck +
  build + test, chưa build/push image. Thêm bước `docker/build-push-action` khi
  có registry.
- **Chưa có `docker build` nào từng chạy** trong môi trường viết code (sandbox
  không có Docker). Những gì đã kiểm: các bước build/`pnpm deploy --legacy` chạy
  đúng ngoài Docker, runtime 25MB tự chạy và trả `/health` 200; luật proxy
  (SPA fallback, cache header, REST, **WebSocket upgrade**) kiểm bằng một proxy
  Node mô phỏng đúng `nginx.conf`. Lần `docker compose up --build` đầu tiên vẫn
  nên chạy trên máy có Docker và xem log.

#!/usr/bin/env bash
# Smoke test cho **image Docker** (không phải bản build trong workspace).
#
# Vì sao cần: `pnpm build && pnpm test` chỉ chứng minh code trong repo chạy được.
# Image có thể vẫn hỏng vì những lý do rất riêng của nó — `pnpm deploy` thiếu
# dependency production, migration không được chép vào image, `USER node` không
# đọc được thư mục upload, nginx thiếu `try_files`, WebSocket không được proxy…
# Tất cả những lỗi đó **chỉ lộ khi container thật sự chạy**, nên phải chạy thật.
#
# Kịch bản dùng chung cho CI và máy dev có Docker:
#   docker network create umaru-ci
#   docker run -d --name api --network umaru-ci --add-host host.docker.internal:host-gateway \
#     -e DATABASE_URL=postgres://umaru:umaru@host.docker.internal:55432/umaru_test \
#     -e JWT_SECRET=ci-only -p 4100:4000 umaru-api:ci
#   docker run -d --name web --network umaru-ci -p 8080:80 umaru-web:ci
#   ./scripts/ci-image-smoke.sh
set -euo pipefail

API_URL=${API_URL:-http://127.0.0.1:4100}
WEB_URL=${WEB_URL:-http://127.0.0.1:8080}
TIMEOUT_SEC=${TIMEOUT_SEC:-90}

fail() {
  echo "✗ $*" >&2
  exit 1
}

ok() {
  echo "✓ $*"
}

# `curl -w '%{http_code}'` trả 000 khi không kết nối được; gộp mọi lỗi mạng về
# một con số để vòng chờ bên dưới không phải phân biệt "chưa lên" và "lỗi".
status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true
}

# ---------------------------------------------------------------------------
# 1. Container sống và DB migration đã chạy
# ---------------------------------------------------------------------------
# API tự áp migration lúc khởi động (services/api/src/server.ts), nên `/health`
# trả 200 tức là đã nối được Postgres **và** schema đã sẵn sàng.
deadline=$((SECONDS + TIMEOUT_SEC))
until [ "$(status "$API_URL/health")" = "200" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "--- log container api (nếu có) ---" >&2
    docker logs api 2>&1 | tail -40 >&2 || true
    fail "API không trả 200 ở /health sau ${TIMEOUT_SEC}s"
  fi
  sleep 2
done
ok "API /health = 200 (đã nối DB + áp migration)"

health=$(curl -sS --max-time 5 "$API_URL/health")
echo "$health" | grep -q '"ok":true' || fail "body /health lạ: $health"
ok "/health trả {\"ok\":true}"

# ---------------------------------------------------------------------------
# 2. nginx phục vụ SPA
# ---------------------------------------------------------------------------
home=$(curl -sS --max-time 5 "$WEB_URL/")
echo "$home" | grep -q 'id="root"' || fail "trang chủ không có <div id=\"root\"> — SPA chưa build?"
ok "GET / trả index.html của SPA"

# F5 ở một route phía client phải trả index.html (try_files), không phải 404.
code=$(status "$WEB_URL/terms")
[ "$code" = "200" ] || fail "GET /terms = $code, mong 200 (SPA fallback hỏng → F5 ra 404)"
ok "GET /terms = 200 (SPA fallback)"

# Service worker **không** được cache: bản cũ sẽ tiếp tục phục vụ logic push cũ.
sw_headers=$(curl -sSI --max-time 5 "$WEB_URL/sw.js")
echo "$sw_headers" | grep -qi 'cache-control:.*no-cache' \
  || fail "sw.js thiếu Cache-Control: no-cache (service worker cũ sẽ bám mãi)"
ok "sw.js có Cache-Control: no-cache"

# Asset do Vite sinh tên có hash → phải cache vĩnh viễn được.
asset=$(echo "$home" | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1 || true)
if [ -n "$asset" ]; then
  code=$(status "$WEB_URL$asset")
  [ "$code" = "200" ] || fail "asset $asset = $code (index.html trỏ tới file không tồn tại → trắng trang)"
  ok "asset $asset phục vụ được"
else
  fail "index.html không trỏ tới asset .js nào — bản build web có vẻ rỗng"
fi

# ---------------------------------------------------------------------------
# 3. nginx proxy /api → api, đầu-cuối qua DB
# ---------------------------------------------------------------------------
# Đăng ký thật là phép thử mạnh nhất: đi qua nginx, Fastify, argon2 (native
# module — thứ dễ gãy nhất khi `pnpm deploy` thiếu dependency) và một INSERT.
suffix="$(date +%s)$RANDOM"
body=$(cat <<JSON
{"username":"ci$suffix","displayName":"CI $suffix","email":"ci$suffix@example.com",
 "password":"mat-khau-ci-123","acceptedTerms":true}
JSON
)
register=$(curl -sS --max-time 20 -X POST "$WEB_URL/api/v1/auth/register" \
  -H 'content-type: application/json' -d "$body" -w '\n%{http_code}')
reg_code=$(echo "$register" | tail -1)
reg_body=$(echo "$register" | sed '$d')
[ "$reg_code" = "201" ] || fail "POST /api/v1/auth/register qua nginx = $reg_code: $reg_body"
ok "đăng ký qua nginx = 201 (proxy /api + argon2 + DB đều ổn)"

token=$(echo "$reg_body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("accessToken",""))')
[ -n "$token" ] || fail "response đăng ký không có accessToken"
me_code=$(status -H "authorization: Bearer $token" "$WEB_URL/api/v1/users/@me")
[ "$me_code" = "200" ] || fail "GET /api/v1/users/@me = $me_code, mong 200"
ok "GET /users/@me = 200 (token hợp lệ, đọc được user vừa tạo)"

# ---------------------------------------------------------------------------
# 4. WebSocket gateway đi qua nginx (nâng cấp 101)
# ---------------------------------------------------------------------------
# Đây là cấu hình dễ hỏng nhất của nginx: thiếu `proxy_set_header Upgrade` thì
# nginx trả **200** và client chờ frame HELLO mãi mãi — app treo ở "đang kết nối"
# mà log server không có lỗi nào.
ws_code=$(curl -s -o /tmp/ci-ws.out -w '%{http_code}' --max-time 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$WEB_URL/api/v1/gateway/ws" || true)
[ "$ws_code" = "101" ] || fail "WS qua nginx = $ws_code, mong 101 (client sẽ treo ở 'đang kết nối')"
ok "WebSocket /api/v1/gateway/ws = 101 (upgrade được proxy)"

# ---------------------------------------------------------------------------
# 5. Image không chạy bằng root
# ---------------------------------------------------------------------------
# `USER node` trong Dockerfile: nếu mất, container chạy root và lỗ hổng leo
# thang đặc quyền trong container thành toàn bộ máy host.
api_user=$(docker inspect -f '{{.Config.User}}' api 2>/dev/null || echo "")
[ "$api_user" = "node" ] || fail "container api chạy user '$api_user', mong 'node'"
ok "container api chạy bằng user node"

echo
echo "Tất cả kiểm tra image đều xanh."

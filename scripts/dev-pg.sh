#!/usr/bin/env bash
# Dựng PostgreSQL nhúng cho dev/QA — không cần apt, không cần Docker.
#
# Vì sao có script này: sandbox dev không có PostgreSQL hệ thống và không cài
# được bằng apt. Wheel `pgserver` trên PyPI chứa sẵn binary PostgreSQL 16 đã
# build tĩnh, nên chỉ cần tải wheel → giải nén → `initdb`. (Không dùng
# `pgserver.get_server()` vì nó tự quản lý vòng đời, khó ghép vào script.)
#
#   scripts/dev-pg.sh up      # tạo cluster (lần đầu) + start ở cổng 55432
#   scripts/dev-pg.sh down    # dừng
#   scripts/dev-pg.sh status  # kiểm tra
#   scripts/dev-pg.sh reset    # xoá sạch cluster rồi dựng lại (mất dữ liệu)
#
# Dữ liệu nằm ở `.cache/dev-pg/` (đã gitignore) — không commit, không đụng
# tới `db/migrations`. Chuỗi kết nối mặc định:
#   postgres://umaru:umaru@127.0.0.1:55432/umaru        (dev)
#   postgres://umaru:umaru@127.0.0.1:55432/umaru_test   (test, do helpers.ts dùng)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$ROOT/.cache/dev-pg"
BIN="$CACHE/bin"
PGDATA="$CACHE/data"
PORT="${UMARU_PG_PORT:-55432}"
SOCK="/tmp/umaru-pg-sock"
LOG="$CACHE/postgres.log"

need_bin() { [ -x "$BIN/postgres" ] && [ -x "$BIN/initdb" ]; }

bootstrap() {
  need_bin && return 0
  echo "→ tải binary PostgreSQL 16 từ wheel pgserver (PyPI)…"
  mkdir -p "$CACHE"
  local whl_dir="$CACHE/wheel"
  rm -rf "$whl_dir"; mkdir -p "$whl_dir"
  python3 -m pip download pgserver --no-deps --only-binary :all: \
    --python-version "$(python3 -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")')" \
    -d "$whl_dir" >/dev/null
  local whl; whl="$(ls "$whl_dir"/*.whl | head -1)"
  local ex="$CACHE/extract"
  rm -rf "$ex"; mkdir -p "$ex"
  python3 - "$whl" "$ex" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  rm -rf "$BIN"
  cp -r "$ex"/pgserver/pginstall/bin "$BIN"
  chmod +x "$BIN"/*
  echo "→ xong: $("$BIN/postgres" --version)"
}

is_up() { "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; }

init_cluster() {
  [ -f "$PGDATA/PG_VERSION" ] && return 0
  echo "→ initdb $PGDATA"
  mkdir -p "$CACHE"
  "$BIN/initdb" -U umaru -D "$PGDATA" --auth=trust -E UTF8 >/dev/null
  # Cho phép nhiều kết nối song song (test chạy tuần tự nhưng nhiều pool).
  printf 'max_connections = 200\nfsync = off\nsynchronous_commit = off\n' >>"$PGDATA/postgresql.conf"
}

start() {
  if is_up; then echo "✓ PostgreSQL đã chạy ở cổng $PORT"; return 0; fi
  bootstrap
  init_cluster
  mkdir -p "$SOCK"
  "$BIN/pg_ctl" -D "$PGDATA" -l "$LOG" \
    -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" start >/dev/null
  for _ in $(seq 1 30); do is_up && break; sleep 0.3; done
  is_up || { echo "✗ không khởi động được, xem $LOG"; tail -20 "$LOG"; exit 1; }
  # Hai database: `umaru` cho dev, `umaru_test` cho test của services/api
  # (xem TEST_DATABASE_URL trong services/api/test/helpers.ts).
  for db in umaru umaru_test; do
    "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U umaru -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
      || "$BIN/createdb" -h 127.0.0.1 -p "$PORT" -U umaru "$db"
  done
  echo "✓ PostgreSQL sẵn sàng: postgres://umaru:umaru@127.0.0.1:$PORT/umaru"
}

case "${1:-up}" in
  up)     start ;;
  down)   if is_up; then "$BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null; echo "✓ đã dừng"; else echo "• chưa chạy"; fi ;;
  status) if is_up; then "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT"; else echo "• chưa chạy"; fi ;;
  reset)  if is_up; then "$BIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null || true; fi
          rm -rf "$PGDATA"; start ;;
  *) echo "dùng: $0 {up|down|status|reset}" >&2; exit 2 ;;
esac

# syntax=docker/dockerfile:1.7

# Umaru — một Dockerfile, hai target:
#   api  → Node 22 chạy API (Fastify) đã build
#   web  → nginx phục vụ SPA đã build + proxy /api sang service `api`
#
# Vì sao gộp: hai bên dùng chung workspace pnpm (`@umaru/protocol`, `@umaru/sdk`)
# nên tách repo/context sẽ phải build lại phần chung. `--target` cho phép build
# từng cái, và `docker compose build` build song song.
#
# Vì sao `node:22-bookworm-slim` chứ không alpine: `@node-rs/argon2` là native
# module dùng prebuilt glibc; trên musl phải tự build với toolchain Rust, làm
# image to ra vài trăm MB và hỏng khi mạng chậm.

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------------------
# 1. Base: bật pnpm qua corepack, đúng version trong package.json
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    # pnpm 10 chặn build script của dependency; argon2 cần chạy script cài.
    PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true \
    CI=true
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# 2. Dependencies: chỉ manifest + lockfile → tận dụng cache layer
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sdk/package.json packages/sdk/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 3. Build: biên dịch protocol → sdk → api/web
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @umaru/protocol build \
 && pnpm --filter @umaru/sdk build \
 && pnpm --filter @umaru/api build \
 && pnpm --filter @umaru/web build

# ---------------------------------------------------------------------------
# 4. api: chỉ giữ dependency production của service api
# ---------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production

COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /app/services/api/package.json services/api/package.json
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/services/api/dist services/api/dist

# Migration luôn nằm ngoài image code để có thể áp bản mới mà không build lại.
COPY db/migrations /app/db/migrations

# `pnpm deploy` gom đúng dependency production của service api (kể cả `workspace:*`)
# vào một thư mục tự chứa, có `node_modules` phẳng — chép tay `node_modules` của
# pnpm là chuỗi symlink trỏ ra store, sang stage khác là gãy hết.
#
# `--legacy` vì workspace này không bật `inject-workspace-packages`; pnpm 10 yêu
# cầu một trong hai. Đã chạy thử cách này ngoài Docker: runtime 25MB tự chạy được.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @umaru/api deploy --prod --legacy /app/runtime

WORKDIR /app/runtime
ENV PORT=4000 \
    HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/db/migrations \
    UPLOADS_DIR=/data/uploads

# Thư mục upload phải là volume: file đính kèm và avatar nằm trên đĩa, container
# bị thay là mất sạch nếu không mount.
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 4000

# `GET /health` **không** nằm dưới /api/v1 (xem services/api/src/app.ts).
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------------------
# 5. web: nginx phục vụ file tĩnh + proxy /api (kể cả WebSocket)
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS web
# Cấu hình đã tính sẵn ba chỗ dễ hỏng: WebSocket upgrade, SPA fallback và trần
# body 10MB cho tệp đính kèm (mặc định nginx là 1MB → mọi upload lớn đều 413).
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

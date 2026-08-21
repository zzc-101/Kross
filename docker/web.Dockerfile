FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
COPY frontend/web/package.json web/package.json
COPY frontend/admin-web/package.json admin-web/package.json
RUN pnpm install --frozen-lockfile
COPY frontend/tsconfig.base.json ./
COPY frontend/web web
COPY frontend/admin-web admin-web
RUN pnpm --filter web build && pnpm --filter admin-web build

FROM nginx:1.27-alpine AS runtime
COPY docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY --from=build /app/admin-web/dist /usr/share/nginx/html/admin
EXPOSE 8787

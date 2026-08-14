FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/web/package.json web/package.json
COPY frontend/admin-web/package.json admin-web/package.json
RUN npm ci
COPY frontend/tsconfig.base.json ./
COPY frontend/web web
RUN npm run build -w web

FROM nginx:1.27-alpine AS runtime
COPY docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8787

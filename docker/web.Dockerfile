FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY packages/protocol packages/protocol
COPY packages/web packages/web
RUN npm run --workspace @kross/web build

FROM nginx:1.27-alpine AS runtime
COPY docker/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 8787

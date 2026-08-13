FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/work-domain/package.json packages/work-domain/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
RUN npm ci
COPY packages/protocol packages/protocol
COPY packages/work-domain packages/work-domain
COPY apps/admin-web apps/admin-web
RUN npm run --workspace @kross/admin-web build

FROM nginx:1.27-alpine AS runtime
COPY docker/admin-web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin-web/dist /usr/share/nginx/html
EXPOSE 8788

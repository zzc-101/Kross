FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run --workspace @kross/web build
EXPOSE 8787
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]

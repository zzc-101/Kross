FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci
COPY scripts/build-cloud-runtime.mjs scripts/build-cloud-runtime.mjs
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/server packages/server
RUN node scripts/build-cloud-runtime.mjs server build/server.mjs

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev --include-workspace-root=false --workspace @kross/server \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/node_modules node_modules
COPY --from=build /app/build/server.mjs dist/server.mjs
EXPOSE 8787
CMD ["node", "dist/server.mjs"]

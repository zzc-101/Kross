FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm ci
COPY scripts/build-cloud-runtime.mjs scripts/build-cloud-runtime.mjs
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/worker packages/worker
RUN node scripts/build-cloud-runtime.mjs worker build/worker.mjs

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm ci --omit=dev --include-workspace-root=false --workspace @kross/worker \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh ca-certificates openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps /app/node_modules node_modules
COPY --from=build /app/build/worker.mjs dist/worker.mjs
USER node
EXPOSE 8788
CMD ["node", "dist/worker.mjs"]

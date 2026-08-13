FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/work-domain/package.json packages/work-domain/package.json
COPY packages/work-runtime/package.json packages/work-runtime/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci
COPY scripts/build-cloud-runtime.mjs scripts/build-cloud-runtime.mjs
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/work-domain packages/work-domain
COPY packages/work-runtime packages/work-runtime
COPY apps/worker apps/worker
RUN node scripts/build-cloud-runtime.mjs worker build/worker.mjs

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/work-domain/package.json packages/work-domain/package.json
COPY packages/work-runtime/package.json packages/work-runtime/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --omit=dev --include-workspace-root=false --workspace @kross/worker \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /work
RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh ca-certificates openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps /app/node_modules node_modules
COPY --from=build /app/build/worker.mjs /app/dist/worker.mjs
USER node
CMD ["node", "/app/dist/worker.mjs"]

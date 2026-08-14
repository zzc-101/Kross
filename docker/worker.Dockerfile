FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY worker/package.json worker/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY worker/ .
RUN node scripts/build-runtime.mjs build/worker.mjs

FROM node:22-bookworm-slim AS production-deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY worker/package.json worker/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /work
RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh ca-certificates openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps /app/node_modules /app/node_modules
COPY --from=build /app/build/worker.mjs /app/dist/worker.mjs
USER node
CMD ["node", "/app/dist/worker.mjs"]

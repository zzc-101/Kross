FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY worker/package.json worker/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY worker/ .
RUN node scripts/build-runtime.mjs build/worker.mjs

FROM node:22-alpine AS native
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY worker/package.json worker/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod \
  && mkdir -p /native/better-sqlite3 \
  && cp -aL node_modules/better-sqlite3/. /native/better-sqlite3/

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /work
# git/ssh for Git tools; ripgrep is on PATH so the image need not ship @vscode/ripgrep.
# GitHub CLI is omitted: the Git tool shells out to git, and debian `gh` added ~100MB.
RUN apk add --no-cache git openssh-client ripgrep su-exec ca-certificates \
  && rm -rf /var/cache/apk/*
COPY --from=build /app/build/worker.mjs /app/dist/worker.mjs
COPY --from=native /native/better-sqlite3 /app/node_modules/better-sqlite3
COPY docker/worker-entrypoint.sh /usr/local/bin/kross-worker-entrypoint
RUN chmod +x /usr/local/bin/kross-worker-entrypoint
ENTRYPOINT ["/usr/local/bin/kross-worker-entrypoint"]
CMD ["node", "/app/dist/worker.mjs"]

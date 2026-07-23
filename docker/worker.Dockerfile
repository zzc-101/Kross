FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git gh ripgrep ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/worker/package.json packages/worker/package.json
RUN npm ci
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/worker packages/worker
USER node
EXPOSE 8788
CMD ["node", "--import", "tsx", "packages/worker/src/main.ts"]

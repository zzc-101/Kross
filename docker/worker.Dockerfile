FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci
COPY worker/ .
RUN node scripts/build-runtime.mjs build/worker.mjs

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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

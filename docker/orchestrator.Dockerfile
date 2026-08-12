FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/work-domain/package.json packages/work-domain/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
RUN npm ci
COPY scripts/build-cloud-runtime.mjs scripts/build-cloud-runtime.mjs
COPY packages/protocol packages/protocol
COPY packages/work-domain packages/work-domain
COPY packages/orchestrator packages/orchestrator
RUN node scripts/build-cloud-runtime.mjs orchestrator build/orchestrator.mjs

FROM node:22-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/work-domain/package.json packages/work-domain/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
RUN npm ci --omit=dev --include-workspace-root=false --workspace @kross/orchestrator \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /app/node_modules node_modules
COPY --from=build /app/build/orchestrator.mjs dist/orchestrator.mjs
EXPOSE 8790
CMD ["node", "dist/orchestrator.mjs"]

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS build
RUN find apps packages -name "*.tsbuildinfo" -delete && rm -rf apps/*/dist packages/*/dist
RUN pnpm --filter @codex-memory/shared build \
  && pnpm --filter @codex-memory/core build \
  && pnpm --filter @codex-memory/providers build \
  && pnpm --filter @codex-memory/db build \
  && pnpm --filter @codex-memory/worker build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "apps/worker/dist/index.js"]

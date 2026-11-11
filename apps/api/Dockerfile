FROM node:22-alpine AS base
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS build
RUN find apps packages -name "*.tsbuildinfo" -delete && rm -rf apps/*/dist packages/*/dist
RUN pnpm --filter @koed-labs/shared build \
  && pnpm --filter @koed-labs/core build \
  && pnpm --filter @koed-labs/db build \
  && pnpm --filter @koed-labs/mcp-server build \
  && pnpm --filter @koed-labs/api build
RUN pnpm --filter @koed-labs/api deploy --legacy --prod /deploy/api
RUN cd /deploy/api && node --input-type=module -e "await import('./dist/managed-conversations/routes.js')"

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /deploy/api ./
USER node
EXPOSE 3300
CMD ["node", "dist/index.js"]

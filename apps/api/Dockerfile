FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS build
RUN find apps packages -name "*.tsbuildinfo" -delete && rm -rf apps/*/dist packages/*/dist
RUN pnpm --filter @koed/shared build \
  && pnpm --filter @koed/core build \
  && pnpm --filter @koed/db build \
  && pnpm --filter @koed/api build
RUN pnpm --filter @koed/api deploy --legacy --prod /deploy/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /deploy/api ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && find apps packages -name "*.tsbuildinfo" -delete \
  && rm -rf apps/*/dist packages/*/dist \
  && pnpm --filter @koed/shared build \
  && pnpm --filter @koed/privacy-service build \
  && pnpm --filter @koed/privacy-service deploy --legacy --prod /deploy/privacy-service

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  PRIVACY_SERVICE_HOST=0.0.0.0 \
  PRIVACY_SERVICE_PORT=8092

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /deploy/privacy-service ./

USER node

EXPOSE 8092

CMD ["node", "dist/index.js"]

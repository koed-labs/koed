FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @koed/shared build \
  && pnpm --filter @koed/core build \
  && pnpm --filter @koed/db build \
  && pnpm --filter @koed/api build \
  && pnpm --filter @koed/worker build \
  && pnpm --filter @koed/mcp-server build \
  && pnpm --filter @koed/explorer build \
  && pnpm --filter @koed/koed-server build

ENV KOED_HOME=/data/koed
ENV KOED_REPO_ROOT=/app
ENV KOED_RUNTIME_MODE=external
ENV KOED_DEPENDENCY_MODE=external
ENV API_HOST=0.0.0.0
ENV API_HOST_PORT=3300
ENV EXPLORER_WEB_HOST=0.0.0.0
ENV EXPLORER_WEB_HOST_PORT=5174

EXPOSE 3300 5174

CMD ["node", "packages/koed-server/dist/cli.js", "start"]

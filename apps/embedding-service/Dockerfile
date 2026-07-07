FROM ghcr.io/ggml-org/llama.cpp:server@sha256:c01037625b2dbac36439a76f2b6fa6e99c911b25e702414307520f37bed0c58d AS llama-server

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @koed/embedding-service build \
  && pnpm --filter @koed/embedding-service deploy --legacy --prod /deploy/embedding-service

FROM node:22-trixie-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8000 \
  MODEL_KEY=qwen3-0.6b \
  EMBEDDING_BATCH_LIMIT=16 \
  EMBEDDING_MAX_TOKENS=4096 \
  LLAMA_N_CTX=32768 \
  LLAMA_SERVER_BINARY=/opt/llama.cpp/llama-server \
  LD_LIBRARY_PATH=/opt/llama.cpp

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 libopenblas0-pthread \
  && rm -rf /var/lib/apt/lists/*

COPY --from=llama-server /app /opt/llama.cpp
COPY --from=build --chown=node:node /deploy/embedding-service ./

USER node

EXPOSE 8000

CMD ["node", "dist/index.js"]

FROM ghcr.io/ggml-org/llama.cpp:server@sha256:57e505f69c3a55fa5dd9c15fced47cff7a899f5b5b504ea93d75b2f401b87830 AS llama-server

FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && find apps packages -name "*.tsbuildinfo" -delete \
  && rm -rf apps/*/dist packages/*/dist \
  && pnpm --filter @koed/shared build \
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
  KOED_EMBEDDING_ACCELERATION=cpu \
  KOED_EMBEDDING_GPU_IDLE_UNLOAD_SECONDS=300 \
  KOED_RERANKER_ACCELERATION=cpu \
  KOED_RERANKER_GPU_IDLE_UNLOAD_SECONDS=300 \
  KOED_EMBEDDING_RUNTIME_VERSION=sha256:57e505f69c3a55fa5dd9c15fced47cff7a899f5b5b504ea93d75b2f401b87830 \
  LD_LIBRARY_PATH=/opt/llama.cpp

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 libopenblas0-pthread \
  && rm -rf /var/lib/apt/lists/*

COPY --from=llama-server /app /opt/llama.cpp
COPY --from=build --chown=node:node /deploy/embedding-service ./

USER node

EXPOSE 8000

CMD ["node", "dist/index.js"]

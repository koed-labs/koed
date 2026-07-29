#!/usr/bin/env bash
set -euo pipefail

MODEL_VOLUME="${MODEL_VOLUME:-koed-self-hosted_embedding-model-cache}"
ADAPTER_IMAGE="${ADAPTER_IMAGE:-koed-self-hosted-embedding-service:latest}"
LEGACY_RERANK_IMAGE="${LEGACY_RERANK_IMAGE:-}"
LLAMA_IMAGE="${LLAMA_IMAGE:-ghcr.io/ggml-org/llama.cpp:server}"
RERANKER_MODEL_PATH="${RERANKER_MODEL_PATH:-}"
DOCUMENT_COUNTS="${DOCUMENT_COUNTS:-10 25}"
REQUESTS_PER_SCENARIO="${REQUESTS_PER_SCENARIO:-3}"
THREADS="${THREADS:-8}"
CONCURRENCY="${CONCURRENCY:-1 2}"
RERANKER_CONTEXT_PER_SLOT="${RERANKER_CONTEXT_PER_SLOT:-8192}"
RERANKER_BATCH_SIZE="${RERANKER_BATCH_SIZE:-8192}"
RERANKER_UBATCH_SIZE="${RERANKER_UBATCH_SIZE:-8192}"
RERANKER_PARALLEL="${RERANKER_PARALLEL:-4}"
RERANKER_PROMPT_CACHE_ENABLED="${RERANKER_PROMPT_CACHE_ENABLED:-true}"
OUTPUT_DIR="${OUTPUT_DIR:-benchmarks/embedding-service/artifacts/rerank-$(date +%s)}"

mkdir -p "$OUTPUT_DIR"

cleanup() {
  docker rm -f koed-embedding-benchmark-rerank-adapter koed-embedding-benchmark-rerank-legacy koed-embedding-benchmark-rerank-llama >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_http() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 180); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "$name did not become ready" >&2
  docker logs "koed-embedding-benchmark-rerank-$name" --tail 160 >&2 || true
  return 1
}

run_current_adapter() {
  local threads="$1"
  docker rm -f koed-embedding-benchmark-rerank-adapter >/dev/null 2>&1 || true
  docker run -d --name koed-embedding-benchmark-rerank-adapter \
    -p 18100:8000 \
    -v "$MODEL_VOLUME":/root/.cache/huggingface \
    -e MODEL_KEY=qwen3-0.6b \
    -e RERANKER_KEY=qwen3-reranker-0.6b \
    -e EMBEDDING_SERVICE_TOKEN= \
    -e LLAMA_N_CTX=32768 \
    -e LLAMA_N_THREADS="$threads" \
    -e LLAMA_N_BATCH=8192 \
    -e LLAMA_N_UBATCH=8192 \
    -e LLAMA_PARALLEL=1 \
    -e RERANKER_CONTEXT_PER_SLOT="$RERANKER_CONTEXT_PER_SLOT" \
    -e RERANKER_LLAMA_N_THREADS="$threads" \
    -e RERANKER_LLAMA_N_BATCH="$RERANKER_BATCH_SIZE" \
    -e RERANKER_LLAMA_N_UBATCH="$RERANKER_UBATCH_SIZE" \
    -e RERANKER_PARALLEL="$RERANKER_PARALLEL" \
    -e RERANKER_PROMPT_CACHE_ENABLED="$RERANKER_PROMPT_CACHE_ENABLED" \
    "$ADAPTER_IMAGE" >/dev/null
  wait_http http://127.0.0.1:18100/health adapter

  echo "runtime=adapter-rerank threads=$threads docs=[$DOCUMENT_COUNTS] concurrency=[$CONCURRENCY]"
  python3 benchmarks/embedding-service/rerank_runtime_benchmark.py \
    --endpoint "adapter-rerank-t${threads}-p${RERANKER_PARALLEL}-cache${RERANKER_PROMPT_CACHE_ENABLED},koed-rerank,http://127.0.0.1:18100/rerank,qwen3-reranker-0.6b" \
    --document-counts $DOCUMENT_COUNTS \
    --concurrency $CONCURRENCY \
    --requests-per-scenario "$REQUESTS_PER_SCENARIO" \
    --output-dir "$OUTPUT_DIR" \
    --timeout 900
}

run_legacy_adapter() {
  if [ -z "$LEGACY_RERANK_IMAGE" ]; then
    return 0
  fi
  local threads="$1"
  docker rm -f koed-embedding-benchmark-rerank-legacy >/dev/null 2>&1 || true
  docker run -d --name koed-embedding-benchmark-rerank-legacy \
    -p 18102:8000 \
    -v "$MODEL_VOLUME":/root/.cache/huggingface \
    -e MODEL_KEY=qwen3-0.6b \
    -e RERANKER_KEY=qwen3-reranker-0.6b \
    -e EMBEDDING_SERVICE_TOKEN= \
    -e LLAMA_N_CTX=32768 \
    -e LLAMA_N_THREADS="$threads" \
    "$LEGACY_RERANK_IMAGE" >/dev/null
  wait_http http://127.0.0.1:18102/health legacy

  echo "runtime=legacy-rerank threads=$threads docs=[$DOCUMENT_COUNTS] concurrency=[$CONCURRENCY]"
  python3 benchmarks/embedding-service/rerank_runtime_benchmark.py \
    --endpoint "legacy-rerank-t${threads},koed-rerank,http://127.0.0.1:18102/rerank,qwen3-reranker-0.6b" \
    --document-counts $DOCUMENT_COUNTS \
    --concurrency $CONCURRENCY \
    --requests-per-scenario "$REQUESTS_PER_SCENARIO" \
    --output-dir "$OUTPUT_DIR" \
    --timeout 900
}

run_raw_llama() {
  if [ -z "$RERANKER_MODEL_PATH" ]; then
    return 0
  fi
  local threads="$1"
  local concurrency="$2"
  local reranker_ctx=$((RERANKER_CONTEXT_PER_SLOT * RERANKER_PARALLEL))
  docker rm -f koed-embedding-benchmark-rerank-llama >/dev/null 2>&1 || true
  local cache_args=()
  if [ "$RERANKER_PROMPT_CACHE_ENABLED" != "true" ]; then
    cache_args=(--no-cache-prompt --cache-ram 0)
  fi
  docker run -d --name koed-embedding-benchmark-rerank-llama \
    -p 18180:8080 \
    -v "$MODEL_VOLUME":/root/.cache/huggingface:ro \
    -e LLAMA_ARG_UI=false \
    "$LLAMA_IMAGE" \
    --model "$RERANKER_MODEL_PATH" \
    --embedding \
    --pooling rank \
    --reranking \
    --ctx-size "$reranker_ctx" \
    --threads "$threads" \
    --threads-batch "$threads" \
    --batch-size "$RERANKER_BATCH_SIZE" \
    --ubatch-size "$RERANKER_UBATCH_SIZE" \
    --parallel "$RERANKER_PARALLEL" \
    --n-gpu-layers 0 \
    --host 0.0.0.0 \
    --port 8080 \
    "${cache_args[@]}" \
    --log-disable >/dev/null
  wait_http http://127.0.0.1:18180/health llama

  echo "runtime=raw-llama-rerank threads=$threads parallel=$concurrency docs=[$DOCUMENT_COUNTS]"
  python3 benchmarks/embedding-service/rerank_runtime_benchmark.py \
    --endpoint "llama-rerank-t${threads}-p${RERANKER_PARALLEL}-cache${RERANKER_PROMPT_CACHE_ENABLED},llama-rerank,http://127.0.0.1:18180/v1/rerank,qwen3-reranker-0.6b" \
    --document-counts $DOCUMENT_COUNTS \
    --concurrency "$concurrency" \
    --requests-per-scenario "$REQUESTS_PER_SCENARIO" \
    --output-dir "$OUTPUT_DIR" \
    --timeout 900
}

echo "Writing rerank artifacts to $OUTPUT_DIR"
echo "Matrix: threads=[$THREADS], concurrency=[$CONCURRENCY], document_counts=[$DOCUMENT_COUNTS]"
echo "Reranker geometry: context_per_slot=$RERANKER_CONTEXT_PER_SLOT, parallel=$RERANKER_PARALLEL, batch=$RERANKER_BATCH_SIZE, ubatch=$RERANKER_UBATCH_SIZE, prompt_cache=$RERANKER_PROMPT_CACHE_ENABLED"

for threads in $THREADS; do
  run_legacy_adapter "$threads"
  run_current_adapter "$threads"
done

docker rm -f koed-embedding-benchmark-rerank-adapter koed-embedding-benchmark-rerank-legacy >/dev/null 2>&1 || true

for threads in $THREADS; do
  for concurrency in $CONCURRENCY; do
    run_raw_llama "$threads" "$concurrency"
  done
done

echo "Done. Raw JSON artifacts are in $OUTPUT_DIR"

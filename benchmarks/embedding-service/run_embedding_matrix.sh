#!/usr/bin/env bash
set -euo pipefail

MODEL_VOLUME="${MODEL_VOLUME:-koed-self-hosted_embedding-model-cache}"
ADAPTER_IMAGE="${ADAPTER_IMAGE:-koed-self-hosted-embedding-service:latest}"
SIZES="${SIZES:-${SIZE:-512 1024 2048 4096 8192}}"
REQUESTS_PER_SCENARIO="${REQUESTS_PER_SCENARIO:-4}"
THREADS="${THREADS:-2 4 8 16}"
CONCURRENCY="${CONCURRENCY:-1 2 4 8}"
FIXTURE_MODE="${FIXTURE_MODE:-realistic}"
ADAPTER_LLAMA_N_BATCH="${ADAPTER_LLAMA_N_BATCH:-8192}"
ADAPTER_LLAMA_BATCH_TOKEN_HEADROOM="${ADAPTER_LLAMA_BATCH_TOKEN_HEADROOM:-8}"
ADAPTER_LLAMA_N_UBATCH="${ADAPTER_LLAMA_N_UBATCH:-8192}"
ADAPTER_EMBEDDING_MAX_TOKENS="${ADAPTER_EMBEDDING_MAX_TOKENS:-8000}"
OUTPUT_DIR="${OUTPUT_DIR:-benchmarks/embedding-service/artifacts/embedding-$(date +%s)}"

mkdir -p "$OUTPUT_DIR"

cleanup() {
  docker rm -f koed-embedding-benchmark-adapter >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_http() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "$name did not become ready" >&2
  docker logs "koed-embedding-benchmark-$name" --tail 120 >&2 || true
  return 1
}

run_adapter() {
  local threads="$1"
  docker rm -f koed-embedding-benchmark-adapter >/dev/null 2>&1 || true
  docker run -d --name koed-embedding-benchmark-adapter \
    -p 18000:8000 \
    -v "$MODEL_VOLUME":/root/.cache/huggingface \
    -e MODEL_KEY=qwen3-0.6b \
    -e EMBEDDING_BATCH_LIMIT=16 \
    -e EMBEDDING_MAX_TOKENS="$ADAPTER_EMBEDDING_MAX_TOKENS" \
    -e EMBEDDING_MAX_TEXT_CHARS=200000 \
    -e EMBEDDING_MAX_REQUEST_CHARS=1000000 \
    -e EMBEDDING_SERVICE_TOKEN= \
    -e RERANKER_KEY= \
    -e LLAMA_N_CTX=32768 \
    -e LLAMA_N_THREADS="$threads" \
    -e LLAMA_N_BATCH="$ADAPTER_LLAMA_N_BATCH" \
    -e LLAMA_BATCH_TOKEN_HEADROOM="$ADAPTER_LLAMA_BATCH_TOKEN_HEADROOM" \
    -e LLAMA_N_UBATCH="$ADAPTER_LLAMA_N_UBATCH" \
    -e LLAMA_PARALLEL=1 \
    "$ADAPTER_IMAGE" >/dev/null
  wait_http http://127.0.0.1:18000/health adapter

  echo "runtime=adapter threads=$threads concurrency=[$CONCURRENCY] sizes=[$SIZES]"
  python3 benchmarks/embedding-service/embedding_runtime_benchmark.py \
    --endpoint "adapter-t${threads},koed,http://127.0.0.1:18000/embed,qwen3-0.6b" \
    --sizes $SIZES \
    --concurrency $CONCURRENCY \
    --requests-per-scenario "$REQUESTS_PER_SCENARIO" \
    --fixture-mode "$FIXTURE_MODE" \
    --output-dir "$OUTPUT_DIR" \
    --timeout 900
}

echo "Writing embedding artifacts to $OUTPUT_DIR"
echo "Matrix: threads=[$THREADS], concurrency=[$CONCURRENCY], sizes=[$SIZES], fixture_mode=$FIXTURE_MODE"
echo "Koed adapter: LLAMA_N_BATCH=$ADAPTER_LLAMA_N_BATCH, LLAMA_BATCH_TOKEN_HEADROOM=$ADAPTER_LLAMA_BATCH_TOKEN_HEADROOM, LLAMA_N_UBATCH=$ADAPTER_LLAMA_N_UBATCH, EMBEDDING_MAX_TOKENS=$ADAPTER_EMBEDDING_MAX_TOKENS"

for threads in $THREADS; do
  run_adapter "$threads"
done

echo "Done. Raw JSON artifacts are in $OUTPUT_DIR"

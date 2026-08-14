# Embedding Service

Local adapter for llama-server embeddings and optional reranking.

The bundled-local supervisor launches the TypeScript implementation in `src/`.

The Embedding Service is intended to run as a private backend component. Set
`EMBEDDING_SERVICE_TOKEN` in shared deployments; `/embed` and `/rerank` then
require API and worker callers to send it in `x-koed-embedding-token`. `/health`
remains available for container health checks.

## Local Environment

Run the service locally after building and setting local model paths:

```bash
MODEL_PATH=/path/to/embedding.gguf \
RERANKER_KEY= \
pnpm --filter @koed/embedding-service dev
```

The TypeScript service launches `llama-server` directly and expects local
`MODEL_PATH` and, when reranking is enabled, `RERANKER_MODEL_PATH`.

Select the embedding model with `MODEL_KEY`. Unknown keys fail service startup.
Supported keys:

- `qwen3-0.6b`: Qwen3 0.6B GGUF embedding model, 1024 dimensions.

Select the reranker with `RERANKER_KEY`. Leave it blank to disable reranking.
Unknown non-empty keys fail service startup. Supported keys:

- `qwen3-reranker-0.6b`: Qwen3 0.6B GGUF reranker served by a second
  llama-server process with `--pooling rank`.

When reranking is enabled, service startup and `/health` require the reranker
llama-server process to be usable as well as the embedding process.
`KOED_RERANKER_MODEL_SHA256` (or the app-local
`RERANKER_ARTIFACT_SHA256`) is also required. Startup hashes the exact GGUF
passed to llama-server and rejects a mismatch. `/health` and `/rerank` expose
the measured digest as `artifactHash` and as the immutable
`artifactRevision` (`sha256:<digest>`); `/rerank` also reports llama-server's
measured prompt-token usage, model-call latency, and `costUsd: 0` for local
execution.

The reranker is configured separately from the embedding server. Use
`RERANKER_CONTEXT_PER_SLOT`, `RERANKER_PARALLEL`,
`RERANKER_LLAMA_N_BATCH`, and `RERANKER_LLAMA_N_UBATCH` for the rerank
classifier path. The logical batch must cover the largest formatted
query-document pair you want to score. The ubatch is the physical microbatch
knob, but for this llama-server path it must still be large enough for the
largest formatted pair; oversized rerank prompts are rejected rather than
truncated.
`RERANKER_PROMPT_CACHE_ENABLED` defaults to `true` because one rerank request
scores many documents against the same instruction and query prefix.

Embedding chunking uses `LLAMA_BATCH_TOKEN_HEADROOM` to stay below the literal
`LLAMA_N_BATCH` boundary. The default margin is `8` tokens, which prevents
tokenizer edge cases where text targeting an 8192-token batch becomes 8193
tokens after final model tokenization.

## Observability

The service writes structured JSON operational logs with
`schema_version: "embedding_service_log_v1"` and
`service: "koed-embedding-service"`. Set `LOG_LEVEL=debug` for scheduler,
chunking, batching, and reranker scoring details. Logs intentionally avoid input
text, chunks, vectors, request bodies, tokens, and full headers.

The production path starts local `llama-server` subprocesses and calls
`/tokenize`, `/v1/embeddings`, and, when enabled, `/v1/rerank`. Koed keeps the
Embedding Service boundary because it owns auth, queue priority, chunk response
shape, normalization validation, health metadata, and stable API/worker
contracts.

# Embedding Service

Local adapter for llama-server embeddings.

The bundled-local supervisor launches the TypeScript implementation in `src/`.

The Embedding Service is intended to run as a private backend component. Set
`EMBEDDING_SERVICE_TOKEN` in shared deployments; `/embed` then
requires API and worker callers to send it in `x-koed-embedding-token`. `/health`
remains available for container health checks.

## Local Environment

Run the service locally after building and setting local model paths:

```bash
MODEL_PATH=/path/to/embedding.gguf \
pnpm --filter @koed/embedding-service dev
```

The TypeScript service launches `llama-server` directly and expects local
`MODEL_PATH`.

Select the embedding model with `MODEL_KEY`. Unknown keys fail service startup.
Supported keys:

- `qwen3-0.6b`: Qwen3 0.6B GGUF embedding model, 1024 dimensions.

Embedding chunking uses `LLAMA_BATCH_TOKEN_HEADROOM` to stay below the literal
`LLAMA_N_BATCH` boundary. The default margin is `8` tokens, which prevents
tokenizer edge cases where text targeting an 8192-token batch becomes 8193
tokens after final model tokenization.

## Observability

The service writes structured JSON operational logs with
`schema_version: "embedding_service_log_v1"` and
`service: "koed-embedding-service"`. Set `LOG_LEVEL=debug` for scheduler,
chunking and batching details. Logs intentionally avoid input
text, chunks, vectors, request bodies, tokens, and full headers.

The production path starts local `llama-server` subprocesses and calls
`/tokenize` and `/v1/embeddings`. Koed keeps the
Embedding Service boundary because it owns auth, queue priority, chunk response
shape, normalization validation, health metadata, and stable API/worker
contracts.

# Embedding Service

Local adapter for llama-server embeddings and optional reranking.

The current bundled-local supervisor still launches the Python FastAPI service.
The TypeScript/Node implementation in `src/` preserves the same HTTP contract
for KOE-295 and is intended to become the supervised path in KOE-296. Keep the
Python app and venv procurement in place until that follow-up lands.

The embedding service is intended to run as a private backend component. Set
`EMBEDDING_SERVICE_TOKEN` in shared deployments; `/embed` and `/rerank` then
require API and worker callers to send it in `x-koed-embedding-token`. `/health`
remains available for container health checks.

## Local Environment

Use a local virtualenv for Python work. Do not commit `.venv/`.

```bash
cd apps/embedding-service
python3.12 -m venv .venv
. .venv/bin/activate
pip install --no-cache-dir -r requirements-dev.txt
```

From the repository root, the same setup is available as:

```bash
pnpm setup:python
```

If `python3.12` is not on `PATH`, point the setup script at a Python 3.12 binary:

```bash
KOED_PYTHON=/path/to/python3.12 pnpm setup:python
```

Run the Python service locally after installing `llama-server` and setting
`LLAMA_SERVER_BINARY` if it is not available at `/opt/llama.cpp/llama-server`:

```bash
pip install --no-cache-dir -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Run the TypeScript service locally after building and setting local model paths:

```bash
MODEL_PATH=/path/to/embedding.gguf \
RERANKER_KEY= \
pnpm --filter @koed/embedding-service dev
```

The TypeScript service launches `llama-server` directly and expects local
`MODEL_PATH` and, when reranking is enabled, `RERANKER_MODEL_PATH`. Runtime
procurement and bundled-local process supervision remain Python-owned until the
follow-up switch.

Select the embedding model with `MODEL_KEY`. Unknown keys fail service startup.
Supported keys:

- `qwen3-0.6b`: Qwen3 0.6B GGUF embedding model, 1024 dimensions.

Select the reranker with `RERANKER_KEY`. Leave it blank to disable reranking.
Unknown non-empty keys fail service startup. Supported keys:

- `qwen3-reranker-0.6b`: Qwen3 0.6B GGUF reranker served by a second
  llama-server process with `--pooling rank`.

When reranking is enabled, service startup and `/health` require the reranker
llama-server process to be usable as well as the embedding process.

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

Runtime dependencies are pinned in `requirements.txt`. Development-only tooling
belongs in `requirements-dev.txt`; it intentionally does not install the native
runtime model stack.

## Observability

The service writes structured JSON operational logs with
`schema_version: "embedding_service_log_v1"` and
`service: "koed-embedding-service"`. Set `LOG_LEVEL=debug` for scheduler,
chunking, batching, and reranker scoring details. Logs intentionally avoid input
text, chunks, vectors, request bodies, tokens, and full headers.

The production path starts local `llama-server` subprocesses and calls
`/tokenize`, `/v1/embeddings`, and, when enabled, `/v1/rerank`. Koed keeps the
FastAPI adapter because it owns auth, queue priority, chunk response shape,
normalization validation, health metadata, and stable API/worker contracts.

If `pip install -r requirements.txt` reports a wheel checksum error such as `Bad CRC-32`, remove the local venv and rerun the runtime install with `--no-cache-dir` so pip downloads a fresh wheel instead of reusing a corrupt cached archive.

# Embedding Service

Local FastAPI service for embeddings and optional reranking.

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

Run the service locally:

```bash
pip install --no-cache-dir -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Select the embedding model with `MODEL_KEY`. Unknown keys fail service startup.
Supported keys:

- `qwen3-0.6b`: Qwen3 0.6B GGUF embedding model, 1024 dimensions.

Select the reranker with `RERANKER_KEY`. Leave it blank to disable reranking.
Unknown non-empty keys fail service startup. Supported keys:

- `qwen3-reranker-0.6b`: Qwen3 0.6B ONNX reranker.

Runtime dependencies are pinned in `requirements.txt`. Development-only tooling belongs in `requirements-dev.txt`; it intentionally does not install the native runtime model stack.

## Observability

The service writes structured JSON operational logs with
`schema_version: "embedding_service_log_v1"` and
`service: "koed-embedding-service"`. Set `LOG_LEVEL=debug` for scheduler,
chunking, batching, and reranker scoring details. Logs intentionally avoid input
text, chunks, vectors, request bodies, tokens, and full headers.

The current llama-cpp-python embedding path accepts a `LLAMA_N_BATCH` sized
batch internally. `EMBEDDING_MAX_TOKENS` may be larger than `LLAMA_N_BATCH`; this
cleanup documents that risk but does not change existing long-input embedding
semantics.

If `pip install -r requirements.txt` reports a wheel checksum error such as `Bad CRC-32`, remove the local venv and rerun the runtime install with `--no-cache-dir` so pip downloads a fresh wheel instead of reusing a corrupt cached archive.

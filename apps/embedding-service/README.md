# Embedding Service

Local FastAPI service for embeddings and optional reranking.

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

Runtime dependencies are pinned in `requirements.txt`. Development-only tooling belongs in `requirements-dev.txt`; it intentionally does not install the native runtime model stack.

If `pip install -r requirements.txt` reports a wheel checksum error such as `Bad CRC-32`, remove the local venv and rerun the runtime install with `--no-cache-dir` so pip downloads a fresh wheel instead of reusing a corrupt cached archive.

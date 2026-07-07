# Embedding Service Python venv evaluation

## Decision

Recommendation: **remove Python before signing/notarization**.

The current packaged native runtime should keep using the Embedding Service HTTP contract, but the service implementation should move from the packaged Python virtualenv to a Node/TypeScript process before KOE-294 release hardening.

This decision is about the default always-on packaged Desktop runtime, not a blanket rule that Koed will never use Python. Future features such as Memory Inbox document processing may still justify Python or specialist processors, but those should be isolated behind job/HTTP contracts rather than bundled into the core Desktop runtime by default.

This is not a backend LLM synthesis change. The Embedding Service remains local vector/rerank infrastructure around `llama-server`.

## Current responsibilities

The Python Embedding Service lives in `apps/embedding-service` and is launched by `koed-server` in bundled-local mode through `packages/koed-server/src/local-embedding-runtime.ts`:

```text
python -m uvicorn app:app --host <host> --port <port>
```

Runtime path resolution currently requires:

- `embedding-service/app.py`
- `embedding-service/.venv/bin/python`
- `llama.cpp/llama-server`

The service owns:

- `/health` response shape and readiness gating;
- `x-koed-embedding-token` auth for `/embed` and `/rerank`;
- `x-request-id` response header propagation and traceparent parsing;
- structured Embedding Service logs;
- `/embed` request validation, character limits, batch limits, and response shape;
- `/rerank` request validation, character limits, batch limits, and response shape;
- supported model metadata:
  - `qwen3-0.6b` embedding model, 1024 dimensions;
  - `qwen3-reranker-0.6b` reranker model;
- environment resolution for model paths, llama-server binary, ports, token, limits, threads, batch sizes, and reranker settings;
- embedding `llama-server` child process launch/readiness/stop;
- optional reranker `llama-server` child process launch/readiness/stop;
- tokenization and detokenization through `llama-server`;
- text chunking by token limit;
- single-slot priority scheduler for interactive/background embedding work;
- `/v1/embeddings` calls to `llama-server` and vector normalization;
- `/v1/rerank` calls to `llama-server` and score extraction.

Callers outside the service depend on the HTTP contract, not Python internals:

- `packages/db/src/repository.ts` calls `/embed` and `/rerank` through `EMBEDDING_SERVICE_URL` with `x-koed-embedding-token`.
- API and Worker load `EMBEDDING_SERVICE_URL`, `EMBEDDING_SERVICE_TOKEN`, `EMBEDDING_MODEL`, and reranker env through their existing config paths.
- `koed-server start/status/doctor/stop` manages the local process and health checks.
- packaged Desktop smoke validates packaged-provider runtime install/start behavior through the same CLI path.

## Current packaging shape

The native runtime manifest treats the Python service as a native asset when `.venv/bin/python` exists:

```text
embedding-service/
  app.py
  auth.py
  env_config.py
  logging_config.py
  priority_scheduler.py
  runtime.py
  schemas.py
  settings.py
  vectors.py
  requirements.txt
  pyproject.toml
  .venv/bin/python
```

`prepare-koed-runtime.mjs` always copies the Python app files. Native runtime procurement and Homebrew staging then add `.venv`:

- release artifact path: `scripts/native-runtime/procure-runtime.mjs` downloads `python-build-standalone`, installs `requirements.txt`, and writes `.venv` into `embedding-service`;
- local smoke path: `scripts/stage-native-runtime-homebrew.mjs` copies the local `apps/embedding-service/.venv` into `embedding-service`.

## Size measurements

Measured locally on macOS arm64:

| Item                                                             |   Size |
| ---------------------------------------------------------------- | -----: |
| `apps/embedding-service` local tree                              | 163 MB |
| local `apps/embedding-service/.venv`                             | 151 MB |
| Python app files without venv                                    | 100 KB |
| Homebrew-staged runtime with venv                                | 253 MB |
| Homebrew-staged runtime without venv                             | 102 MB |
| gzip of Homebrew-staged runtime with venv                        |  80 MB |
| gzip of Homebrew-staged runtime without venv                     |  27 MB |
| fresh production venv from `requirements.txt` using local Python |  57 MB |

Notes:

- Homebrew staging copies the developer `.venv`, so it can overstate release size by including dev-only packages if the local venv contains them.
- Release procurement uses `python-build-standalone` plus production requirements, so it avoids local dev packages but still carries a relocatable Python runtime and native extension surface.
- The packaged Desktop DMG/ZIP path is also affected because native runtime assets are copied into the app bundle.

## Signing/notarization impact

Keeping Python into KOE-294 means the signing/notarization path must handle a relocatable Python runtime, Python extension modules, and venv executables in addition to PostgreSQL, pgvector, `llama-server`, Electron, and Node assets.

Even if the production venv is trimmed, it keeps:

- Python interpreter binaries;
- Python dynamic libraries/framework pieces from `python-build-standalone`;
- native wheels/extensions from runtime dependencies;
- a larger set of nested files that release signing must inspect, sign, and preserve during packaging.

That increases release-hardening risk more than the service code complexity warrants.

## Options considered

### Option 1: Keep Python venv as-is

Pros:

- No service rewrite.
- Current KOE-290/KOE-293 packaged-provider path already validates it.
- Lowest short-term risk.

Cons:

- Keeps large native runtime artifact contribution.
- Carries Python relocation risk into signing/notarization.
- Adds a second application runtime language to the packaged Desktop app.
- Release signing must handle Python internals and native extensions.

Verdict: acceptable for internal unsigned artifacts, not recommended for release hardening.

### Option 2: Trim or relocate Python more carefully

Pros:

- Could reduce some artifact size.
- Smaller change than a service port.
- Keeps current Python tests mostly intact.

Cons:

- Does not remove Python from signing/notarization.
- Still needs relocatable Python support across macOS/Linux.
- Still carries Python-native extension signing surface.
- Does not simplify service ownership.

Verdict: not enough payoff if KOE-294 is next release-hardening step.

### Option 3: Port Embedding Service to TypeScript/Node

Pros:

- Removes `.venv` from packaged native runtime.
- Keeps existing HTTP boundary for API/Worker/repository callers.
- Reuses project TypeScript test/build tooling.
- Reduces release signing/notarization surface.
- Keeps `llama-server` as the only ML runtime process for embeddings/reranking.

Cons:

- Requires parity implementation for validation, scheduler, tokenization/chunking, health, logging, and llama-server supervision.
- Requires parallel parity tests against current Python behavior.
- Requires packaging/runtime resolution changes.

Verdict: recommended. It is a contained service-port with a stable HTTP contract and high release-hardening value.

### Option 4: Fold direct llama-server calls into API/Worker/control-plane code

Pros:

- Removes an extra local HTTP service.
- Could reduce one process boundary.

Cons:

- Larger service-boundary change.
- API and Worker would need coordinated access to model process ownership and scheduling.
- More risk to queue/ingestion/retrieval behavior.
- Harder to preserve external embedding-service compatibility.

Verdict: defer. Too broad for pre-signing cleanup.

## Recommended implementation sequence

Current stack status: KOE-295 implemented the TypeScript/Node Embedding Service HTTP contract, KOE-296 switched bundled-local supervision to the TypeScript service, and KOE-297 completed Python removal from packaged native runtime procurement, staging, validation, and docs. Python source may remain in the tree for development/parity workflows, but packaged native runtime assets no longer include `embedding-service/.venv/bin/python`.

1. Implement a Node/TypeScript Embedding Service with the same HTTP contract. **Status: implemented in the KOE-295 stacked PR.**
   - Preserve `/health`, `/embed`, and `/rerank` response shapes.
   - Preserve `x-koed-embedding-token` auth.
   - Preserve model/reranker environment aliases.
   - Preserve tokenization/detokenization chunking through `llama-server`.
   - Preserve interactive/background priority scheduling.
   - Preserve vector normalization and rerank score extraction.
   - Add parity tests based on current Python tests.

2. Switch bundled-local runtime management to the Node service. **Status: completed in KOE-296.**
   - Update `local-embedding-runtime.ts` to spawn Node instead of Python.
   - Keep `EMBEDDING_SERVICE_URL` and `EMBEDDING_SERVICE_TOKEN` unchanged for API/Worker.
   - Keep local process name/status as Embedding Service.
   - Keep packaged Desktop smoke coverage.

3. Remove Python from native runtime artifacts. **Status: completed in KOE-297.**
   - Remove `python` source entries from native runtime source manifests.
   - Remove `.venv` staging/procurement.
   - Update `runtime-asset-manifest.json` expectations.
   - Update native runtime validation to use Node service assets instead of `.venv/bin/python`.
   - Update `docs/native-runtime-assets.md` and packaged Desktop docs.

4. Remove or retire Python app path after parity lands.
   - Delete `apps/embedding-service` Python implementation only after Node implementation is validated.
   - Keep any useful test vectors/fixtures by moving them into TypeScript tests.

## Follow-up issues

Recommended implementation issues:

1. Port the Embedding Service HTTP contract to TypeScript/Node. **Tracked by KOE-295.**
2. Switch bundled-local runtime packaging and `koed-server` supervision to the Node Embedding Service. **Completed by KOE-296.**
3. Remove Python venv procurement/staging/validation/docs from native runtime artifacts. **Completed by KOE-297.**

## KOE-292 and KOE-294 guidance

KOE-292 should assume the Python runtime will be removed before signed release packaging unless implementation uncovers a major blocker.

KOE-294 should wait for the Python-removal implementation or explicitly record a decision to proceed with Python included. Current recommendation is **do not proceed to signing/notarization with Python included**.

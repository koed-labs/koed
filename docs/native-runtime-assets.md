# Native Runtime Assets

Koed bundled-local mode owns native runtime state under `KOED_HOME`. External dependency mode remains Operator-owned and does not install or start Docker Compose, external Postgres, Redis, or an external Embedding Service.

## Current provisioning strategy

KOE-297 removed Python virtualenv procurement, staging, validation, and packaged native runtime expectations. Packaged native runtime assets now contain Postgres/pgvector and `llama-server`; the built TypeScript Embedding Service is deployed as JS service files under packaged `koed-runtime/embedding-service`.

Koed uses:

1. **Packaged runtime resources** when `runtime-asset-manifest.json` and matching platform/architecture assets ship under packaged `koed-runtime`.
2. **Homebrew-backed runtime install** on macOS, Linux, and WSL where Homebrew is available.
3. **Explicit overrides** for advanced Operators (`KOED_POSTGRES_BIN_DIR`, `KOED_POSTGRES_*_BIN`, `KOED_EMBEDDING_LLAMA_SERVER_BIN`).

Packaged Desktop never silently falls back to source-checkout `vendor` paths. Developer source fallbacks require explicit opt-in with `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1`.

## Packaged asset layout

Packaged native resources live under Electron `Contents/Resources/koed-runtime` or equivalent Linux resources path:

```text
koed-runtime/
  runtime-asset-manifest.json
  postgres/
    bin/initdb
    bin/pg_ctl
    bin/psql
    bin/pg_config
    ... pgvector extension files ...
  llama.cpp/
    llama-server
    cpu/
      llama-server
      ... CPU runtime libraries ...
    cuda/
      llama-server
      ... redistributable CUDA runtime libraries ...
  embedding-service/
    dist/index.js
    package.json
```

Bundled-local supervision starts the Embedding Service from `embedding-service/dist/index.js`. Packaged native runtime assets no longer include Python standalone runtime files, Python wheels/native extensions, or `embedding-service/.venv/bin/python`.

Desktop packaging can stage prebuilt native assets by setting:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/native-runtime pnpm desktop:package
```

For local packaged-native smoke testing, Operators with Homebrew/Linuxbrew can create that staging directory from installed local formulas:

```bash
pnpm native-runtime:stage:homebrew -- --out /tmp/koed-native-runtime --force
KOED_NATIVE_RUNTIME_SOURCE_DIR=/tmp/koed-native-runtime pnpm desktop:package:mac
```

`native-runtime:stage:homebrew` is a development smoke helper. It copies Homebrew/Linuxbrew-provided PostgreSQL 17, pgvector extension files, and `llama-server` into the expected staging layout. It does not require or copy `apps/embedding-service/.venv`. The staged output may still depend on Homebrew dynamic libraries and is not a release-quality redistributable native runtime bundle.

`prepare-koed-runtime.mjs` copies staged assets into packaged `koed-runtime`, deploys the built Embedding Service runtime, and writes a platform/architecture manifest with SHA-256 verification. If `KOED_NATIVE_RUNTIME_SOURCE_DIR` is set but no recognized native assets are staged, packaging fails instead of silently producing a missing-native runtime package. If no native asset source is provided, Desktop still packages JS/service artifacts, while `koed-server runtime status/install` reports missing native assets with Homebrew repair guidance.

Native runtime artifacts can be assembled and validated locally with:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/koed-runtime pnpm native-runtime:build:macos-arm64 -- --json
pnpm native-runtime:validate -- --runtime-root dist/native-runtime/macos-arm64/koed-runtime --platform darwin --json
```

See `docs/native-runtime-artifact-pipeline.md`.

Generated native archives are release assets, not Git-tracked files. Linux CUDA
is cold-built only by the explicitly requested CI proof or the trusted
default-branch cache workflow. The validated payload is cached by its pinned
source and build recipe; releases repackage that payload and publish the archive,
SHA-256 sidecar, and provenance manifest without recompiling it.

Real CUDA proof uses the manually dispatched `Trusted Linux CUDA package
validation` workflow on the protected default branch. It requires a self-hosted
Linux x64 runner labelled `koed-cuda`, NVIDIA driver 550.54.14 or newer, and the
system libraries required by the pinned ONNX Runtime CUDA provider. The job
uses the independently verified cached native payload and exact standalone app
runtime; it does not treat a hosted-runner policy check as hardware evidence.

## Validation

`koed-server runtime status --provider packaged --json` and `runtime install --provider packaged --dependency-mode bundled-local --json` validate:

- manifest platform/architecture match;
- SHA-256 over expected files;
- executable bit on installed executables;
- PostgreSQL 17 via `pg_config --version` or `initdb --version`;
- `llama-server` responds to `--version` or `--help`;
- loader output where tooling exists (`otool -L` on macOS, `ldd` on Linux) has no missing libraries, except the host-provided `libcuda.so.1` driver interface within the Linux CUDA payload.

Bundled-local startup separately requires the built Embedding Service entry (`embedding-service/dist/index.js`), `llama-server`, and an installed embedding model path. It does not require `embedding-service/.venv/bin/python` or `KOED_EMBEDDING_PYTHON_BIN`.

Bundled-local Postgres startup also runs `CREATE EXTENSION IF NOT EXISTS vector`, so pgvector compatibility is proven against actual Koed database initialization.

## Linux baseline

Linux packaged native runtime targets:

- `linux/x64` and `linux/arm64` only;
- glibc-based distributions with **glibc 2.35 or newer**;
- Ubuntu 22.04 LTS / Debian 12 or newer as baseline;
- non-musl Linux. Alpine/musl requires external dependency mode or separately built assets.

If packaged assets do not match host platform/architecture, glibc is older than 2.35, musl/Alpine is detected, or loader checks find missing libraries, Koed reports unsupported/incompatible guidance instead of falling back to Docker Compose or source-checkout paths. Native Windows packaging is not part of this path.

## WSL validation

Windows native packaging is out of scope; use WSL for local Linux validation. Keep `KOED_HOME` and the checkout on the WSL Linux filesystem rather than `/mnt/<drive>` so permissions, sockets, and Postgres data files behave like Linux.

```bash
KOED_HOME=$HOME/.koed-test \
KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/linux-x64/koed-runtime \
pnpm native-runtime:validate:wsl -- --runtime-root /path/to/linux-x64/koed-runtime --json
```

The WSL validator accepts either an extracted `koed-runtime/` path or a prepared runtime directory such as `apps/desktop/.koed-runtime`. It treats the expected fresh pre-install missing runtime status as diagnostic, then runs packaged-provider runtime install, embedding model install, daemon start, waits for readiness, runs status and doctor, checks API `/ready` reachability, and stops/cleans up on success or failure using bundled-local defaults. WSL hosts must use a glibc distro that meets the same 2.35+ baseline, such as Ubuntu 22.04+.

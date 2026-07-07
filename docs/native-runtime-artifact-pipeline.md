# Native Runtime Artifact Pipeline

Koed native runtime artifacts are Koed-owned tarballs consumed by packaged Desktop builds through `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

## macOS arm64 local artifact build

For local review, the builder can procure pinned upstream inputs directly from
`scripts/native-runtime/sources.macos-arm64.json`:

```bash
pnpm native-runtime:build:macos-arm64 -- --json
```

The procured runtime uses `python-build-standalone` for the Embedding Service
Python runtime, official `llama.cpp` release assets for `llama-server`, and a
pinned PostgreSQL 17 source build with pgvector built against the selected
`pg_config` until a suitable relocatable PostgreSQL binary is selected. All
source archives are SHA-256 verified before use.

For layout tests or externally staged candidates, override procurement with an
existing `koed-runtime/` directory:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/koed-runtime \
  pnpm native-runtime:build:macos-arm64 -- --json
```

Output defaults to:

```text
dist/native-runtime/macos-arm64/
  koed-runtime/
  koed-native-runtime-macos-arm64-<version>.tar.gz
  koed-native-runtime-macos-arm64-<version>.tar.gz.sha256
  provenance.json
```

Validate the staged runtime:

```bash
pnpm native-runtime:validate -- \
  --runtime-root dist/native-runtime/macos-arm64/koed-runtime \
  --platform darwin \
  --json
```

Linux x64 follows the same local shape, procures from
`scripts/native-runtime/sources.linux-x64.json`, and enforces glibc 2.35+. Clean Ubuntu/WSL builds need PostgreSQL source-build prerequisites available first:

```bash
sudo apt-get update
sudo apt-get install -y build-essential bison flex libssl-dev curl ca-certificates
```

Then build and validate:

```bash
pnpm native-runtime:build:linux-x64 -- --json
pnpm native-runtime:validate -- \
  --runtime-root dist/native-runtime/linux-x64/koed-runtime \
  --platform linux \
  --json
```

Use `KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/linux-x64/koed-runtime` only when
validating a pre-staged runtime layout instead of CI procurement.

## Source inputs

`scripts/native-runtime/sources.macos-arm64.json` and
`scripts/native-runtime/sources.linux-x64.json` record pinned upstream inputs:

- `python-build-standalone` install-only archives for the Python runtime;
- official `llama.cpp` release assets pinned to a macOS 14-compatible build for macOS arm64 CI runners;
- PostgreSQL 17 official source tarballs while relocatable binary candidates are
  still being evaluated, including the `pgcrypto` contrib extension required by Koed migrations;
- pgvector source built against the selected `pg_config`.

The builder verifies each archive by SHA-256, assembles the deterministic
`koed-runtime/` layout, installs the Embedding Service Python dependencies into
`embedding-service/.venv`, writes the packaged runtime manifest, and archives
the runtime tarball. Validation starts temporary Postgres and verifies both
`CREATE EXTENSION pgcrypto` and `CREATE EXTENSION vector`.

## CI

`.github/workflows/ci.yml` includes manual `native-runtime-macos-arm64` and `native-runtime-linux-x64` jobs. They are intentionally not part of normal pull-request CI because native artifact builds are expensive and should run on dependency bumps or explicit review. Linux x64 artifacts target glibc 2.35+ and should be built on Ubuntu 22.04 or an equivalent baseline image.

The uploaded native runtime artifact contains the runtime tarball, sidecar SHA-256, and provenance metadata. When that manual artifact job runs, CI also runs `packaged-desktop-native-smoke`: it downloads the artifact, extracts `koed-runtime/`, validates it, sets `KOED_NATIVE_RUNTIME_SOURCE_DIR`, builds unsigned Desktop DMG/ZIP artifacts, runs the full packaged smoke against the built app, and uploads `koed-desktop-macos-arm64-unsigned` for internal testing. The existing `packaged-desktop-smoke` job remains a missing-assets negative smoke and does not set `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

The release workflow uses the same macOS native-runtime and Desktop packaging path when it creates a new GitHub Release, then uploads the unsigned DMG/ZIP and checksum file as release assets. See `docs/desktop-internal-artifacts.md` for artifact download, install/open, Gatekeeper-warning, runtime status/doctor, and cleanup instructions.

## Desktop consumption

After extracting the artifact, point Desktop packaging at the extracted `koed-runtime/` directory:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=$PWD/dist/native-runtime/macos-arm64/koed-runtime \
  pnpm desktop:package:smoke:mac -- --json
```

Packaged mode must not use source-checkout fallbacks.

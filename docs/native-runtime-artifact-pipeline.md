# Native Runtime Artifact Pipeline

Koed native runtime artifacts are Koed-owned tarballs consumed by packaged Desktop builds through `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

## macOS arm64 local artifact build

For local review, the builder can procure pinned upstream inputs directly from `scripts/native-runtime/sources.macos-arm64.json`:

```bash
pnpm native-runtime:build:macos-arm64 -- --json
```

The procured runtime uses official `llama.cpp` release assets for `llama-server` and a pinned PostgreSQL 17 source build with pgvector built against the selected `pg_config` until a suitable relocatable PostgreSQL binary is selected. On macOS, the builder also compiles a pinned OpenSSL source archive as static libraries with process-exit cleanup, QUIC, and OpenSSL's internal thread pool disabled, then links PostgreSQL against them. That OpenSSL mode preserves normal thread-safe crypto while satisfying PostgreSQL's rule that `libpq` must not invoke process-exit functions. The native build environment removes package-manager include, library, and pkg-config paths and uses the macOS system toolchain path, so a runner's Homebrew installation cannot become an undeclared build input. All source archives are SHA-256 verified before use.

KOE-297 removed Python from packaged native runtime artifacts. The builder no longer downloads `python-build-standalone`, creates `embedding-service/.venv`, installs Python dependencies, or validates a Python executable. The built TypeScript Embedding Service is deployed by Desktop packaging as `embedding-service/dist/index.js`.

For layout tests or externally staged candidates, override procurement with an existing `koed-runtime/` directory:

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

Linux x64 follows the same local shape, procures from `scripts/native-runtime/sources.linux-x64.json`, and enforces glibc 2.35+. Clean Ubuntu/WSL builds need PostgreSQL source-build prerequisites available first:

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

Use `KOED_NATIVE_RUNTIME_SOURCE_DIR=/path/to/linux-x64/koed-runtime` only when validating a pre-staged runtime layout instead of CI procurement.

## Source inputs

`scripts/native-runtime/sources.macos-arm64.json` and `scripts/native-runtime/sources.linux-x64.json` record pinned upstream inputs:

- official `llama.cpp` release assets pinned to a compatible build for each platform;
- OpenSSL source pinned for macOS and built without shared libraries before PostgreSQL;
- PostgreSQL 17 official source tarballs while relocatable binary candidates are still being evaluated, including the `pgcrypto` contrib extension required by Koed migrations;
- pgvector source built against the selected `pg_config`.

The builder verifies each archive by SHA-256, assembles the deterministic `koed-runtime/` layout, writes the packaged runtime manifest, and archives the runtime tarball. Validation recursively inspects every Mach-O or ELF file in the runtime instead of relying on a short executable list. macOS validation rejects undeclared absolute loader paths, missing `@loader_path`/`@rpath` dependencies, and package-manager paths. Validation also starts temporary Postgres and verifies both `CREATE EXTENSION pgcrypto` and `CREATE EXTENSION vector`. It validates `llama-server`; it does not validate Python because Python is no longer packaged as a native runtime asset.

## CI

`.github/workflows/ci.yml` builds and validates the macOS arm64 native runtime on every pull request, then consumes the extracted artifact in the packaged Desktop native smoke. This release-equivalent macOS path catches relocation, signing, app, and DMG integrity failures before merge. The Linux x64 native runtime job remains manual because it is expensive and should run on dependency bumps or explicit review; its artifacts target glibc 2.35+ and should be built on Ubuntu 22.04 or an equivalent baseline image.

The uploaded native runtime artifact contains the runtime tarball, sidecar SHA-256, and provenance metadata. CI extracts the completed tarball into a separate temporary directory before validation, which exercises the same relocation boundary as a consumer. For pull requests and manual macOS artifact builds, CI also runs `packaged-desktop-native-smoke`: it downloads the artifact, extracts `koed-runtime/`, validates it, sets `KOED_NATIVE_RUNTIME_SOURCE_DIR`, builds unsigned Desktop DMG/ZIP artifacts, runs the full packaged smoke against the built app, and uploads `koed-desktop-macos-arm64-unsigned` for internal testing. The existing `packaged-desktop-smoke` job remains a missing-assets negative smoke and does not set `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

The release workflow uses the same macOS native-runtime and Desktop packaging path when it creates a new GitHub Release, then uploads the unsigned DMG/ZIP and checksum file as release assets. See `docs/desktop-internal-artifacts.md` for artifact download, install/open, Gatekeeper-warning, runtime status/doctor, and cleanup instructions.

## Desktop consumption

After extracting the artifact, point Desktop packaging at the extracted `koed-runtime/` directory:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=$PWD/dist/native-runtime/macos-arm64/koed-runtime \
  pnpm desktop:package:smoke:mac -- --json
```

Packaged mode must not use source-checkout fallbacks.

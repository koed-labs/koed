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

The builder verifies each source archive by SHA-256, assembles the deterministic
`koed-runtime/` layout, writes the packaged runtime manifest, and emits a
sorted, metadata-normalized ustar/PAX gzip stream. Native archives are written
with bounded file streaming instead of buffering the combined Linux CUDA
payload. Provenance records the pinned source manifest or a path-independent
verified-runtime-source marker and uses `SOURCE_DATE_EPOCH`, defaulting to the
Unix epoch. Clean source and output paths therefore produce the same runtime
tree, manifest, provenance, archive, and SHA-256 value. Validation recursively
inspects every Mach-O or ELF file in the runtime instead of relying on a short
executable list. macOS validation rejects undeclared absolute loader paths,
missing `@loader_path`/`@rpath` dependencies, and package-manager paths.
Validation also starts temporary Postgres and verifies both
`CREATE EXTENSION pgcrypto` and `CREATE EXTENSION vector`. It validates
`llama-server`; it does not validate Python because Python is no longer
packaged as a native runtime asset.

Before the manifest is written, native-runtime staging removes compiler outputs,
headers, static libraries, source/test trees, and build caches. Licence or
notice files found inside a removed tree are retained under
`third-party-licenses/`. Exact-runtime validation fails if a forbidden build
artifact remains or if CUDA redistributable libraries are duplicated as regular
files with identical content. The builder applies `strip -x` to Mach-O files and
then restores a valid ad-hoc signature on each modified Mach-O. It applies
`strip --strip-unneeded` to ELF files. Both operations finish before manifest
hashes are generated. The subsequent
loader, executable, PostgreSQL extension, and packaged-provider validation runs
against those stripped bytes, so an incompatible strip fails the build.

Linux CUDA validation requires every redistributable CUDA runtime dependency to
resolve from the packaged payload. The sole external exception is
`libcuda.so.1`, which is the host NVIDIA driver interface and cannot be bundled.
That exception is accepted only for ELF files under `llama.cpp/cuda/`.

## CI

`.github/workflows/ci.yml` runs native macOS validation only after static checks, tests, and the normal build succeed. Packaging/runtime-relevant pull requests restore a source-, script-, platform-, architecture-, and Xcode-keyed native payload, regenerate current provenance and checksums, validate it fail closed, and consume it in an unpacked-app packaged Desktop smoke. This path skips DMG/ZIP generation and routine artifact uploads. Documentation-only pull requests do not allocate a macOS runner, and the `full-ci` label forces the app-only smoke when the path policy needs an override.

Pull requests restore the completed native payload without cache-write
permission. `.github/workflows/native-runtime-cache.yml` is the only native
payload writer: trusted default-branch push, scheduled, and manual runs restore
and validate the immutable cache entry, cold-build it on a miss, and save it
only after validation. Source archives and compiler work directories are not
shared; the cached unit is the completed `koed-runtime/` tree.

The `changeset-release/main` pull request, weekly schedule, and manual `full` or
`clean-install` dispatch use an independent cold native build. CI extracts the
completed tarball into a separate temporary directory before validation, which
exercises the same relocation boundary as a consumer. It then packages that
same verified input twice into separate locations and compares the complete
native trees, manifests, provenance, and archive bytes. The full path also
regenerates Desktop runtime staging, builds a second isolated app, and compares
the complete symlink-aware runtime and app trees before it verifies the app,
DMG, ZIP, and block maps. It does not publish these validation outputs. The
Linux x64 native runtime job remains manual because a cold CUDA build is
expensive and should run on dependency bumps or explicit review. It restores a
content-addressed completed payload when available, builds only on a cache
miss, validates before saving, then packages and uploads the current commit
artifact. Its assets target glibc 2.35+ and build on a GitHub-hosted Ubuntu
22.04 runner.

`.github/workflows/native-runtime-linux-cache.yml` is the trusted Linux cache
writer. It runs on the default branch when the pinned source recipe or relevant
build/validation code changes, refreshes the cache on a bounded schedule, and
may be dispatched manually. The cache key covers payload-producing inputs;
validation-only changes revalidate the existing payload without recompiling it.
Ordinary CI and local setup never compile CUDA automatically.

`.github/workflows/native-runtime-linux-cuda-validation.yml` is the manual
hardware-proof path. It is restricted to the trusted default branch and a
self-hosted runner carrying the `linux`, `x64`, and `koed-cuda` labels. The
runner must expose an NVIDIA GPU through `nvidia-smi`, use driver 550.54.14 or
newer, and provide the system libraries required by the pinned ONNX Runtime
CUDA provider. The workflow refuses to rebuild an unreviewed native payload: it
requires the independently populated recipe-keyed cache, packages and extracts
that exact payload, and runs full loader/PostgreSQL/provider validation. It then
proves CUDA discovery and real embedding inference from the extracted CUDA
`llama-server`, including CPU/GPU vector agreement and observed VRAM use. A
separately built exact Linux standalone app runtime must initialize the Privacy
Filter CUDA provider, match CPU classification, switch providers, unload and
reload after idle, and reject Core ML. The workflow retains the bounded JSON
evidence for 30 days. Policy-only hosted CI never sets these hardware boxes.

The release workflow independently rebuilds the macOS native runtime and
Desktop package from the exact merged release commit. Each supported standalone
target is built twice and must match at the package-tree, manifest, provenance,
and archive-byte levels before upload. For Linux x64 the workflow requires the
matching validated native payload cache, packages it twice with identical
results, regenerates versioned provenance and checksums without recompilation,
and publishes the native archive as a separate GitHub Release asset. The draft
release is published only after the complete required asset set is present. See
`docs/ci-validation.md` for the complete tier policy and
`docs/desktop-internal-artifacts.md` for release artifact install/open,
Gatekeeper-warning, runtime status/doctor, and cleanup instructions.

Before upload, the Linux release job writes `artifact-size-report.json` beside
the archive. The report attributes exact expanded bytes to PostgreSQL,
pgvector, CPU and CUDA llama.cpp, CUDA redistributable libraries, and
manifest/provenance files. Its component compressed values are proportional
estimates for the solid gzip stream; the total compressed archive size is
exact. The job rejects symlinks, special files, duplicates above policy,
foreign target binaries, checkout-path leaks, and total archive growth greater
than 5% over the immutable v0.6.2 baseline.

## Desktop consumption

After extracting the artifact, point Desktop packaging at the extracted `koed-runtime/` directory:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=$PWD/dist/native-runtime/macos-arm64/koed-runtime \
  pnpm desktop:package:smoke:mac -- --json
```

Packaged mode must not use source-checkout fallbacks.

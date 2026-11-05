# Native Runtime Artifact Pipeline

Koed native runtime artifacts are Koed-owned tarballs consumed by packaged Desktop builds through `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

The Linux release-provider work reuses the existing lifecycle exclusion for
stopped-runtime changes. See [stopped native runtime operations](stopped-native-runtime.md)
for the internal boundary, process-state checks, and Operator recovery rules.

## Linux CPU and CUDA release packages

The Release workflow attaches the CPU core and the optional CUDA add-on to the
same product release. A hosted Ubuntu 22.04 runner builds the packages with
CUDA Toolkit 12.4 on a cache miss. A cache hit reuses the frozen archives.
Each package keeps the runtime version of the release that built it.

The release CLI contains the download URL, size, and SHA-256 checksum for each
archive. The existing release approval covers both packages. Older clients can
continue to download the combined Linux archive.

## Linux release-provider installation

The explicit CLI path targets Linux x64 with glibc 2.35 or later. It requires a
core pin compiled into the release CLI.

```bash
koed stop
koed runtime install --provider release --dependency-mode bundled-local --json
koed runtime status --provider release --json
koed start
```

For a fresh installation, install the matching Base component and embedding model
before starting. On an unsupported host, the Homebrew alternative requires a
supported Homebrew host and a working Homebrew installation. Its install command
is `koed runtime install --provider homebrew --dependency-mode bundled-local`.

The installer streams the pinned archive to a private staging directory and checks
its size and digest. It requires free space for the compressed archive, expanded
files, and a 128 MiB reserve. Existing retained payloads already occupy space.
An intact selected core needs no download. The native extractor creates direct
relative library links after extracting regular files and authenticates the complete
inventory. Component extraction retains its existing link policy.

Core payloads live under `runtime/native/core/<recipe-id>`. Locally composed
selection directories link Postgres, the launcher, and CPU libraries to that payload.
The supervisor and installer share the lifecycle exclusion. Before changing
`runtime/native/current`, the installer checks stopped state, ownership, the
expected selection, Postgres major version, and bounded CPU executable probes.
The durable pointer swap selects the whole runtime. Earlier payloads and
selections remain available for inspection. A cache-write warning leaves the
activated selection usable. Read-only status derives its result from that selection.

Use `--with-cuda` on the release install command to stage a compatible core and
CUDA add-on together. CUDA payloads live under `runtime/native/cuda/<recipe-id>`.
The installer checks the host before downloading CUDA, verifies the full archive
and inventory, then runs the staged validator under the lock before switching the
pointer. Without an installed model the result is device-only. A failed check
preserves the active pair. A CPU execution policy continues to use CPU.

With neither asset flag, a core update reuses compatible installed CUDA bytes
without another copy or download. The installer checks the CUDA host before
downloading the core. If that check or GPU validation fails under an `auto` or
`cpu` policy, the error suggests `--without-cuda` for a CPU-only update. If the new core is incompatible, `auto` or
`cpu` may select CPU alone. Forced CUDA requires the combined update. Use
`--without-cuda` with an `auto` or `cpu` policy to remove CUDA from the selection.
The prior payload stays available for recovery. Status reports installed and
pinned IDs and the current execution policy without running device discovery.

The compiled minimum version and native contracts apply at startup. A compatible
older core can run while status reports the available update.

The minimum comes from the reviewed
`scripts/native-runtime/core-compatibility.linux-x64.json`, not from the core a
release happens to build. A cache miss or rebuild therefore never strands older
installed cores. Raise `minimumCoreVersion` only when older cores must stop starting
and the change cannot be expressed as a contract change. Release staging refuses a
minimum above the product version or above the staged core. An installed core with
different native contracts cannot start. Status reports it as `incompatible`
instead of failing. Explicit binary
overrides retain their precedence. Install and update preserve the database and
model files. See [stopped-runtime recovery](stopped-native-runtime.md) for stale
locks, uncertain processes, and damaged installations.

## macOS arm64 local artifact build

For local review, the builder can procure pinned upstream inputs directly from `scripts/native-runtime/sources.macos-arm64.json`:

```bash
pnpm native-runtime:build:macos-arm64 -- --json
```

The procured runtime uses official `llama.cpp` release assets for `llama-server` and a pinned PostgreSQL 17 source build with pgvector built against the selected `pg_config` until a suitable relocatable PostgreSQL binary is selected. On macOS, the builder also compiles a pinned OpenSSL source archive as static libraries with process-exit cleanup, QUIC, and OpenSSL's internal thread pool disabled, then links PostgreSQL against them. That OpenSSL mode preserves normal thread-safe crypto while satisfying PostgreSQL's rule that `libpq` must not invoke process-exit functions. The native build environment removes package-manager include, library, and pkg-config paths and uses the macOS system toolchain path, so a runner's Homebrew installation cannot become an undeclared build input. The builder defaults `MACOSX_DEPLOYMENT_TARGET` to `14.0`, so source-built components keep a macOS 14 minimum regardless of the build host's macOS version. All source archives are SHA-256 verified before use.

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
Unix epoch. Packaging the same frozen runtime and metadata in clean output
paths produces the same archive and SHA-256 value. This does not establish
reproducibility of fresh compilation on different hosts. Validation recursively
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
exact. The job rejects unsafe symlinks, special files, duplicates above policy,
foreign target binaries, checkout-path leaks, and total archive growth greater
than 5% over the immutable v0.6.2 baseline.

## Desktop consumption

After extracting the artifact, point Desktop packaging at the extracted `koed-runtime/` directory:

```bash
KOED_NATIVE_RUNTIME_SOURCE_DIR=$PWD/dist/native-runtime/macos-arm64/koed-runtime \
  pnpm desktop:package:smoke:mac -- --json
```

Packaged mode must not use source-checkout fallbacks.

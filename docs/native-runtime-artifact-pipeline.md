# Native Runtime Artifact Pipeline

Koed native runtime artifacts are Koed-owned tarballs consumed by packaged Desktop builds through `KOED_NATIVE_RUNTIME_SOURCE_DIR`.

The Linux release-provider work reuses the existing lifecycle exclusion for
stopped-runtime changes. See [stopped native runtime operations](stopped-native-runtime.md)
for the internal boundary, process-state checks, and Operator recovery rules.

## Independent Linux CPU core candidates

The independent core builder requires an unprivileged user on Ubuntu 22.04
(x64, glibc 2.35) and Node 24.13.1. Install build prerequisites before running it:

```bash
sudo apt-get update
sudo apt-get install -y build-essential bison flex libssl-dev curl ca-certificates patchelf
node scripts/native-runtime/build-core-linux-x64.mjs --out-dir /path/to/new-core --json
```

The output directory must not exist. The build uses an exclusive temporary
directory and removes its own build work on completion or failure. It downloads
only the pinned Postgres, pgvector, and CPU llama.cpp inputs. It does not need
CUDA tools, a GPU, or a cached CUDA payload. The old combined builder remains
available with its existing inputs and validation rules.

`core.linux-x64.json` sets the independent runtime version, target, exact
llama.cpp revision, and invocation contracts. `native-core-manifest.json`
records those values and a recipe digest. The recipe includes the upstream
archive digests, build-tool hashes and versions, installed build packages,
compiler environment, linked OpenSSL inputs, build-script hashes, and packaging
policy. The upstream CPU llama.cpp binary is an exact digest-pinned input; this
builder does not reproduce its upstream compilation. Build images and package
versions may change the recipe identity. A changed recipe must receive review
and an appropriate monotonic runtime version before publication.

The core inventory records every directory, regular-file size, digest and mode,
and each relative library link target. Symlink modes use the archive's fixed
0777 value. Postgres timezone hard links become independent regular files before
the inventory is frozen. Archive hard links, special files, escaping links,
link chains, and CUDA content are rejected. Postgres ELF files use a relative
`$ORIGIN` RUNPATH so tools find the selected `libpq` after relocation.

Each candidate directory contains the frozen `koed-runtime/` tree, its
`koed-native-core-<recipe-id>-linux-x64.tar.gz` archive, a checksum sidecar, and
`core-candidate.json`. The candidate report records the archive and manifest
digests, exact compressed and expanded regular-file sizes, runtime version,
target, and contracts. The size policy allows at most 50 MB compressed and
100 MB expanded. The historical combined-archive baseline is unchanged.

To repeat packaging without rebuilding or changing provenance:

```bash
node scripts/native-runtime/build-core-linux-x64.mjs \
  --source-dir /path/to/frozen/koed-runtime \
  --out-dir /path/to/new-repack --json
```

Frozen packaging verifies the complete inventory and never replaces an existing
archive. Product version variables do not affect the output. Identical frozen
inputs produce identical archives with the same packaging runtime. This is not
a claim that fresh compilations on different hosts produce identical files.

Extract the exact candidate archive into a new directory, verify its recorded
checksum, then qualify it as an unprivileged Linux x64 user:

```bash
node scripts/native-runtime/qualify-core-linux-x64.mjs \
  --runtime-root /path/to/extracted/koed-runtime \
  --model-path /path/to/Qwen3-Embedding-0.6B-Q8_0.gguf \
  --out-dir /path/to/new-evidence
```

This explicit CPU check verifies the inventory, every ELF loader, automatic and
explicit CPU launcher policies, Postgres initialization and restart, pgvector,
pgcrypto, and two finite, nonzero 1024-dimension embeddings. It exercises the
composed selection links, uses temporary data and ports, and stops its own test
processes before reporting success. Its overall deadline is three minutes plus
bounded cleanup. It does not start Koed or download assets or models. The model
must match the runner's fixed qualification digest. Retain `qualification.json`
and the two service logs together with `core-candidate.json` and the archive.

Candidate qualification does not establish release-provider installation health
or GPU readiness. Native publication, trusted Control Plane pins, and the
release provider have separate ticket acceptance gates. CUDA qualification is
deferred until a suitable machine is available.

### Native publication and retention

`.github/workflows/native-runtime-core.yml` builds CPU candidates independently
of product releases. It uses only Node and the native CPU build prerequisites.
It qualifies the extracted archive and retains an offline handover bundle.
The build records separate digests for the candidate report and qualification
report before requesting approval through the existing `production` environment.

The publication job authenticates those reports and the archive before extraction.
`publish-core.mjs` requires independent production approval and verifies identical
frozen packaging. It creates a draft under `native-core-<recipe-id>`, uploads
every required asset, and authenticates retained bytes before publication.
It sets `make_latest` to `false`, as defined by the
[GitHub release API](https://docs.github.com/en/rest/releases/releases#create-a-release).
Product releases keep their existing publication approval boundary.

Retries can upload missing draft assets. They cannot replace changed bytes.
Retries of a complete published release only authenticate retained assets.
A new recipe requires a greater runtime version than existing published cores.
Never delete native releases, assets, or tags, including during cleanup.
Whole-release retention remains necessary even when GitHub immutability is enabled.

On 2026-11-04, `GET /repos/koed-labs/koed/immutable-releases` reported
`enabled: false` and `enforced_by_owner: false`. This work does not change that
repository setting. The publication adapter provides no overwrite or delete
operation. Administrators can still remove or change releases outside that
adapter. GitHub immutability and a live product-publication retry remain pending
the normal repository configuration and release approval process.

The retention review on 2026-11-04 found no release or tag deletion path in
the repository workflows and release scripts. The product release workflow
selects an exact `v<product-version>` tag. `ensure-release-assets.mjs` accepts
only an existing draft and refuses changed asset bytes. Product promotion also
requires that exact product tag. The native publisher uploads every required
asset before publication, rejects changed bytes, and treats published retries
as read-only authentication. These controls do not restrict administrator actions
outside the repository workflows. A fresh GitHub read still reported immutability
disabled and no `native-core-` tags.

The new workflow is prepared but has not run on GitHub. No native release or
production pin from this work is published. The compiled native catalog remains
unset until a retained release and its exact URLs and digests receive review.

Reviewed pins live in `packages/koed-server/src/native-runtime-catalog-data.mjs`.
The Control Plane build reads that source authority and replaces stale compiled
data while bundling. The packaged export shares its module with runtime
consumers. Static inspection checks the effective packaged export without
executing candidate code. No environment variable can replace production pins.

The catalog records the core URL, recipe identity, archive and manifest digests,
compressed and expanded sizes, runtime version, minimum version, target, and
contracts. A complete CPU catalog has `cuda: null`. Core validation fixes
pgvector at 0.8.3 and rejects unsupported contracts, targets, and URLs.

Product promotion first authenticates the protected npm package. It then reads
the native authority inside that exact package and authenticates every referenced
native archive and manifest through bounded HTTPS reads. Missing or altered
assets fail before promotion. An unset catalog cannot authorize installation.
The Base component keeps its separate product-version admission checks.

## Independent Linux CUDA add-on candidates

`build-cuda-addon-linux-x64.mjs` prepares a separate CUDA candidate from
`cuda.linux-x64.json`. It requires a verified frozen core with the exact same
llama.cpp revision, target, and layout and embedding contracts. Postgres versions
and core recipe identities do not affect the CUDA recipe or frozen bytes.

The cold build requires an unprivileged Ubuntu 22.04 x64 user, CUDA toolkit 12.4,
and the normal C++ build tools. It uses a fixed environment and two compilation
jobs. The recipe records the source digest, installed package versions, tool and
toolkit file hashes, architecture list, build flags, and build and packaging logic.
The core and product versions do not enter CUDA provenance.

The archive contains only `koed-runtime/llama.cpp/cuda/` and its parent directories.
`native-cuda-manifest.json` lives inside that CUDA directory. The inventory
records file digests, modes, sizes, and direct relative library links. The builder
stages required CUDA runtime libraries recursively from the toolkit. It includes
license files and never bundles the host `libcuda.so.1` driver. Escaping links,
link chains, hard links, special files, and content outside the payload fail admission.

The separate budget is 750 MB compressed and 1.6 GB of expanded regular files.
Those limits use the ticket 01 CUDA packaging measurement as their initial basis.
The historical combined baseline and the CPU budgets remain unchanged.
Frozen repackaging verifies inventory and produces the same archive with the
same Node packaging runtime. Fresh compilation reproducibility remains unproven.

The builder, fixture tests, and combined-layout loader runner are prepared but
unrun. No independent CUDA candidate or production CUDA pin exists yet. All CUDA
testing remains deferred for the Operator's machine arrangement. The
[CUDA handover](qualification/linux-cuda-handover.md) packages the source checks,
exact CPU candidate, commands, expected results, and the remaining release gates.
Its layout check does not replace GPU inference through the shipped CLI validator.

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

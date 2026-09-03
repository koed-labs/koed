# CI and release validation

Koed uses a tiered GitHub Actions workflow so inexpensive failures stop more
expensive validation before a macOS runner is allocated.

## Pull requests

Every pull-request update runs these gates in order:

1. `Static checks` verifies environment examples, formatting, lint, production
   types, and test-source types without starting Postgres or Redis.
2. `Tests` and `Build` run in parallel after static checks pass. Tests owns the
   Postgres and Redis services and migration acceptance checks.
3. `Relevant packaged Desktop app smoke` starts after a successful `Build`,
   without waiting for `Tests`, and runs only when the tested change policy
   identifies a Desktop, packaged-runtime, shared dependency, native script,
   package metadata, lockfile, CI, or release workflow change. `CI required`
   still waits for both `Tests` and the policy-selected packaged validation.

The exact path policy is implemented in `.github/scripts/ci-policy.mjs` and
covered by `scripts/ci-policy.test.mjs`. Documentation-only changes skip macOS.
Unknown paths are treated as relevant so a newly introduced runtime area cannot
silently bypass packaged validation.

Add the `full-ci` label to a pull request to force the app-only packaged smoke.
The label does not select release distribution artifacts; the generated
Changesets head branch, `changeset-release/main`, selects that stricter gate
only when the head branch belongs to this repository. A fork using the same
branch name cannot select release-candidate validation.

There is no contributor-controlled skip label or dispatch option. For trusted
automation only, a repository administrator may set the
`KOED_TRUSTED_PACKAGED_CI_SKIP_SHA` Actions variable to one exact pull-request
head SHA. The exemption cannot skip a Changesets release pull request and stops
matching as soon as the pull-request head changes.

`CI required` is the stable branch-protection status. It verifies both required
job success and policy-correct conditional skips, including cancelled jobs.

### Branch-protection rollout

Keep the existing required checks while the workflow change is under review.
After the updated workflow has produced its first successful `CI required`
check, update the active default-branch ruleset in one operation: add
`CI required`, then remove the superseded `Format, Typecheck, Test` and `Build`
contexts. Confirm a documentation-only pull request and a packaging-relevant
pull request can both satisfy the new aggregate before treating the migration
as complete. Do not require `CI required` before a commit containing that job is
available on GitHub, because doing so would leave every pull request waiting on
a check that cannot run.

## App-only packaged smoke

Relevant pull requests restore a macOS arm64 native payload using a key that
includes the pinned sources, native build and validation scripts, platform,
architecture, and Xcode fingerprint. The workflow validates that trusted
payload once, then regenerates the current commit's manifest and provenance in
a lightweight staging step. The app-only tier does not create a duplicate
native archive or checksum and relies on the packaged install and daemon smoke
to exercise the staged copy end to end.

Pull-request jobs use the cache in restore-only mode. They can read the trusted
default-branch payload but cannot populate a cache for other pull requests. A
separate `Native runtime cache` workflow is the only writer for this payload. It
runs from trusted `push`, scheduled, or manual events on `main`, validates every
restored payload, and saves a cold-built payload only after independent
validation succeeds. Its immutable key has no partial restore fallback.

This tier builds and ad-hoc-signs the Electron `dir` target, verifies the
unpacked `.app` once, and runs the complete healthy packaged smoke. The pinned
embedding model is restored by SHA-256 and copied into the smoke's
otherwise-empty `KOED_HOME`; model status verifies the checksum before the
daemon starts. The smoke also installs the pinned Privacy model, starts the
Privacy Filter Service from the exact packaged app runtime, verifies CPU and
Core ML classifier parity on Apple Silicon, and performs an authenticated
classification before starting the daemon. A second focused mode temporarily
masks the packaged `postgres`
and `llama.cpp` directories, runs only packaged-CLI `package status`,
`runtime status`, and `doctor --json` assertions, and restores the directories.
It neither rebuilds the app nor launches the renderer, collaboration broker, or
daemon. The job does not create or upload a DMG, ZIP, block map, or release
artifact. Diagnostics are uploaded only on failure.

## Release candidates and releases

The Changesets release pull request runs `Full release-candidate Desktop
validation`. It independently builds the native runtime from its pinned source
inputs, extracts and validates the completed archive, verifies executables and
loaders, starts Postgres to create required extensions, validates the packaged
provider, packages the verified native input twice, and requires identical
trees, manifests, provenance, and archive bytes. It builds the app/DMG/ZIP and
block maps, regenerates Desktop runtime staging, builds a second isolated app,
requires identical symlink-aware runtime and app trees, verifies the app and
mounted DMG, and runs both packaged daemon startup cycles. These are validation
outputs, not publishable release artifacts.

After the Changesets pull request merges, `.github/workflows/release.yml`
remains the publication authority. It rebuilds from the exact release commit,
keeps the GitHub release as a draft through build and validation, uploads
checksummed artifacts, verifies the required asset set, and only then publishes.

Each standalone release target is built twice from clean output paths. The
workflow compares its complete package tree, manifest, provenance, and archive
bytes before upload, then runs the deterministic artifact inspector.
The inspector combines target tokens with ELF, Mach-O, and PE header inspection
so architecture-neutral native filenames cannot hide foreign binaries. It scans
eligible text files with bounded overlap between streamed chunks so split source
checkout paths still fail the release policy.
Before upload, it installs the pinned Privacy model into an empty temporary
`KOED_HOME` and runs authenticated classification from the exact standalone
runtime: CPU on Linux x64 and Core ML with CPU parity on macOS arm64. CUDA proof
remains a separate trusted-hardware requirement; a hosted CPU runner does not
claim it.
The readable composition summary is appended to the job summary, while the
stable, target-specific
`koed-server-app-runtime-<platform>-<arch>-artifact-size-report.json` is
uploaded beside the target sidecars. Approved thresholds live in
`config/release-artifact-size-policy.json`; the immutable v0.6.2
comparison values live separately in
`config/release-artifact-baseline-v0.6.2.json`. Validation must never derive or
rewrite either limit from the artifact currently under test.

The Linux native-runtime release job runs the same inspector against the solid
gzip archive. It publishes
`koed-native-runtime-linux-x64-artifact-size-report.json`. The report separates
PostgreSQL, pgvector, CPU llama.cpp, CUDA
llama.cpp, CUDA redistributable libraries, and manifest/provenance bytes.
Expanded component bytes are exact. Per-component compressed bytes are labelled
as proportional estimates because gzip does not expose independently compressed
members. CI compares the exact total archive size with the immutable v0.6.2
baseline and fails above the reviewed 5% growth allowance.

Trusted CUDA evidence is produced only by the manually dispatched
`Trusted Linux CUDA package validation` workflow on the protected default
branch. Its self-hosted runner must have the `koed-cuda` label and a compatible
NVIDIA GPU/driver. The job consumes the exact independently cached native
payload, validates the extracted archive, runs real CUDA llama.cpp embedding
inference with CPU parity and VRAM evidence, and runs the exact standalone
Privacy Filter payload through CUDA initialization, classification, provider
switching, parity, idle unload/reload, and fail-closed unavailable-provider
checks. The evidence artifact is retained for 30 days. Hosted policy CI and a
runner without those labels cannot claim this proof.

Desktop release and recovery workflows also publish
`desktop-artifact-size-report.json`. It separates the Electron framework and
shell, logical main and preload contents in `app.asar`, renderer assets,
shared app runtime, native runtime, and code-signature bytes. Exact DMG and ZIP
bytes are compared with the immutable v0.6.2 values and fail unless both are at
least 20% smaller.

## Scheduled and manual validation

The weekly scheduled CI run selects full clean-install validation. It bypasses
the completed native payload cache and installs the pinned embedding model over
HTTPS into an empty `KOED_HOME`.

Native cache maintenance is deliberately separate from release validation. A
trusted `main` workflow runs after changes to native cache inputs and on Tuesday
and Friday. Restoring the payload refreshes its last-access time comfortably
inside GitHub's default seven-day retention window. A miss performs the cold
source build; the completed payload is validated before it is saved. Manual
cache maintenance must also be dispatched from the default branch. After a
cache-input workflow change lands, dispatch cache maintenance on `main` before
using the next relevant pull request as a warm-cache performance measurement.

Manual `CI` dispatch supports:

- `standard`: static checks, tests, and build only;
- `app-only`: cached native payload and unpacked-app smoke;
- `full`: cold native build and full distribution validation with the pinned
  model cache;
- `clean-install`: the full path plus a real external model installation.

The separate Linux x64 native build can also be selected for dependency bumps
or explicit review. It runs on GitHub-hosted Ubuntu 22.04, restores the verified
content-addressed payload when available, and cold-builds only on a cache miss.
The trusted default-branch Linux cache workflow writes the release-authoritative
cache; explicit proof runs may retain only their branch-scoped result. Product
release requires the default-branch cache and only validates, versions,
checksums, and publishes the native artifact; it never starts an unplanned CUDA
compilation.

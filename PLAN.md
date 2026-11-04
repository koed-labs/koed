# Plan: lightweight Linux runtime with an optional CUDA add-on

Status: proposed, 2026-11-04. Scope is Linux x64 only.

## Summary

Ship the Linux native runtime as two verified downloads, both managed by
`koed runtime install`:

- A small core archive: Postgres, pgvector, CPU llama.cpp, and the launcher.
  New Linux x64 installs through the `release` provider get this.
- An optional CUDA add-on exposed as `llama.cpp/cuda/` beside the CPU build.
  Operators opt in with one command.

Keep the existing native entry paths under `KOED_HOME/runtime`. Add immutable
payload directories and one selection pointer behind those paths. Require Koed
to be stopped before runtime changes. Startup checks the selected runtime's
integrity and compatibility. Automatic acceleration falls back to CPU.
Explicit CUDA configuration continues to fail when CUDA is unavailable.

Ship the core and the `release` CLI provider independently of the CUDA add-on.
A real GPU run gates add-on publication, but does not block the CPU path.
The separate `install.sh` remains out of scope.

## Current state

- No CLI path to the native runtime archive. `koed-native-runtime-linux-x64`
  is 735 MB, and only CI, release, and packaging scripts use it. `--provider
  packaged` copies from local app resources and has no download path.
- Linux installs depend on Homebrew. The documented npm path runs `brew
  install postgresql@17 pgvector llama.cpp`.
- The archive is almost entirely CUDA. Figures from the v0.10.3 size report:

| Part                           | Compressed (estimate) | Unpacked |
| ------------------------------ | --------------------- | -------- |
| llama.cpp CUDA build           | 441 MB                | 915 MB   |
| CUDA redistributable libraries | 266 MB                | 552 MB   |
| llama.cpp CPU build            | 17 MB                 | 35 MB    |
| PostgreSQL and pgvector        | 10 MB                 | 22 MB    |

The Homebrew formula reviewed on 2026-11-04 uses system ggml for llama.cpp.
Its Linux ggml configuration enables Vulkan and OpenBLAS, without enabling CUDA.
See the [llama.cpp formula](https://raw.githubusercontent.com/Homebrew/homebrew-core/HEAD/Formula/l/llama.cpp.rb)
and [ggml formula](https://raw.githubusercontent.com/Homebrew/homebrew-core/HEAD/Formula/g/ggml.rb).
Koed's `apps/embedding-service/src/acceleration.ts` classifies devices other than
CUDA or Metal as CPU. These sources indicate that the standard Homebrew Linux
path does not currently provide CUDA embeddings through Koed. Runtime confirmation
remains part of Phase 0. This conclusion does not cover custom builds or binary
overrides. The add-on introduces CUDA capability for the standard Linux path.

The compressed values are proportional estimates. Phase 0 measures the actual
archive sizes. The estimated reduction from 735 MB to about 27 MB applies only to
the native archive. Today's npm installation uses Homebrew and does not download
that archive.

Measure the complete CPU installation as well: npm package, Base component,
native dependencies, and embedding model. Record network bytes, final disk use,
and peak additional disk space during installation. Use the same product version,
model, clean Linux image, and empty caches for both installation paths. Report
Node and Homebrew bootstrap costs separately, with each path's prerequisites
stated. Do not count an optional Privacy Filter or CUDA add-on as required CPU
installation content.

## Decisions

1. CPU is the default installation. An explicit CUDA request can install or update
   the core and add-on together. There are no separate Linux installer variants.
2. Native runtime pins are independent of the Koed version. Koed upgrades do
   not re-download the runtime unless its pins change. This needs an ADR
   (next number currently available: 0067). Recheck the number when adding it.
3. Retire the 735 MB release asset after both replacement paths pass acceptance.
   Keep publishing it while the CUDA add-on is pending. After retirement, retain
   it only as an internal CI artifact. Assets on past releases stay in place.
4. CUDA is always opt-in. Koed can suggest the command when it finds an NVIDIA
   GPU, but never downloads the add-on automatically.
5. Operators stop Koed before changing the runtime and start it afterward.
   The CLI does not stop, restart, or automatically roll back running services.

## Target experience

Default Linux setup:

```bash
koed runtime install --provider release --dependency-mode bundled-local
```

For an existing installation, stop Koed before adding CUDA, updating the core,
or removing the add-on. The install command refuses changes while the supervisor
or its managed native processes are running. It leaves service lifecycle control
with the Operator.

For example, add CUDA to an existing installation:

```bash
koed stop
koed runtime install --provider release --dependency-mode bundled-local --with-cuda
koed start
```

With Koed stopped and the effective acceleration policy set to `auto` or `cpu`,
remove the add-on:

```bash
koed runtime install --provider release --dependency-mode bundled-local --without-cuda
```

After a successful installation, run `koed start` when ready. Installation success
means that the selected native payload passed staged checks. It does not claim
that the full Koed service stack has started or passed its health checks.

The mutually exclusive `--with-cuda` and `--without-cuda` flags control installed
assets. Reject either flag with another provider, and reject both together.
Neither flag changes `KOED_EMBEDDING_ACCELERATION`, the Desktop preference, or
other persisted configuration. With the default `auto` policy, adding CUDA enables
its use on the next start when available. With an explicit `cpu` policy, CUDA
remains installed but unused.

If the effective policy forces CUDA, removal refuses before changing the install.
The error explains how to select `auto` or `cpu` first. Command output reports
both installed assets and the effective execution policy.

Without either flag, a fresh install gets the core. An update preserves a
compatible installed add-on and never downloads CUDA. `--with-cuda` stages the
required pinned core and add-on together, then selects them with one pointer swap.
This also works when the core is missing or needs an update. With unchanged pins
and intact assets, repeating a command performs no download, replacement, or restart.
An integrity failure must produce a repair action rather than a false success.

## Design

### Artifacts

Support core-only builds without a CUDA toolkit, GPU, or previously built CUDA
payload. When both payloads exist, package them as separate archives:

| Archive                                       | Contents                                                  |
| --------------------------------------------- | --------------------------------------------------------- |
| `koed-native-core-<core-id>-linux-x64.tar.gz` | Postgres, pgvector, CPU llama.cpp, launcher, and metadata |
| `koed-native-cuda-<cuda-id>-linux-x64.tar.gz` | Only `llama.cpp/cuda/`, with its own manifest             |

- Generate `runtime-asset-manifest.json` from the core-only tree. The generator
  adds the CUDA variant only when `cuda/llama-server` exists. Keep the add-on
  inventory separate so its installation does not invalidate the core inventory.
- Remove the Koed version from in-archive provenance. Each archive's provenance
  describes only its own inputs. A Postgres change must not change CUDA metadata
  or force a new CUDA archive.
- Require identical archive bytes when packaging the same frozen runtime tree
  and metadata. Measure source-build reproducibility separately. Repacking an
  existing tree does not prove that fresh compilations produce identical binaries.

### Native archive extraction

The current archive contains 32 symlinks. `extractVerifiedPackageArchive` rejects
all symbolic links and hard links. Reuse of that extractor is blocked today.

Add a native-specific extraction policy that preserves relative library symlinks.
Keep the current component extraction policy unchanged. Make sure that archive
paths and resolved link targets stay inside the permitted payload root. Reject
absolute links, escaping link chains, hard links, duplicate paths, special files,
and writes through symlinked parents. Include link targets and executable modes
in the pinned inventory, alongside regular-file digests.

For the add-on, the permitted root is `llama.cpp/cuda/`, including its manifest.
Make sure that its links cannot reach the CPU payload or other runtime files.
Retain bounded extraction and test the actual split archive layout in Phase 0.
Phase 0 records the extraction contract and failing fixture. Phase 2 implements
the extractor before any native installation can ship.

### Pinning and hosting

- Two independent IDs identify complete build recipes. Include upstream digests,
  compiler and toolkit identities, build flags, target architecture, build
  scripts, launcher code where included, bundled libraries, and packaging policy.
  `core-id` covers the core recipe. `cuda-id` covers the CUDA recipe and supported
  GPU architectures, without unrelated Postgres inputs. Recipe changes require a
  new ID even when upstream versions stay the same.
- CPU and CUDA share one pinned llama.cpp revision. Record that revision and the
  launcher/add-on layout version as explicit compatibility fields. Matching
  upstream version labels alone do not establish layout compatibility.
- `scripts/native-runtime/published.linux-x64.json` holds each ID, URL, archive
  SHA-256, compressed and expanded sizes, manifest digest, and compatibility
  fields. Compile it into the Koed Server Control Plane, with no Operator override,
  following the trust model in ADR 0057.
- A manual workflow builds and publishes archives when any relevant recipe input
  changes. A reviewed PR then updates the lock file. Product releases consume
  the pinned archives without rebuilding them. A core-only lock file is valid
  until the CUDA add-on passes GPU acceptance.
- Never overwrite an archive or change its digest under an existing ID. If a
  rebuild differs, investigate the inputs and revise the recipe before publication.
- Publish tags such as `native-linux-x64-<id>` with `--latest=false`.
  Keep native releases separate from the latest product release. The planned
  `install.sh` can then use `releases/latest/download/...` for product assets.

The review reports that GitHub release immutability is disabled for this repository.
Confirm the setting during Phase 0. Hash pins detect replaced assets but do not
keep deleted assets available to older CLIs. Never delete published native releases,
their assets, or their tags. Exclude them from automated release cleanup.

Prefer enabling [GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
after testing compatibility with product publication and retry behavior. Upload all
assets to a draft before publishing. Even with immutable assets, retain the rule
against deleting the whole release. If the setting remains disabled, document that
limitation and enforce no-overwrite and no-delete rules in publication and cleanup
workflows. Do not describe naming conventions alone as enforced immutability.

### Runtime compatibility

Give the core a monotonic runtime version separate from its recipe ID and the
product version. Compile `minimumCoreVersion` and supported native contract versions
into the Control Plane. A contract version describes required executable options,
directory layout, and runtime behavior. Raise the minimum when new service code
requires a llama-server option or behavior that an older core lacks.

For a release-managed native installation, require an admitted core at or above
that minimum before starting services. Require a supported contract, platform,
and architecture. Recheck the selected files and inventory. Below the minimum
or outside the supported contracts, fail with a
complete `runtime install --provider release --dependency-mode bundled-local`
repair command. Include `--with-cuda` when the effective policy requires CUDA.

An older core that still meets those requirements is outdated but usable. Report
the available update without downloading anything or blocking startup. An opaque
recipe hash has no version ordering. Do not compare recipe IDs to decide freshness.

For CUDA, require the exact core llama.cpp revision and a supported add-on layout
contract. Check the host driver and executable capability separately. Existing
admission state can describe a previously trusted install but cannot authorize
new unpinned downloads. These native checks do not weaken product-version checks
for the Base component or its generation.
Homebrew, packaged native resources, and explicit binary overrides retain their
existing checks. They do not require a release-provider core ID.

### Native payload store and selection

Store admitted payloads under `KOED_HOME/runtime/native/core/<core-id>/` and
`KOED_HOME/runtime/native/cuda/<cuda-id>/`. Never mutate a published payload directory.
Build an immutable selection under `runtime/native/selections/<selection-id>/`.
Its manifest identifies the core, optional CUDA add-on, inventory digests, and
runtime contracts.

The selection contains a Postgres link and a `llama.cpp/` directory. Link its
launcher and CPU payload to the core, and its optional `cuda/` to the add-on.
Create these composition links locally from admitted IDs. They are separate from
the bounded archive-link policy. Require every composition target to stay inside
the admitted native store.

Keep `runtime/postgres` and `runtime/llama.cpp` as fixed links through
`runtime/native/current`. Atomically rename a temporary symlink over `current`
to select the complete pair. Resolve that selection once for startup and staged
tests, so they cannot combine files from different selections. Update the native
path resolvers without relaxing unrelated no-follow checks in the component store.

A core update can reference the existing compatible CUDA directory without copying
it. Preserve the prior complete selection for diagnosis and manual recovery.
Phase 0 must prove that Postgres, library loading, and the launcher work through
this link layout. Create the fixed
entry links only for a fresh or already release-owned installation. Refuse unknown
pre-existing paths instead of replacing them.

The selected manifest is the authority for the native pair. Treat
`cache/runtime-release.json` as derived status data. A crash between the pointer
swap and cache update must not select a different pair. Retain selections and
payloads referenced by `current` or an active process. Do not delete the prior
selection during activation. Automatic payload cleanup is deferred.

### The `release` provider

`koed runtime install --provider release --dependency-mode bundled-local`:

1. Checks the platform and glibc 2.35 or later, and stops with a clear error
   otherwise. On Linux x64 below that baseline, suggest
   `koed runtime install --provider homebrew --dependency-mode bundled-local`.
   State that Homebrew and its own host requirements still apply.
2. Refuses runtime changes unless Koed is stopped. Report `koed stop` and retry
   instructions if it is running. If process ownership or state is uncertain,
   refuse with an Operator diagnostic action.
3. Makes sure that space covers the download, staging, retained prior payload,
   and newly required payloads. Reused CUDA does not need another copy. Derive the
   requirement from pinned sizes and actual local state, with a documented reserve.
4. Downloads the pinned core archive through a shared bounded download helper.
   The existing `component-store.ts` limit is 2 GiB, which permits the estimated
   700 MB add-on. Stream archive bytes to disk rather than retaining them in RAM.
5. Makes sure that the archive and extracted inventory match the compiled pins.
6. Builds and activates an immutable selection through the stopped-runtime flow below.
7. Refreshes `cache/runtime-release.json` from the selected manifest and reports
   the `koed start` command. The installer does not start services.

`runtime status --provider release` reports the installed and pinned IDs without
downloading anything. `koed start` continues to never download runtime assets.

### Activation while Koed is stopped

Use the same stopped-runtime flow for core installation, core replacement,
CUDA installation, and CUDA removal. No native transaction journal, separate
ownership guard, or restart handoff is required.

`pinGenerationForStart` holds the lifecycle lock until its generation pin is
released. Reuse that lock to exclude concurrent packaged starts and activation.
Its existing PID, process-identity, and owner checks remain authoritative. Check
the supervisor and managed native processes too, including source-mode processes
that do not hold a packaged-generation pin. An install must not infer that Koed
is stopped merely because a lock is absent.

1. Require stopped Koed before staging changes. Download and extract into a unique
   staging directory without changing the active selection. Record the expected
   current selection in memory. Keep final payloads and selection pointers on
   the same filesystem.
2. Acquire the existing lifecycle lock before final validation and activation.
   Recheck that Koed is stopped, the caller owns this installation, and `current`
   still matches the expected selection. If another start or install won the race,
   refuse and report how to retry. Do not stop that process or overwrite its work.
3. Make sure that every start path which can use this native selection respects
   the same exclusion. Recheck native selection integrity and compatibility while
   startup holds the lifecycle lock. Do not weaken generation or Desktop ownership
   checks to support source-mode startup.
4. Under the lock, validate the candidate and run isolated native smoke tests.
   For CUDA, run the staged device and agreement tests while Koed remains stopped.
   Invoke candidate executables directly, never `koed start`. Bound test duration,
   use isolated ports and temporary data, and terminate test processes before
   activation or lock release. Leave live Postgres data and unrelated GPU apps alone.
5. Flush the admitted payloads and selection metadata before publication.
   Atomically rename a temporary symlink over `current`, then flush its parent
   directory. This swap is the activation boundary for the complete core/CUDA pair.
6. Refresh derived status and release the lock in a `finally` path. Report the
   selected IDs and the command to start Koed. No production process is started.

Before the pointer swap, any failure leaves the old selection unchanged. After
the swap, the new complete selection remains active even if the process exits
before updating the cache. Status derives the selected IDs from `current` and its
manifest. Report a cache-write failure without claiming that activation was undone.
The next install can reconcile derived metadata without swapping payloads again.

A process crash leaves either the old or new complete selection. A failed first
install before the swap leaves no selected runtime. Startup validates the selection
that exists and never automatically repoints to an older one. If a later manual
start fails, report the error and leave recovery to the Operator.

Keep existing fail-closed behavior for stale or unreadable lifecycle locks. Do not
add automatic lock reclamation in this work. Document stopped-runtime Operator
recovery, including proof that the recorded owner and affected processes are gone.
Never suggest removing a lock solely because an installer exited or a PID changed.

### The CUDA add-on

`--with-cuda`:

1. Require stopped Koed and resolve the pinned core and add-on as one candidate.
   Install or update either payload when required. If no CUDA pin is published, report that
   the add-on is unavailable without changing the existing selection.
2. Test the machine. Require driver 550.54.14 or later and a loadable
   `libcuda.so.1`. Other CUDA libraries are bundled, so this check is separate from
   and smaller than the Privacy Filter check.
3. Calculate peak space through the stopped-runtime preflight. About 2.2 GB
   covers the estimated download and unpacked files only. Existing payloads,
   retained prior selections, and the reserve can increase that requirement.
4. Download and stage the add-on through the native extraction policy. Reject
   every payload path or resolved link target outside `llama.cpp/cuda/`.
5. With Koed still stopped and the lifecycle lock held, test the staged selection.
   `--list-devices` must report CUDA. If the embedding model is installed, require
   finite, nonempty, dimension-matched vectors and cosine agreement of at least
   0.999 for every synthetic test input. If the model is absent, report that only
   the device check ran. Terminate test processes before releasing the lock.
6. Activate through the atomic pointer swap, then report how to start Koed.

Failed staging or native validation leaves the prior selection unchanged, including
an existing CUDA add-on. There is no automatic rollback after activation. An
explicit `cuda` policy keeps failing closed, as ADR 0031 requires. The install flag
never silently changes that policy.

Move the minimal agreement runner and threshold into code shipped with the CLI,
for example `packages/koed-server/src/runtime-release-validation.ts`. The current
threshold lives in workflow `jq`, and supporting logic under `scripts/` is absent
from the npm package. Have the GPU workflow call the shipped validation path.
Test from the packaged npm CLI without a repository checkout or network model
download. Distinguish unavailable devices, external VRAM pressure, and failed
vector agreement in errors.

### Hints

After a CUDA pin is published, `koed status` and setup can print the complete
add-on command when `nvidia-smi` finds a GPU and `cuda/` is missing. Keep discovery
read-only and use a short timeout. Report incompatible or stale add-ons separately
from missing ones. A hint does not prove that the machine can run CUDA.

### Pin changes on upgrade

- If only a supported Postgres minor update changes the core, reference the
  unchanged compatible CUDA payload in the new selection. Do not download or copy it.
- With `--with-cuda`, stage the pinned core and compatible add-on together.
  A llama.cpp revision change therefore needs no intermediate CPU selection or
  temporary change to forced CUDA policy. Failed staging retains the prior pair.
- If a core update makes the installed add-on incompatible, remove it from the
  candidate only when the command omitted `--with-cuda` and the policy permits CPU.
  Under `auto` or `cpu`, activate CPU and report the `--with-cuda` command.
  Preserve the prior selection for diagnosis and manual recovery.
- If the effective policy forces CUDA, refuse a default core update that would
  drop CUDA before activation. Recommend the complete `--with-cuda` update
  command. Explicit `--without-cuda` still requires the Operator to choose a
  non-CUDA execution policy first.
- If only the CUDA pin changes, report the available update. Require an explicit
  `--with-cuda` command to download and replace the installed add-on.
- If the Control Plane changes before the runtime is updated, report installed
  and pinned IDs. Enforce the compiled minimum core version and supported
  contracts at start. A merely outdated compatible installation can still run.
- Reject a Postgres major-version change before activation. Data migration stays
  out of scope and requires its own plan.

### pgvector changes

The bootstrap currently executes `CREATE EXTENSION IF NOT EXISTS vector`.
It does not upgrade an existing database extension. A new pgvector library can
require SQL extension changes as well as different files.

Keep the pgvector version fixed for the initial rollout. Before supporting a
version change, inspect `pg_extension.extversion` in the Koed database and define
the supported upgrade path. Test any required `ALTER EXTENSION vector UPDATE`
operation and its interaction with the previous binaries. Refuse an unplanned
extension-version change before swapping the native selection. Selecting older
binaries does not reverse database changes. The installer performs no extension
upgrade or database rollback.

### Existing Homebrew installs

Until migration has been tested, `--provider release` refuses to replace an
existing Homebrew install and explains why. Those installs keep working on
`--provider homebrew`.

The Linux x64 default for `--provider` changes to `release` for new installs only.
An install with `runtime-homebrew.json` keeps Homebrew as its default. macOS stays
on Homebrew.

This default change applies to CLI calls that omit `--provider`. The root
`runtime:install` script still explicitly selects Homebrew, as does `runtime:status`.
Source-checkout Quickstart and `local:setup` keep that behavior. Desktop continues
to select packaged resources when available and otherwise uses its Homebrew path.
Changing those entry points is outside this plan.

## Implementation phases

Each phase is one PR, except Phase 0, which changes no production code. Phases
1–4 deliver the CPU path. Phase 5 requires GPU access. Phase 6 retires the old
asset only after the CUDA replacement works.

### Phase 0: measure and verify

- Split a v0.10.3 archive locally and record the real compressed sizes.
- Record the complete Homebrew installation baseline and a provisional CPU
  download total from the npm package, Base component, core, and embedding model.
  Phase 3 replaces the provisional total with a measured installation.
- Run `validate-runtime` and loader validation on a core-only tree. Identify
  assertions that currently require CUDA and distinguish them from CPU failures.
- Exercise the launcher without `cuda/` in `auto`, `cpu`, and `cuda` modes. Expect
  CPU, CPU, and exit code 69.
- Prove Postgres initialization, restart, pgvector loading, and CPU embeddings
  through the proposed selection and entry symlinks. Exercise launcher discovery
  through that layout and record any required resolver changes.
- Record the symlink inventory, extractor refusal, and native extraction contract.
- Define the per-artifact recipe inputs and distinguish packaging reproducibility
  from fresh compilation reproducibility.
- Record the reviewed Homebrew formula versions and device listing on Linux.
  Confirm the expected absence of CUDA through the standard Koed Homebrew path.
- Confirm the repository's release-immutability setting and test the product
  draft/publication flow before proposing a setting change.

Acceptance: Record the baseline and archive measurements here. Demonstrate that
the core runs through the proposed link layout and document the extraction work
required. If the core exceeds about 50 MB, review its contents before continuing.

### Phase 1: publish the independent core

- Add the ADR and update the superseded packaging direction in ADR 0031.
- Update `scripts/native-runtime/build-linux-x64.mjs` to support core-only builds
  and separate archive packaging.
- Add the recipe identities, publish workflow, and core lock-file entry.
- Add the core runtime version and contract metadata. Document no-delete and
  no-overwrite rules and enforce them in native publication and cleanup workflows.
- If the product release flow supports it, enable GitHub release immutability
  through the normal repository configuration process and record the result.
- Make product release checks authenticate every published native pin before
  promotion, starting with the core. Keep the existing reviewed-build and
  publication approval boundaries.
- Add per-archive size gates to `scripts/release-artifact-inspector-lib.mjs`.
- Add core-only content and loader validation without weakening CUDA validation.
- Keep the old combined release asset available during this transition.

Acceptance: Repeated packaging of the same frozen core produces identical bytes.
Publish the core under its recipe tag and compile its pins into the Control
Plane. Record which immutability and retention protections are enforced.
Core publication must not require CUDA tooling or a GPU run.

### Phase 2: native downloads, extraction, and admission

- Add bounded downloads, native extraction, recipe and pin admission, and
  immutable payload staging. Keep activation unavailable in this phase.
- Add compatibility metadata validation and complete pinned inventory checks.
- Test real archive layouts, safe relative links, malformed inventories, path
  escapes, hash failures, cancellation, and disk exhaustion.

Acceptance: The core can be staged and admitted from its published pin without
changing `current`, stopping services, or mutating existing runtime installations.
The existing component extractor continues to reject archive links.

### Phase 3: stopped-runtime activation and `release` provider

- Add `packages/koed-server/src/runtime-release.ts` and wire it into `cli-runtime.ts`.
- Implement immutable selections, the atomic `current` swap, and derived status.
- Update `local-postgres-runtime.ts` and `local-embedding-runtime.ts` to resolve
  one admitted native selection, while preserving other providers and overrides.
- Add selected-runtime integrity and compatibility checks in `start.ts` and
  `service-runtime-selection.ts`. Serialize selection reads with activation using
  the existing lifecycle lock, including source paths that use the native store.
- Expose the existing stopped-runtime lifecycle exclusion to the installer without
  changing its owner checks or stale-lock behavior. Add no native transaction
  journal or automatic service lifecycle operations.
- Document refusal while running, lock contention, and safe Operator recovery
  for a stale lock. Report `koed start` after a successful install.
- Add Homebrew refusal, glibc fallback guidance, and pgvector version guards.
- Test the complete installation from a packaged CLI and Base component.
- Measure download bytes, final disk use, and peak space against the Phase 0
  baseline. Record the actual improvement and the remaining largest payloads.

Acceptance: On clean Ubuntu 22.04 without Homebrew, install the Base component,
native core, and embedding model. An explicit `koed start` then reaches healthy
CPU operation. An install while Koed is running refuses changes. Repeating an
unchanged install performs no download or replacement. Concurrent start/install
and crash tests prove that selection remains complete and protected by the lock.

### Phase 4: ship the CPU default

- Change the Linux default provider for new installations. Preserve Homebrew
  selection for existing installations and leave macOS unchanged.
- Keep explicit source-checkout and Desktop provider choices unchanged.
- Update the generated npm README, runtime guidance, and installation documents.
  Include explicit stop/install/start instructions for runtime changes and the
  complete commands for fresh setup.
- Update `docs/running-koed.md`, `docs/configuration.md`,
  `docs/native-runtime-artifact-pipeline.md`, and `docs/ci-validation.md`.
- Correct the obsolete statement that the npm package is private.
- Before the release changeset decision, recommend a minor bump and request the
  confirmation required by `AGENTS.md`. This changes runtime setup for Users.

Acceptance: The documented CPU setup works from the published npm package.
Existing Homebrew installations retain their provider. This phase can ship while
GPU access or CUDA publication remains pending.

### Phase 5: publish and install the CUDA add-on

- Update `native-runtime-linux-cuda-validation.yml` to extract the exact core and
  add-on candidate archives. Run real GPU inference and CPU/GPU agreement checks.
- Publish the add-on only after that run passes. Review its lock-file entry.
- Add mutually exclusive `--with-cuda` and `--without-cuda` flags. Resolve core
  and add-on together for a `--with-cuda` request, including a first install.
- Ship the minimal agreement runner and 0.999 threshold in the npm CLI. Make
  the GPU workflow use that same path and test it without a checkout.
- Require stopped Koed for staged GPU tests and the pointer swap. Keep the
  lifecycle lock until tests terminate and activation finishes.
- Use stopped-runtime activation for removal and replacement. Add stale add-on
  handling, execution-policy reporting, and bounded GPU hints.
- Test compatible CUDA reuse without copying during a Postgres-only core update.
- Test combined core/add-on upgrades under forced CUDA without changing policy.
- Test forced CUDA refusal for a default incompatible update or explicit removal.

Acceptance: With `auto`, a GPU machine moves from CPU to CUDA and back through
explicit stop/install/start sequences. The install command never changes the
running state of production services. Explicit CPU configuration remains CPU
after add-on installation.
A machine without a usable GPU gets a clear refusal and retains its prior install.
Failed staged validation leaves the prior pointer unchanged. A crash around the
swap leaves one complete selection. No automatic restart or rollback occurs.

### Phase 6: retire the old asset

- Remove the asset from the `native-runtime-linux-x64-release-assets` job and the
  publish list in `.github/workflows/release.yml`. Keep it as a CI artifact.
- Update `scripts/ci-policy.test.mjs`, `scripts/release-promotion-workflow.test.mjs`,
  `scripts/reviewed-build-identity.mjs`, and related release checks.
- Preserve `config/release-artifact-baseline-v0.6.2.json` as the immutable historical
  baseline. Add separate core and CUDA budgets instead of rewriting old measurements.
- Remove combined-asset expectations from release checks. Retain authentication
  of the separate pinned native archives before promotion.
- Update the installation and release documents for the completed transition.

Acceptance: A release dry run passes without the old public asset. Both documented
installation paths work through the published packages and pinned native archives.

## Testing

| Layer                    | Coverage                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                     | Recipe identity changes, pin admission, bounded extraction, safe links, escaping link chains, modes, revision and layout mismatch                                |
| Activation               | Running-runtime refusal, uncertain process-state refusal, concurrent start/install, existing lock ownership, stale-lock refusal, crash before/after pointer swap |
| Native selection         | Postgres and launcher symlinks, pointer/derived-state disagreement, CUDA reuse without copies, retained prior selection, unrelated data preservation             |
| Hosted Linux CI          | Complete CPU install, CPU embedding, unchanged install without download or restart, explicit CUDA failure, compatible add-on preservation                        |
| Manual GPU (`koed-cuda`) | Exact archives, shipped agreement runner, stopped-runtime enforcement, isolated test cleanup, combined core/CUDA upgrade, forced CUDA, external GPU pressure     |
| Compatibility            | Minimum core rejection, supported contract rejection, outdated usable core, pgvector-version refusal, mutually exclusive asset flags                             |
| Footprint                | Actual archive sizes, complete download bytes, installed size, peak installation and update space, unchanged historical baseline                                 |
| Reproducibility          | Identical packaging of a frozen tree, recipe invalidation for build-script and architecture changes, independent Postgres/CUDA identity                          |
| Distribution             | Ubuntu 22.04 and 24.04, Debian 12, WSL2, and a clear refusal below glibc 2.35                                                                                    |

## Risks

| Risk                                                    | Mitigation                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Release CI has no GPU, so CI cannot prove CUDA works    | Require a `koed-cuda` run before publishing a new `cuda-id`. Ship the CPU path independently          |
| Large downloads can fail partway                        | Retry, reuse verified cached files, and never activate a partial download. Resume is a later addition |
| Native archives are published separately from releases  | Release checks confirm every pinned URL exists and matches before promotion                           |
| Hints suggest CUDA on a machine that then fails tests   | Test the candidate before the swap and leave the prior pointer unchanged on failure                   |
| A second version to track                               | Show native IDs in `koed runtime status` and release notes                                            |
| A successful pointer swap precedes a crash              | Keep the selected manifest authoritative and reconcile derived status without repointing              |
| Archive savings overstate the User's actual improvement | Measure the complete installation against the Homebrew baseline                                       |
| Published assets disappear despite valid pins           | Enforce no-delete rules for releases, tags, and assets, including under GitHub immutability           |
| An interrupted install leaves a stale lifecycle lock    | Refuse further changes and document stopped-runtime Operator recovery                                 |
| A new pgvector library requires database changes        | Refuse extension-version changes until a tested database upgrade plan exists                          |

## Out of scope

- Automatic stop, restart, health-based rollback, and crash-driven rollback
  orchestration. Operators control production services. No transaction ownership
  protocol, restart handoff, or automatic stale-lock reclamation is introduced.
- Automatic cleanup of retained native payloads. Keep the prior selection during
  this rollout and include retained disk space in footprint measurements.
- `install.sh`. It builds on this work, and its Node handling and URL choices
  are still open.
- macOS. It stays on Homebrew.
- Privacy Filter CUDA. It keeps its own variant and check, because it needs CUDA
  12.8 and driver 570.26. A machine can pass one check and fail the other.
- The standalone `koed-server` tarball. It still includes
  `libonnxruntime_providers_cuda.so` (301 MiB unpacked). npm installs do not download
  this tarball, so reducing it is a separate decision.

## Open questions

1. Homebrew migration. Can an existing Linux install move to `release` and keep
   its Postgres data? Both use major version 17, but this is untested, so migration
   stays disabled until it is.
2. GPU runner. Is a `koed-cuda` runner available? CUDA publication in Phase 5
   requires a real GPU run. The CPU release does not depend on that availability.
3. Source-build reproducibility. Which compiler, toolkit patch, and system-library
   inputs need stronger pins? Record the evidence separately from deterministic
   archive packaging before claiming identical fresh builds.
4. Release retention. Can the product publication flow enable GitHub release
   immutability without breaking retries? Confirm the setting and enforce retention
   of published native releases regardless of that decision.

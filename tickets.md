# Linux native runtime tickets

Approved ticket breakdown, 2026-11-04. Destination: local tickets only.

These tickets implement the lightweight Linux x64 runtime plan. CPU installation
must be able to ship without a GPU runner or a published CUDA add-on. Work on
any ticket whose blockers are complete. The `ready-for-agent` label describes
ticket readiness, not permission to ignore its blockers.

Shared constraints apply to every ticket:

- Require Koed to be stopped before runtime changes. Operators stop and start
  services explicitly. Do not add automatic stop, restart, rollback, a transaction
  ownership protocol, or automatic stale-lock reclamation.
- Use pinned immutable payloads and one atomic selection pointer. Preserve other
  runtime installations, models, Postgres data, and the prior complete selection.
- Preserve AI Client synthesis boundaries, existing runtime ownership checks,
  component admission checks, and the product-version binding of the Base component.
- Keep macOS, explicit source-checkout provider choices, Desktop provider choices,
  Privacy Filter CUDA, and the standalone Server archive outside this change.
- Defer the shell installer, Homebrew migration, database upgrades, and automatic
  native-payload cleanup. Unsupported changes must produce an actionable refusal.
- Include relevant tests and operational documentation with each behavior change.
  Before each release changeset decision, recommend the appropriate bump and obtain
  the confirmation required by the repository guidance. Recommend minor for the
  user-visible runtime setup changes.

## 01: Measure the footprint and prove the native selection layout

**What to build:** An evidence-backed baseline that demonstrates the CPU payload
can run independently and through the proposed selection links.

**Blocked by:** None (can start immediately).

**Status:** complete

Evidence: `docs/qualification/linux-native-baseline.md` and its JSON report.
The peak disk figure is sampled. Complete release-provider savings remain
provisional until tickets 05 and 07. No CUDA binary ran.

- [x] Split the existing Linux native archive locally and record actual compressed
      and unpacked sizes. Review the contents if the core exceeds about 50 MB.
- [x] Measure the complete existing Homebrew installation: npm package, Base
      component, native dependencies, and embedding model. Record downloaded
      bytes, installed size, and peak additional disk use on a clean Linux image.
- [x] State product/model versions, host assumptions, and cache conditions. Report
      Node and Homebrew bootstrap costs separately and exclude optional Privacy
      Filter and CUDA payloads from the required CPU total.
- [x] Record a provisional complete CPU download total for the proposed path,
      clearly distinguished from measured installation savings.
- [x] Demonstrate Postgres initialization and restart, pgvector loading, native
      library loading, and CPU embeddings through the proposed selection links.
- [x] Demonstrate launcher behavior without the add-on: CPU for automatic and
      explicit CPU policies, and the expected failure for explicit CUDA.
- [x] Record the archive's symlink inventory, the existing extractor's refusal,
      and the required native extraction boundary.
- [x] Record Homebrew formula versions and a Linux device listing. Confirm the
      expected lack of CUDA through the standard Koed Homebrew path without
      generalizing to custom builds or explicit binary overrides.
- [x] Separate repeatable archive packaging from fresh compilation reproducibility.
      Identify recipe inputs requiring stronger pins. No production code changes
      or GPU execution are required to complete this investigation.

## 02: Expose the existing stopped-runtime lifecycle exclusion

**What to build:** A small prefactor that lets a native installer use the existing
lifecycle exclusion without introducing a second ownership protocol.

**Blocked by:** None (can start immediately).

**Status:** complete

Evidence: `docs/stopped-native-runtime.md`, `stopped-runtime.test.ts`, and
the existing lifecycle suites. Focused regressions and production/test typechecks
passed. Production-file lint passed. Targeted test-file lint encounters the
Oxc inferred-project Node-type discovery limitation.

- [x] Expose the existing lifecycle lock and stopped-runtime observation through
      a bounded operation that later activation can reuse.
- [x] Preserve existing start, generation pin, shutdown, and Desktop ownership
      behavior. Retain immediate refusal on lock contention.
- [x] Distinguish stopped, running, and uncertain process state. Absence of a lock
      alone does not prove that the supervisor and its native processes stopped.
- [x] Preserve the existing PID, process-identity, and owner checks. Stale or
      unreadable locks still require Operator recovery.
- [x] Demonstrate that protected work releases the lock on normal completion or
      exceptions and cannot acquire it while a running generation retains it.
- [x] Keep current lifecycle tests green. Add focused regression coverage for the
      reusable boundary without adding automatic stop, restart, or reclamation.

## 03: Produce independently versioned CPU core candidates

**What to build:** A release pipeline can produce and validate a small CPU core
without a CUDA toolkit, GPU, or cached CUDA payload.

**Blocked by:** 01: Measure the footprint and prove the native selection layout.

**Status:** complete

Evidence: `docs/qualification/linux-native-core-2026-11-04.json` and
`docs/qualification/linux-core-handover.md`. The cold CPU-only build, extracted
archive qualification, identical frozen repackaging, focused regressions, and
standalone handover loading passed. Core: 23,808,875 compressed bytes and
56,535,066 expanded regular-file bytes. No CUDA binary ran. Publication and
release-provider installation remain separate acceptance gates.

- [x] Build a core containing Postgres, pgvector, CPU llama.cpp, the launcher, and
      its own inventory. Include file digests, link targets, and executable modes.
- [x] Define a complete recipe identity covering upstream digests, toolchain,
      flags, build logic, bundled libraries, and packaging policy.
- [x] Give the core a monotonic runtime version and native contract metadata,
      separate from its recipe identity and the product version.
- [x] Remove product-version coupling from in-archive provenance. Packaging the
      same frozen payload and metadata produces identical archive bytes.
- [x] Make core-only content, loader, and CPU embedding checks pass without
      weakening validation of existing CUDA artifacts.
- [x] Add an explicit core size budget while preserving historical measurements.
- [x] Record the independent-native-version decision in an ADR and update the
      superseded requirement that every Linux artifact contains both variants.
- [x] Keep the combined native artifact working during the transition.

## 04: Publish retained core assets and compile trusted pins

**What to build:** A trusted Koed Server Control Plane can resolve one published
core by compiled identity and digest, independently of product releases.

**Blocked by:** 03: Produce independently versioned CPU core candidates.

**Status:** in progress

The first CPU candidate passed ticket 03. Repository release immutability was
read on 2026-11-04: disabled, with no owner enforcement. Publication must retain
the protected production approval boundary. No native release or production pin
has been published from this work.

Implemented: independent CPU workflow and publication adapter, compiled catalog
schema and source authority, packaged pin inspection, and native URL admission
in product promotion. A local dry run accepted the exact ticket 03 candidate.
Publication retry fixtures and 81 focused packaging/promotion checks passed.
Live publication, reviewed production pins, and repository immutability acceptance
remain outstanding. The source catalog is intentionally unset.
The retention audit found no automated release/tag deletion path. Product release
tools require a product tag or matching draft, while published native retries
authenticate retained bytes without mutation. A fresh GitHub read still showed
immutability disabled and no native-core tags. Administrator actions outside the
workflow remain an explicitly documented limitation.

- [ ] Publish the core through a separate reviewed native workflow when relevant
      recipe inputs change. Product releases consume it without rebuilding it.
- [ ] Compile the reviewed URL, recipe ID, archive digest, compressed and expanded
      sizes, manifest digest, runtime version, and contracts into the Control Plane.
      Do not add an Operator-supplied production pin override.
- [x] Support a catalog containing only the core until CUDA qualification finishes.
- [ ] Publish native releases without making them the latest product release.
      Refuse changed bytes under an existing native identity.
- [ ] Confirm the repository's immutability setting and exercise product release
      publication and retries. Enable immutability through the normal configuration
      process if compatible, or explicitly document the remaining limitation.
- [x] Enforce no-overwrite and no-delete rules for published native releases,
      assets, and tags, including cleanup workflows. Upload all assets before
      publishing. Whole-release retention remains necessary with immutability.
- [x] Product promotion checks authenticate every referenced native URL and digest
      while preserving existing reviewed-build and publication approval boundaries.
- [x] Verify effective pins inside the distributed Control Plane. Missing,
      conflicting, or changed native assets fail admission or promotion.

## 05: Install a fresh CPU runtime through the release provider

**What to build:** On clean Linux x64 without Homebrew, an Operator can install
the pinned CPU core, then explicitly start a working Koed installation.

**Blocked by:** 02: Expose the existing stopped-runtime lifecycle exclusion;
04: Publish retained core assets and compile trusted pins.

**Status:** ready-for-agent

- [ ] Expose explicit release-provider installation and read-only status through
      the CLI. Installation requires bundled-local dependency mode and stopped
      Koed. Keep the default provider unchanged until ticket 07.
- [ ] Refuse unsupported platforms and libc versions. Below the Linux x64 glibc
      baseline, offer the complete Homebrew alternative and state its prerequisites.
- [ ] Stream bounded downloads to disk, verify compiled pins and the full native
      inventory, and report progress and actionable download failures.
- [ ] Preserve safe relative native library symlinks. Reject escaping paths and
      link chains, absolute links, hard links, duplicates, special files, and writes
      through symlinked parents. Keep the component extractor's stricter policy.
- [ ] Account for download, staging, retained payloads, and a documented disk-space
      reserve. Cancellation, partial download, disk exhaustion, or failed admission
      leaves no active partial runtime.
- [ ] Store admitted immutable payloads, compose one selection, and initialize
      entry links only for a fresh or release-owned installation. Refuse Homebrew
      migration or unknown pre-existing native paths.
- [ ] Under the existing lifecycle lock, recheck ownership, stopped state, and
      expected selection. Run bounded isolated native tests, terminate them, and
      activate through one durable atomic pointer swap. Never start Koed itself.
- [ ] Make startup resolve one admitted selection under the same exclusion,
      including source-mode paths that use the native store. Preserve other
      providers, binary overrides, and component ownership checks.
- [ ] Enforce the compiled minimum core version, supported native contracts,
      target, and integrity at startup. Errors provide complete repair commands.
- [ ] Demonstrate a complete packaged CLI, Base component, core, and embedding-model
      installation on Ubuntu 22.04. Explicit Operator startup reaches healthy CPU
      operation without a repository checkout. Report installation success separately
      from production service health.

## 06: Update existing cores without disturbing services or data

**What to build:** An Operator can safely repeat or update a stopped release-provider
installation, with clear behavior after interruption or a Control Plane upgrade.

**Blocked by:** 05: Install a fresh CPU runtime through the release provider.

**Status:** ready-for-agent

- [ ] An unchanged intact installation performs no download or replacement.
      Integrity failure produces a repair action instead of a false success.
- [ ] Replace the selected core through the same atomic pointer. Preserve the
      prior complete selection, unrelated runtimes, models, and Postgres data.
- [ ] Refuse changes while the supervisor or managed native processes run, or
      when ownership or process state is uncertain. Never stop those processes.
- [ ] Cover concurrent starts and installs. Recheck the expected selection under
      the lock so a losing installer cannot overwrite another command's selection.
- [ ] An interrupted operation leaves either the old or new complete selection.
      Before the swap, failures preserve the old selection. After it, derive status
      from the new selection even if cache recording failed. Never automatically
      repoint or claim that activation was undone.
- [ ] Keep stale-lock refusal and document safe stopped-runtime Operator recovery.
      Do not add automatic lock reclamation, service restart, or rollback.
- [ ] A previously admitted core above the compiled minimum with supported
      contracts remains usable when merely outdated. Below-minimum or unsupported
      cores fail startup with a repair command. Recipe hashes are not version numbers.
- [ ] Permit tested Postgres minor updates. Reject major-version changes and keep
      pgvector fixed for the initial rollout. Do not perform extension SQL upgrades
      or imply that selecting earlier binaries reverses database changes.
- [ ] Record installation and update footprint measurements, including retained
      selections. Test failures at the pointer-swap and derived-status boundaries.

## 07: Ship the new default Linux CPU setup

**What to build:** New supported Linux CLI installations use the release provider
by default, with a documented complete CPU setup that can ship before CUDA.

**Blocked by:** 06: Update existing cores without disturbing services or data.

**Status:** ready-for-agent

- [ ] Calls that omit the provider select release only for new Linux x64 installs.
      Existing recorded Homebrew installs retain their provider.
- [ ] Leave macOS, explicit source-checkout scripts, and Desktop packaged/Homebrew
      choices unchanged. Explain those boundaries in setup guidance.
- [ ] Document complete fresh setup and explicit stop/install/start updates in
      generated npm guidance and operational documentation. Correct obsolete npm
      publication wording.
- [ ] Demonstrate the documented path from the published npm package on Ubuntu
      22.04 and 24.04, Debian 12, and WSL2. Test clear refusal below the libc baseline.
- [ ] Compare actual complete download bytes, installed size, and peak installation
      space with ticket 01's baseline under matching conditions. Report actual
      savings instead of treating native-archive savings as total-install savings.
- [ ] Obtain the repository-required changeset decision for the user-visible setup
      change, with a recommended minor bump and rationale.
- [ ] Complete the CPU release without waiting for CUDA publication or GPU runner
      availability. Keep the old combined public native asset during the transition.

## 08: Produce independent CUDA add-on candidates

**What to build:** The native pipeline can produce a separate CUDA candidate that
composes with a matching core and remains unchanged by unrelated Postgres updates.

**Blocked by:** 03: Produce independently versioned CPU core candidates.

**Status:** in progress

Prepared: independent CUDA source recipe, builder, frozen inventory and packaging,
core compatibility checks, separate size budgets, and deferred fixture and loader
qualification. `docs/qualification/linux-cuda-handover.md` describes the offline
source bundle with the exact ticket 03 CPU candidate. No CUDA build, test, loader
check, or GPU inference ran. Actual candidate production, identical repackaging,
and layout qualification remain pending the Operator's machine arrangement.
Bundle identity and static validation are recorded in
`docs/qualification/linux-cuda-preparation-2026-11-04.json`.
Production CUDA pins remain unset. The ticket 09 shipped CLI validator is not
included or replaced by these candidate checks.

- [ ] Package only the CUDA payload and its own manifest, with no CPU or Postgres
      files. Keep all archive paths and resolved links inside the CUDA payload.
- [ ] Bind CUDA identity to its source revision, toolkit/compiler inputs, supported
      GPU architectures, build logic, libraries, and packaging policy.
- [ ] Match the core's exact llama.cpp revision and supported composition contract.
      Changing unrelated Postgres inputs leaves CUDA identity and bytes unchanged.
- [ ] Keep CUDA provenance and inventory independent of the core and product version.
      Repackaging the same frozen inputs produces identical archive bytes.
- [ ] Add a separate CUDA size budget and validate the combined selection layout
      and host-loader boundary without claiming CPU-only CI proves GPU inference.
- [ ] Produce exact candidate archives for qualification. Do not publish or compile
      production CUDA pins before the real GPU acceptance in ticket 11.

## 09: Ship the native CPU/GPU agreement check

**What to build:** A packaged Koed CLI can qualify a staged CUDA candidate using
the same validation logic that the release GPU workflow will use.

**Blocked by:** 05: Install a fresh CPU runtime through the release provider;
08: Produce independent CUDA add-on candidates.

**Status:** ready-for-agent

- [ ] Ship the minimal validation runner with the CLI rather than depending on
      repository scripts or workflow-only threshold expressions.
- [ ] Require driver 550.54.14 or later and a loadable host driver library for the
      current pinned add-on. Keep this check independent of Privacy Filter CUDA.
- [ ] Exercise the staged selection directly while Koed is stopped and lifecycle
      exclusion is held. Never invoke production Koed startup or stop unrelated apps.
- [ ] Require CUDA device discovery. When the embedding model is already installed,
      test synthetic inputs with finite, nonempty, dimension-matched vectors and
      CPU/GPU cosine agreement of at least 0.999 for every input.
- [ ] Without an installed model, report device-only qualification and do not
      download a model. Full release qualification still requires real inference.
- [ ] Bound test execution, isolate ports and temporary data, and terminate test
      processes before activation or lock release, including failure paths.
- [ ] Distinguish unavailable devices, external VRAM pressure, and vector-agreement
      failures. Test missing-model and failing-device behavior from the packaged CLI
      without a checkout. Real GPU execution is the acceptance gate in ticket 11.

## 10: Install, replace, and remove CUDA with explicit asset flags

**What to build:** Operators can select a complete CPU/CUDA pair or remove the
add-on while Koed is stopped, without changing execution policy.

**Blocked by:** 06: Update existing cores without disturbing services or data;
09: Ship the native CPU/GPU agreement check.

**Status:** ready-for-agent

- [ ] Support mutually exclusive `--with-cuda` and `--without-cuda` asset flags only
      for `--provider release`. Include `--dependency-mode bundled-local` in documented
      commands. Neither flag changes acceleration environment or Desktop preferences.
- [ ] With CUDA requested, stage the required pinned core and add-on together for
      first install or upgrade. Test the candidate before one atomic selection swap.
      A llama.cpp update needs no intermediate CPU selection or policy change.
- [ ] Without either asset flag, never download CUDA. A compatible existing add-on
      is referenced without copying or redownloading during a core-only update.
- [ ] When a default core update invalidates the add-on, permit CPU only for a
      policy that allows it. Under forced CUDA, refuse and offer the complete
      `--with-cuda` update command. Explicit removal also refuses under forced CUDA.
- [ ] Invoke ticket 09's validator while stopped and under the lifecycle lock.
      Failed staging or validation leaves the old pointer unchanged. Keep the new
      selection after a successful swap, with no automatic restart or rollback.
- [ ] Report installed assets and effective execution policy. Explicit CPU policy
      stays CPU after installing CUDA. Removing CUDA selects CPU while retaining
      prior payloads for manual recovery.
- [ ] Handle missing CUDA production pins with an actionable refusal and an intact
      installation. Exercise candidate pins through controlled test fixtures without
      introducing a production pin override or publishing unqualified assets.
- [ ] Test combined upgrades, add-on-only updates, unchanged reruns, no-copy reuse,
      incompatible revisions, unsafe archives, disk pressure, and unavailable GPUs.

## 11: Qualify and publish the CUDA installation path

**What to build:** Operators can download a production-pinned add-on that passed
real GPU qualification through the exact shipped CLI and archive layout.

**Blocked by:** 10: Install, replace, and remove CUDA with explicit asset flags.

**Status:** ready-for-agent

- [ ] Obtain a real GPU runner and test the exact frozen core and add-on candidates
      through the shipped validation path. Do not substitute source-tree binaries.
- [ ] Demonstrate CUDA kernels and CPU/GPU agreement with the installed embedding
      model. Bind evidence to archive digests and the packaged CLI under review.
- [ ] Demonstrate explicit stop/install/start transitions in both directions,
      first CUDA installation, combined revision upgrades under forced CUDA, and
      a Postgres-only core update that reuses the add-on without copying.
- [ ] Demonstrate running-runtime refusal, explicit CPU policy preservation, failed
      device/model validation, and test-process cleanup without service orchestration.
- [ ] Publish only after qualification passes, then review and compile the production
      CUDA pin. Apply the same retention and promotion checks as the core.
- [ ] Verify the documented path from the published packages and native URLs.
      Report install readiness separately from service health after manual startup.
- [ ] Do not block or reverse the independently shipped CPU path if a GPU runner
      remains unavailable. Keep the combined asset published until replacement
      acceptance and ticket 13 are complete.

## 12: Explain available CUDA setup without slowing status

**What to build:** Read-only status and setup tell eligible Operators how to add
CUDA and explain installed assets separately from execution policy.

**Blocked by:** 11: Qualify and publish the CUDA installation path.

**Status:** ready-for-agent

- [ ] Advertise CUDA only when a production pin exists. Use bounded read-only GPU
      discovery with a short timeout and no asset or model downloads.
- [ ] Show complete stop/install/start guidance when an NVIDIA GPU is detected
      and no add-on is installed. A hint must not claim that qualification passed.
- [ ] Distinguish absent, outdated, incompatible, and installed-but-unused CUDA.
      Explain explicit CPU policy without changing it.
- [ ] A missing discovery command, timeout, or failed probe leaves normal status
      usable and does not create a readiness failure by itself.
- [ ] Test hints and structured status for no GPU, missing pin, forced CUDA,
      explicit CPU, stale add-on, and healthy automatic acceleration.

## 13: Retire the combined public native asset

**What to build:** Product releases distribute the verified split native assets
without requiring or publishing the old combined archive.

**Blocked by:** 07: Ship the new default Linux CPU setup;
11: Qualify and publish the CUDA installation path.

**Status:** ready-for-agent

- [ ] Remove the combined native asset from future public release requirements,
      upload lists, and promotion expectations. Keep it available as an internal CI
      artifact and preserve assets already published on past releases.
- [ ] Update release policy, reviewed-build identity, asset verification, and
      workflow tests to require the split pins and their authenticated assets.
- [ ] Preserve the immutable historical size baseline and enforce separate core
      and CUDA budgets. Do not rewrite old measurements to make new gates pass.
- [ ] Complete a release dry run without the combined public asset. Missing or
      altered pinned split assets fail before promotion.
- [ ] Confirm both documented published installation paths and update release and
      operational guidance for the completed transition.
- [ ] Keep GPU hints outside this ticket's blocking edges: they can ship separately
      once the qualified CUDA path is available.

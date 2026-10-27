# Desktop Updates: Two Public Milestones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship (1) an update notice with safe manual instructions, then (2) automatic background download with a single **Restart to update** action for normal installation. No download-only public milestone and no required Download click.

**Architecture:** Start a fresh branch from current #432 or its merged successor. Main owns release discovery and a narrow renderer contract. The first milestone uses existing official release metadata and has no installer. The second adds electron-updater/native packaging, automatic download, verified readiness, ownership-aware installation preparation and immutable gated feed promotion. Port useful #339 code selectively; current lifecycle and release code remain authoritative.

**Tech Stack:** TypeScript, Electron, Electron Builder/electron-updater for milestone 2, pnpm, Vitest, Node test runner, GitHub Releases, existing release-promotion tooling and approved production updater hosting.

**Spec:** [Proposed ADR 0058](../../adr/0058-desktop-background-updates-and-explicit-restart.md), user flows/requirements below, current `CONTEXT.md`, `docs/component-manifest-catalog.md`, `docs/running-koed.md`, and `docs/desktop-notarization.md`.

**Supersedes:** [fresh-port plan](2026-10-26-desktop-auto-updates-fresh-port.md) and [merge/restack exploration](2026-10-26-auto-update-stack-adoption.md). Their User-initiated download and download-only checkpoint are not current requirements.

## User Flows and Release Boundaries

### Milestone 1 — Update notice and manual instructions

**Update available → View release → official download/manual instructions → User updates manually.**

- Small in-app indicator and panel: installed version, latest stable version and bounded release summary.
- Main opens the approved official release page. No binary download, updater cache, restart/install command or runtime teardown.
- Instructions explicitly cover CLI-started runtimes: closing Desktop alone may leave processes using the old app alive.
- Independently releasable once official metadata, destination security, instructions and packaged behavior pass. Does not depend on milestone 2 feed, replacement reservation or native updater acceptance.

### Milestone 2 — Background download and one-click installation

**Background check → automatic download/verification → Ready → Restart to update → relaunch as new version.**

- Only routine User action is **Restart to update**. No Download button or additional confirmation.
- No automatic restart, install-on-quit or cached-update installation on next launch without that action.
- Existing adopted CLI runtime, unknown ownership or unsupported installation can block installation. Explain the exceptional blocker; never take foreign stop authority to preserve a marketing promise.
- Native signing, runtime/data compatibility, durable replacement exclusion and complete feed promotion are release gates, not follow-ups.

## Global Constraints and Provenance

- Documents are proposed for review. No implementation, branch/PR mutation, push, signing operation or cloud/public publication is authorized by this plan.
- Refresh current heads before execution. Planning anchors: #432 `1d492d3fe400e0d7d6bf568742f78f1308a7e0b3`; #339 `055fab76571e6fa9afb77624c7c8b563b91c82bf`.
- Keep #339 unchanged as reference; do not merge/rebase it into fresh work. Source attribution and port ledger must account for reused/dropped/deferred capabilities and tests.
- Current runtime ownership, IPC sender validation, lifecycle locks, frozen components/catalog ordering, trusted external control plane and signing checks remain authoritative. No wholesale replacement of manager, main or workflow.
- Initial automatic installation target: packaged macOS arm64. Notice-only behavior on other packaged platforms must be explicitly supported/tested or remain disabled; existing runtime support stays intact.
- Renderer never controls URLs, request headers, download paths, updater options or process termination. Release notes are untrusted input, not executable HTML/instructions.
- Do not add backend synthesis, change Capture/Recall/LCM ownership, or make model/component trust implicit in app-update trust.
- No deletion, downgrade or migration claim for Personal Memory. Preserved files alone do not prove new-version readability or compatible Privacy behavior.
- Separate implementation/re-review, signed native acceptance and public promotion. Missing credentials or unsupported hardware produce explicit pending gates, not simulated passes.
- Temporary files belong under `scratch/`; preserve existing unrelated/untracked work.
- Both public milestones are user-visible features: recommend **minor** releases. Ask for confirmation before adding/omitting each changeset; use current fixed-group conventions rather than copying #339 metadata.

## Review Focus

1. Milestone 1 accidentally exposes downloader/installer or runtime stop authority: Tasks 2–4 must prove absence.
2. Untrusted release metadata/renderer URL becomes shell authority or false update: bounded strict validation, version/channel checks, approved HTTPS destinations and sender checks in Tasks 2–3.
3. Milestone 2 still requires Download, auto-installs on quit, or accepts stale cached payload: Task 5 tests configuration/events/relaunch explicitly.
4. Install races another home/CLI startup or treats `ok:false` cleanup as success: Task 6 blocks replacement and retains ordinary detach semantics.
5. Wrong signing identity/catalog, post-staple byte changes or partial/concurrent publication: Tasks 7–9 preserve current stronger trust gates.
6. Version simulation is labelled native acceptance, or Privacy falls back silently after upgrade: Task 8 requires genuine signed inputs and active-profile/data evidence.

## Task 1: Confirm Baseline, ADR and Port Ledger

**Files:** ADR 0058 and this plan; create `docs/desktop-updates.md` for current design/Operator instructions and port ledger. Update `TODO.md` only for explicit deferred work.

**Interface/decision:** current foundation is authoritative; milestone 1 ships independently, milestone 2 is not partially advertised as completed support.

- [ ] Obtain review approval for ADR/milestones. After implementation authorization, refresh #432/main/#339 heads, comments, reviews and CI before choosing base.
- [ ] Create fresh milestone 1 branch from #432 or main containing its required changes. Do not mutate #339. Preserve unrelated work; isolate execution without rewriting stack history.
- [ ] Record baseline root test-source typecheck, relevant package tests/typechecks, formatting/lint and current packaged smoke. Separate existing failures from regressions.
- [ ] Build port ledger from #339: useful contracts/coordinator/UI/artifact tests; lifecycle/workflow superseded by current versions; obsolete scripts/metadata deliberately excluded. Record reference SHA and attribution.
- [ ] Reserve ADR 0058 only if still free. Record official stable metadata source and destination policy. No resurrected `release-desktop-assets.yml` or component signer change.
- [ ] Commit reviewed design/baseline documentation separately from implementation.

**Acceptance:** agreed two-milestone scope; no older stop authority or download-consent requirement leaks into new work.

## Task 2: Implement Main-Owned Notice Discovery

**Files:** Create `packages/shared/src/desktop-update-contract.ts`, `apps/desktop/src/main/update-discovery.ts` and corresponding unit tests; modify shared exports and current main wiring. Create `src/main/` directory as needed.

**Proposed contract:** strict notice data containing installed/latest versions, bounded plain-text release summary and availability state; fixed `getState`, `checkForUpdates`, `openReleasePage` operations. No renderer-supplied URL or installation fields/operations in milestone 1.

- [ ] Write red tests for stable newer release, up-to-date, older/prerelease/draft releases, malformed/missing versions, oversized bodies, timeouts, wrong origin, bad redirect and offline behavior.
- [ ] Use existing official GitHub stable release metadata for `koed-labs/koed`, not an unfinished automatic-update channel. Record exact endpoint and approved redirect policy; do not infer artifact eligibility from raw version text alone. Require a published supported release with an official manual-install path.
- [ ] Compare product versions using existing project conventions; unknown/development versions do not generate false notices. Use strict parsing, bounded response/summary and explicit timeout/cancellation.
- [ ] Start checks only in eligible packaged builds. Initial defaults: 5-second delay, 6-hour interval, 20% jitter; bounded backoff and single-flight requests. No production calls from dev/tests or unsupported configurations.
- [ ] Keep background failures quiet/non-blocking; explicit manual checks may report actionable failure. Plain-text notes cannot cause script execution, arbitrary navigation or automatic remote-content loading.
- [ ] Test disposal, stale responses and repeated checks. Do not add electron-updater or payload-download dependencies merely for milestone 1.
- [ ] Run shared/discovery tests and package typechecks; commit.

**Acceptance:** credible notice via approved source without signing credentials, public-feed mutation, downloaded payload or runtime control.

## Task 3: Implement Narrow IPC and Notice UI

**Files:** Create `apps/desktop/src/ipc/update.ts`, notice preload/contract tests and `apps/desktop/src/renderer/update/*`. Modify current `ipc/protocol.ts`, `preload.cts`, `types.ts`, `main.ts`, shell and Preferences/version tests narrowly.

**Interfaces:** fixed Task 2 operations, bounded state subscription/disposal, main-owned approved `View release` action. Installed version comes from Electron, not a hard-coded renderer constant.

- [ ] Add failing sender/input/output tests, including subframe/foreign-window calls, renderer-selected URL/command fields and malformed state.
- [ ] Add UI tests for availability indicator, installed/new version, plain-text notes, manual check result, offline state, current shell layout and subscription disposal.
- [ ] Port useful #339 visual/transport pieces into current shell. Preserve existing IPC authorization and feature cleanup; no generic shell proxy.
- [ ] Main constructs/verifies release destination from trusted configuration and validated release identity. Permit only the intended HTTPS origin/path; test malicious URL, credentials-in-URL, wrong scheme and redirect handling.
- [ ] Prove milestone 1 exports no download/install/restart command and never stops runtime. Do not show non-functional download progress or installer button.
- [ ] Run current Desktop/shared tests, both Desktop tsconfigs and build; commit.

**Acceptance:** working notice/manual handoff without privileged updater machinery.

## Task 4: Validate Manual Instructions and Release Milestone 1

**Files:** `docs/desktop-updates.md`, `docs/running-koed.md`, Desktop README, notice/packaged smoke tests and confirmed changeset.

**Interface/decision:** manual download remains outside app; published instructions are part of safety contract, not generic “quit then replace.”

- [ ] Write/test instructions against supported CLI commands and actual ownership states. Explain owned Desktop runtime versus adopted CLI runtime, detecting remaining app-dependent runtime and explicitly stopping it before replacement.
- [ ] Include installation location, official artifact/version verification, reopening, preserved data and unsupported-context guidance. Do not suggest kill-all commands, unsafe downgrade or Gatekeeper bypass.
- [ ] Validate real official release metadata and page against supported packaged build; test current/offline/no-update cases without modifying production channel. Existing release artifacts must actually support the promised manual path.
- [ ] Verify no updater binary download, installer launch or new runtime teardown occurs in notice-only package; no dev production-feed traffic.
- [ ] Run cheap CI-equivalent checks, registered package smoke and applicable full checks. Confirm minor changeset recommendation with User; obtain authorization for PR/push/release operations.
- [ ] Refresh PR state, publish review evidence, watch final-head CI if authorized. Stop for review and release decision.

**Public release gate:** useful notice and safe official manual path; no need to complete Tasks 5–9 first. If current distribution cannot satisfy manual-install trust/instructions, resolve that gate rather than describing notice UI alone as releasable.

**Checkpoint:** milestone 1 may ship. No automatic-update claim, no in-app download-only public release.

## Task 5: Add Automatic Download and Verified Readiness

**Files:** Create/adapt `apps/desktop/src/main/update-coordinator.ts`, unit tests, extended shared contract/IPC/preload/UI tests and current Desktop dependency/lockfile entries.

**Interfaces:** main coordinator owns check/download/ready/error lifecycle and fixed `restartToUpdate` operation. Use `autoDownload = true`, `autoInstallOnAppQuit = false`; no required renderer download command. Keep full updater disabled in public builds until Tasks 6–9 pass.

- [ ] Write red tests proving available update starts download without User input; ready click is the only routine interaction. Assert no install on quit, automatic restart or installation on next launch from cache.
- [ ] Port useful #339 coordinator tests while replacing explicit-download assumptions. Reject stale events, downgrade/wrong-platform payloads, identity/integrity failure and invalid cached bytes.
- [ ] Implement main-owned electron-updater adapter using approved stable source. Align discovery/readiness with same eligible release; no conflicting notice/new-version decisions from two independent feeds.
- [ ] Define bounded cache retention, retries/backoff, cancellation/disposal and restart-resume semantics. Revalidate cached bytes and metadata; downloader state is not installation authority.
- [ ] UI shows background progress and **Restart to update** when eligible; no ordinary Download or extra confirmation. Silent background errors remain inspectable without intrusive prompts.
- [ ] Test macOS helper/permission behavior during download. Native privilege/security requirements cannot be bypassed; any normal extra authorization interaction must be resolved or disclosed as unsupported scope before acceptance.
- [ ] Run coordinator/contract/IPC/UI tests and package typechecks; commit behind unavailable installation preparation.

**Acceptance:** automatic download implemented and tested, but no public install action until complete safe-install contract is wired.

## Task 6: Prove One-Click Runtime Preparation and Replacement Exclusion

**Files:** Create approved reservation implementation/tests under `packages/koed-server/src/`; adapt `apps/desktop/src/main/quit-coordinator.ts`, current manager/main/startup/setup tests and necessary supervisor/generation-lifecycle admission. Amend ADR/design after approval of detailed mechanics.

**Proposed interface:** internal manager `prepareForUpdateInstall(): Promise<void>` resolves only after guarded preparation succeeds. Ordinary quit continues using current ownership-aware `shutdown()`; explicit Operator `stop()` stays separate. `restartToUpdate` calls preparation then native installer exactly once.

- [ ] Approve installation identity, storage permissions, supported per-user/system/cross-user scope, acquisition ordering and recovery. Unknown/unsupported context blocks replacement. No guessed temporary lock path or age-only recovery.
- [ ] Write failing races across homes and processes: CLI startup wins → install denied; reservation wins → new startup denied; GUI exit does not release exclusion before installer finishes. Include relocation, retained pins, identity mismatch and interrupted handoff.
- [ ] Implement durable reservation/admission shared by supported launch contexts. If sound coordination cannot fit current architecture, pause for separately approved design; one-time PID polling is not a fallback.
- [ ] Test normal quit preserves adopted CLI runtime/pointer/pin; install defers it without automatic stop. Owned runtime must fully stop, including managed work, before replacement.
- [ ] Reject cleanup rejection, `ok:false`, timeout, unresolved pin and late startup. Preserve stopped-authority queue, cancellation and no-child-resurrection guarantees across setup/Privacy/broker/collaboration/pairing work.
- [ ] Specify coherent end-to-end deadline against existing supervisor stop bound. Model failure before teardown separately from partial teardown; do not relaunch or destroy healthy adopted runtime on a denied preflight.
- [ ] Prove supported Base/Privacy profile transition requires no additional normal confirmation. Stage/prepare only through existing trusted authority; preserve models and Team fail-closed behavior. If current runtime UX cannot support this, resolve design before claiming one-click readiness.
- [ ] Wire native installation only after all checks succeed. Confirm reservation survives GUI exit, matching verified new app acknowledges completion, and ambiguous interrupted install remains safely blocked/recoverable.
- [ ] Run full lifecycle/startup/manager/cross-process suites and package smoke; commit narrow changes, not #339's old main/manager wholesale.

**Acceptance:** normal eligible upgrade needs one click; exceptional blockers explain deferral and never gain foreign stop authority. Active profile/data guarantees are tested, not assumed.

## Task 7: Extend Current Packaging and Stage Immutable Candidates

**Files:** Current `.github/workflows/release.yml`, `apps/desktop/electron-builder.yml`, current Desktop package/signing scripts, selected artifact/feed helpers/tests from #339 and existing release-promotion tests.

**Interfaces:** preserve frozen components → exact-version complete catalog → trusted standalone/Desktop release DAG and `signMacosRuntime(opts, { sign = signAsync } = {})`. Updater outputs describe same final signed release.

- [ ] Add failing tests for missing catalog identity/signing hook, wrong Apple Team/version, app/mounted-DMG mismatch, incomplete updater assets and post-sign/staple digest changes.
- [ ] Add compatible updater packaging/config to current build; configure intended feed before signing. Never patch signed app config later or revive deleted recovery workflow.
- [ ] Generate/revalidate ZIP/DMG/blockmaps/feed against final notarized/stapled bytes after all transformations. Check packaged catalog and matching product/build identities throughout.
- [ ] Preserve protected signing environment/approvals and current stronger verification. Missing credentials blocks signed tier; no unsigned public fallback or candidate-code execution in credentialed promotion.
- [ ] Stage immutable versioned candidate assets only after authorization. Matching remote bytes may skip; same version/different bytes rejects. Validate full remote bytes and hashes, not metadata-only probes.
- [ ] Exercise builders/artifact/catalog/workflow/promotion unit suites and internal package without advancing stable channel; commit.

**Acceptance:** complete, authentic, immutable candidate—not authorization to enable public auto-download or publish stable feed.

## Task 8: Prove Genuine Signed Upgrade and Recovery

**Files:** Adapt #339 E2E/evidence helpers under `scripts/`, deterministic tests and dedicated sanitized acceptance evidence; update `docs/desktop-updates.md` and notarization/running docs.

**Interfaces:** actual signed N−1/N artifacts and matching catalogs/components; final candidate from Task 7; runtime contract from Task 6. Staging/evidence performs no stable promotion.

- [ ] Add tests rejecting fake historical acceptance from same-source version overrides, absent native relaunch/version proof, signed-app feed patching or missing data readability assertions. Keep simulations explicitly labelled.
- [ ] On authorized signed macOS environment demonstrate automatic download with no Download click, progress, one **Restart to update** click, native replacement and relaunch as N. Test ordinary quit/reopen never installs without consent.
- [ ] Verify current expected Apple identity/signatures, final-byte payload, active Base/Privacy profile, Personal Memory/configuration/token-reference/model readability and version/catalog coherence.
- [ ] Exercise owned runtime, adopted-runtime deferral, second-home/concurrent CLI startup, cleanup timeout, interrupted download/install and supported recovery. No silent Privacy→Base fallback or data downgrade.
- [ ] Record sanitized request/hash/signature evidence, PID/exit/reservation timeline and before/after data inventory. Test unsupported/misconfigured installation contexts fail closed. Gatekeeper bypass is not acceptance.
- [ ] If required credentials/historical signed baseline are absent, report native acceptance pending; do not describe internal smoke as complete updater readiness.
- [ ] Document initial manual installation needed to establish a supported signed updater baseline for existing ad-hoc installations; commit evidence tooling/docs separately from private operational artifacts.

**Acceptance:** native upgrade and User interaction count proved on supported setup, with lifecycle/data/recovery evidence.

## Task 9: Gate Stable Promotion and Release Milestone 2

**Files:** `scripts/{release-promotion-adapter.mjs,release-promotion-lib.mjs,ensure-release-assets.mjs}`, feed/evidence tests, current release workflow, Operator docs and confirmed changeset.

**Interfaces:** preserve existing `runReleasePromotion(args, adapters = {})` and immutable `decideAssetAction({ expectedSha256, actualSha256 })`. Stable pointer changes only after candidate/evidence/current release gates succeed.

- [ ] Write failures for incomplete remote assets, failed native evidence, same-version different bytes, stale/competing publishers and wrong current control-plane/catalog version.
- [ ] Serialize promotion and use tested conditional stable-pointer update. If storage/tooling cannot enforce safe concurrency, keep public promotion disabled.
- [ ] Require Task 8 evidence and current component/npm/signing gates before publishing stable feed. Test failed-candidate non-publication, retry, withdrawal for not-yet-updated Users and higher corrective release for installed Users; no state downgrade.
- [ ] Confirm minor release recommendation/changeset and update docs from notice/manual behavior to automatic download/explicit restart. Do not retroactively claim milestone 1 had automatic installation.
- [ ] Run formatting/lint, root test-source typecheck, Desktop/shared/Server tests/typechecks, both Desktop tsconfigs, builds, updater/feed/signing/promotion suites, registered/package smoke and applicable `pnpm verify`. State unavailable DB/runtime/hardware/credential checks explicitly.
- [ ] Refresh heads/reviews/comments/checks immediately before PR actions. Push incremental changes/watch final-head CI only after authorization. Base on released milestone 1/current main, not stale #339.
- [ ] Obtain explicit operational authorization for signing/cloud/public promotion and production enablement. Close #339 only when authorized and port ledger accounts for useful work.

**Public release gate:** genuine automatic-download/one-click upgrade accepted, trustworthy complete feed and safe promotion, no remaining normal Download/confirmation/quit/relaunch action.

## Commit and Review Strategy

- Milestone 1 PR: design/provenance → discovery contract → IPC/UI → manual instructions/tests/release note. **Stop, review, release.**
- Milestone 2: small commits for coordinator → exclusion/lifecycle → signing/candidate staging → native evidence → gated promotion. Security/lifecycle review before installer wiring; release review before production enablement.
- Do not merge unfinished milestone 2 into publicly enabled behavior. Prefer no installer code at all in milestone 1; later partial work remains disabled until all milestone 2 gates pass.
- Each ported unit must run its original useful tests plus current-foundation regressions. Record dropped obsolete tests/assumptions with reasons.

## Handoff

Plan and ADR only; no implementation started. Review desired milestone boundaries and proposed ADR first. Detailed replacement-reservation mechanics and supported installation scope need approval during Task 6; if they cannot deliver the ordinary one-click path safely, pause for a design revision rather than adding a mandatory Download click or weakening trust.

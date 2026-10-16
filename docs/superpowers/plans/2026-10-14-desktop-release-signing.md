# Koed Desktop Release Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development after user review and execution-method selection. Original task checklists below describe planned work; the execution record at the end is authoritative for completed work and remaining operational gates.

**Goal:** Publish arm64 macOS Desktop DMG/ZIP only after Developer ID signing, notarization, stapling, smoke, artifact inspection, and checksum gates pass.

**Architecture:** Continue current branch stacked on PR #421, preserving local work while incorporating its updated head. Keep signing inline in the normal release workflow, using electron-builder's built-in flow. Disable manual recovery; trust reviewed `main` code plus protected-environment approval rather than an isolated signer.

**Tech Stack:** GitHub Actions, Node.js 24.13.1, pnpm 11.1.2, electron-builder 26.15.3, `node:test`, existing Desktop packaging scripts.

**Spec:** `docs/superpowers/specs/2026-10-14-desktop-release-signing-design.md`

## Global Constraints

- Only arm64 macOS DMG/ZIP; preserve versioned artifact names.
- One release path in `.github/workflows/release.yml`; no reusable recovery pipeline or alternate source/tooling checkout.
- `desktop-release` requires administrator-configured reviewers and `main` deployment restriction before use. Approval occurs before signing job starts.
- Environment secrets: `DESKTOP_MACOS_CSC_LINK`, `DESKTOP_MACOS_CSC_KEY_PASSWORD`, `DESKTOP_MACOS_APPLE_API_KEY_P8_BASE64`, `DESKTOP_MACOS_APPLE_API_KEY_ID`, `DESKTOP_MACOS_APPLE_API_ISSUER`. Non-secret variable: `DESKTOP_MACOS_APPLE_TEAM_ID`.
- Candidate `main` build hooks share the credential-bearing electron-builder process; approved main code is trusted, not isolated from secrets.
- Leave shared `mac.notarize` unset; preserve local/internal unsigned/ad-hoc behavior. No custom notarizer or manual DMG creation.
- Preserve native-runtime preparation/validation, smoke diagnostics, artifact inspection/report, immutable release upload, and existing non-Desktop promotion gates.
- Checksum basename: `koed-desktop-macos-arm64.sha256`.
- Preserve pinned actions/toolchain. Approved exception: exact `@electron/osx-sign` `1.3.3` dev dependency and electron-builder `26.15.3` pin for one delegating manifest-finalization adapter.
- Failures block publication. Fix and rerun normal pipeline; rebuild old releases through patch releases.
- Initial planning performed no implementation or git integration. Implementation was subsequently authorized; see the execution record. No push or release is authorized by this plan alone.

## Current implementation assessment

Inspected 2026-10-14:

- Branch `codex/desktop-signing-notarization`, HEAD `bb9d428a3`; shared ancestor with PR #421 is `52d72cc0b`. PR #421 remains open, head `a4af16231c32cbf305c6a8e023b7a3586f0726d4`, branch `codex/headless-distribution-fixes`. Nine parent commits are absent locally. Refresh before integration.
- Dirty `.github/workflows/release.yml` replaces working inline unsigned pipeline with an incomplete reusable caller; publication `needs` incorrectly references `signed-desktop-release-assets.yml.sign-desktop-release-assets`.
- Untracked `.github/workflows/signed-desktop-release-assets.yml` lacks environment approval, uses unpinned actions/nonexistent package names, adds x64, skips native runtime and smoke gates, and uploads only workflow artifacts.
- Untracked `scripts/desktop-notarize.mjs` is rejected architecture and cannot load: `SyntaxError: The requested module 'node:fs' does not provide an export named 'spawnSync'`.
- Dirty `apps/desktop/README.md` prematurely claims completed signing, repository secrets, and custom packaging. Rewrite against completed implementation.
- This plan supersedes the earlier untracked shared-release/recovery plan. Its historical changeset approval claim is not treated as current confirmation.
- Reuse production `pnpm desktop:package:release`, shared electron-builder config/entitlements, existing verifier, runtime validation, smoke, artifact policy/report, and `scripts/ensure-release-assets.mjs`.
- Research audit ran 41 existing focused tests successfully, but those tests miss the broken job graph. Actual repository `assertReleaseWorkflowVersionPropagation(process.cwd())` fails against the draft. No real signing run has occurred.

## Review Focus

- Partial/malformed credentials must fail before packaging without exposing values; Task 2 tests.
- Ad-hoc, wrong-team, missing staple, or Gatekeeper-denied apps must fail, including mounted DMG copy; Task 3 tests.
- Failed, skipped, or unapproved signing and nonexistent job dependencies must never permit publication; Task 4 structural tests.
- Production app output may use `mac-arm64` rather than `mac`; resolve one actual bundle and pass it consistently to verification, smoke, and inspection; Task 4 tests.
- Repeated release upload must preserve immutable assets: identical bytes accepted, changed bytes rejected rather than overwritten; Task 4 existing upload tests and documented patch-release policy.

---

### Task 1: Preserve work and refresh stack on #421

**Files:** Current tracked edits and untracked signing files; no product edits in this task.

**Interfaces:** Consumes current dirty branch and current PR #421 head; produces preserved local work on a branch containing updated parent.

- [ ] Refresh PR #421 head, branch status, and available commits; record exact integration target.
- [ ] Preserve tracked and untracked work using a named git stash including untracked files; verify preserved file list before merging. Do not use destructive reset or clean.
- [ ] Merge refreshed `origin/codex/headless-distribution-fixes` into current branch without rewriting history. Restore preserved work with stash apply, not pop; retain backup until restoration is checked. If conflicts arise, resolve against approved spec while retaining parent's release fixes.
- [ ] Verify parent ancestry with `git merge-base --is-ancestor <parent-sha> HEAD`, inspect restored status/diff, then rerun existing focused tests listed in Task 5. Record inherited failures separately.

### Task 2: Prepare protected signing credentials

**Files:** Create `apps/desktop/scripts/prepare-macos-signing.mjs` and `apps/desktop/scripts/prepare-macos-signing.test.mjs`; modify `apps/desktop/package.json`.

**Interfaces:** Export `prepareMacosSigning(env = process.env)` returning `{ appleApiKeyPath }`; CLI writes only `apple-api-key-path=<path>` to `GITHUB_OUTPUT`. Consume all five secrets, team variable, `RUNNER_TEMP`, and `GITHUB_OUTPUT`.

- [ ] Write tests: each absent required value rejects before writes; malformed base64 rejects without secret-bearing errors; valid key writes exact decoded bytes under `RUNNER_TEMP` with mode `0600`; output contains only path, not secrets; exclusive file creation prevents overwrite.
- [ ] Run `node --test apps/desktop/scripts/prepare-macos-signing.test.mjs`; confirm intended RED failure before implementing helper.
- [ ] Implement import-safe helper and CLI. Validate complete inputs before writes; use runner-temporary exclusive file, owner-only permissions, and no secret logging. Do not create a second signing/notarization implementation.
- [ ] Include all `scripts/*.test.mjs` in Desktop test script before existing Vitest invocation. Run focused test and `pnpm --filter @koed/desktop test`; require GREEN.
- [ ] Review credential lifecycle and commit only task-owned files with `feat: prepare protected macOS signing credentials`.

### Task 3: Extend existing package verifier with release trust checks

**Files:** Modify `apps/desktop/scripts/verify-macos-package.mjs`; create `apps/desktop/scripts/verify-macos-package.test.mjs`.

**Interfaces:** Export `verifyMacosPackage({ appPath, dmgPath, expectedVersion, expectedTeamId, runCommand = spawnSync })`; CLI preserves existing flags and adds `--expected-team-id`. Importing must not run CLI. Without team flag retain internal integrity/version behavior.

- [ ] Write command-injection/temporary-fixture tests covering existing version/integrity checks plus Developer ID authority, exact team, Gatekeeper acceptance, and staple validation on app and mounted DMG app. Reject ad-hoc, Apple Distribution, missing/wrong team, command spawn errors/nonzero results, and either app copy failing. Require DMG detach on verification failure and surface detach errors explicitly.
- [ ] Run `node --test apps/desktop/scripts/verify-macos-package.test.mjs`; confirm RED for missing interface/trust behavior.
- [ ] Refactor minimally behind import-safe CLI. Require `codesign --verify --deep --strict`, inspect combined signature-details stdout/stderr for `Authority=Developer ID Application` and exact `TeamIdentifier`, run `spctl --assess --type execute` and `xcrun stapler validate`. Preserve bundle/renderer version checks.
- [ ] Run focused tests and Desktop test suite; require GREEN. Commit with `feat: verify macOS release trust`.

### Task 3b: Approved signing-order correction

**Files:** Create `apps/desktop/scripts/sign-macos-runtime.mjs`, `apps/desktop/scripts/finalize-runtime-manifests.mjs`, and `apps/desktop/scripts/sign-macos-runtime.test.mjs`; update `apps/desktop/scripts/prepare-koed-runtime.mjs`, `apps/desktop/package.json`, and `pnpm-lock.yaml`.

- [ ] TDD: simulate nested signing changing bytes; require native hashes then Desktop inventory refresh before outer seal. Verify preserved metadata/options, signing-generated files, escaping symlink rejection, and fail-closed callbacks/errors.
- [ ] Add one release-only `mac.sign` adapter delegating once to `signAsync`, synchronously finalizing manifests from the exact outer-app `optionsForFile` callback. Share inventory with preparation; keep runtime checks intact.
- [ ] Pin signer `1.3.3` and builder `26.15.3`; test actual installed signing loop ordering with simulated commands. Guard signer version. No automatic signing retries; normal pipeline rerun after failure. Built-in notarization stays owned by builder; local/internal signing unchanged.
- [ ] Update spec/operator docs for approved exception. Real signed-package startup remains an operational acceptance gate.

### Task 4: Restore inline release path and disable recovery

**Files:** Modify `.github/workflows/release.yml`, `scripts/product-release-version-lib.mjs`, `scripts/product-release-version-lib.test.mjs`, `scripts/gpu-runtime-config.test.mjs`, `scripts/release-promotion-workflow.test.mjs`, and `scripts/ci-policy.test.mjs` as required by refreshed parent. Create `scripts/desktop-release-workflow.test.mjs`, `scripts/desktop-release-checksum.mjs`, and `scripts/desktop-release-checksum.test.mjs`. Remove `.github/workflows/release-desktop-assets.yml`, untracked `.github/workflows/signed-desktop-release-assets.yml`, and untracked `scripts/desktop-notarize.mjs`. Update `.github/scripts/ci-policy.mjs` only if it explicitly lists removed workflow.

**Interfaces:** Inline job ID `signed-desktop-release-assets`; `publish-release.needs` references that exact ID. Export `writeDesktopReleaseChecksum({ releaseVersion, releaseDirectory })` returning checksum path; CLI consumes version and release directory. Input files exactly `Koed-${releaseVersion}-arm64.dmg` and `Koed-${releaseVersion}-arm64.zip`; output contains standard SHA-256 lines with basenames.

- [ ] Write checksum tests for exact two hashes/basenames and missing-file failure. Write parsed-YAML structural tests: all `needs` targets exist; signing job requires `main`, triggering `${{ github.sha }}`, `desktop-release`, production packaging and complete gates; no reusable/manual signing or recovery path; publication explicitly requires successful signing and preserves all parent-required promotion jobs. Pin exact checksum validator/upload contract and native-runtime version propagation.
- [ ] Test production output selection with temporary `mac`/`mac-arm64` layouts: select exactly one existing app, fail on zero or ambiguous results. Implement as small import-safe helper only if existing scripts cannot provide a tested equivalent; use resulting path consistently throughout pipeline.
- [ ] Run new and affected tests; confirm RED against stale draft. Replace old job-name string-split assertions rather than allowing them to silently inspect unrelated jobs.
- [ ] Restore updated parent's inline runtime/build/validation, smoke diagnostics, inspection policy/report, size reporting, and release upload steps. Add protected environment and explicit main restriction; checkout immutable triggering SHA. Map environment secrets only to preparation/packaging steps; map decoded path to electron-builder `APPLE_API_KEY`, IDs to `APPLE_API_KEY_ID`/`APPLE_API_ISSUER`, certificate to `CSC_LINK`/`CSC_KEY_PASSWORD`. Invoke `pnpm desktop:package:release`, not internal packaging or direct custom builder commands. Add always-run temporary key cleanup.
- [ ] Extend verifier call with expected release version/team. Require successful trust, packaged smoke, and composition gates before checksums and `scripts/ensure-release-assets.mjs` upload. Preserve existing non-Desktop component signer/promotion policy and fail-closed publication semantics from #421.
- [ ] Remove rejected draft files and manual recovery workflow, adapting tests/policy references. Do not build recovery eligibility or alternate-source verification helpers.
- [ ] Run all focused Task 5 tests plus actual `assertReleaseWorkflowVersionPropagation(process.cwd())`; require GREEN. Review graph and secret boundary, then commit with `fix: gate desktop releases on signed notarized assets`.

### Task 5: Operator docs, release note decision, and verification

**Files:** Create `docs/desktop-notarization.md`; modify `apps/desktop/README.md`, `docs/desktop-internal-artifacts.md`, and `docs/running-koed.md`. Add changeset only after current user confirms recommendation and package scope.

**Interfaces:** Docs describe exact environment names/formats, main-plus-approval boundary, automatic electron-builder flow, disabled recovery, and first-release manual validation.

- [ ] Document administrator prerequisites: environment reviewers/main restrictions, all secret formats and team variable, no repository-level Apple secrets, approval before job starts. Explain trusted build hooks share signing credentials; this is not isolated signing.
- [ ] Correct premature README claims and distinguish signed release assets from unsigned local/internal packages. Document normal failure reruns, immutable-upload conflicts, patch releases for old rebuilds, and no manual recovery.
- [ ] Before adding or omitting changeset, ask current user to confirm **minor** recommendation because signing changes public release/runtime behavior. Check current fixed-group configuration before selecting package entries; do not rely on stale plan's historical approval claim.
- [ ] Run focused suite:

```bash
node --test apps/desktop/scripts/prepare-macos-signing.test.mjs apps/desktop/scripts/verify-macos-package.test.mjs scripts/desktop-release-checksum.test.mjs scripts/desktop-release-workflow.test.mjs scripts/release-promotion-workflow.test.mjs scripts/product-release-version-lib.test.mjs scripts/gpu-runtime-config.test.mjs scripts/ci-policy.test.mjs scripts/ensure-release-assets.test.mjs scripts/validate-published-release-assets.test.mjs
node --input-type=module -e 'import {assertReleaseWorkflowVersionPropagation} from "./scripts/product-release-version-lib.mjs"; assertReleaseWorkflowVersionPropagation(process.cwd());'
```

- [ ] Run `pnpm fmt:prettier:check`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter @koed/desktop build`, and `pnpm test`. Record blockers/inherited failures; use targeted equivalents if unrelated files block full checks. Run available workflow validator plus structural tests; YAML parsing alone is insufficient.
- [ ] Obtain fresh whole-change read-only review focused on publication bypass, secret leakage, parent regressions, and internal packaging compatibility; fix blockers and rerun affected checks.
- [ ] Commit docs with `docs: explain signed desktop releases`. No push or PR action assumed by this plan; if requested, use repository PR template and watch CI after pushing.
- [ ] Record unverified operational gates honestly: administrator environment configuration and actual Apple signing require authorized release execution. For first signed release, download published asset on clean Mac without development trust overrides, launch through normal download/open flow, record Gatekeeper/startup result. Do not claim this passed from unit tests.

## Execution record

Native execution, minor changeset, and the narrow signing-adapter exception were approved. Main agent remained sole writer; read-only researcher, oracle, and reviewers checked boundaries and compatibility.

- [x] Task 1: Preserved local work and merged #421 head `a4af16231` without rewriting history. Preservation stash retained.
- [x] Task 2: Credential preflight and tests committed (`d70cb879b`); explicit Node imports fixed (`3357e74c4`).
- [x] Task 3: Release trust verifier and tests committed (`6be6c4038`).
- [x] Task 3b: Shared manifest inventory and pinned delegating adapter committed (`5217b622c`). Tests exercise installed signer ordering and installed builder hook contract, including the review-discovered second-argument collision.
- [x] Task 4: Inline protected release path, checksums, fail-closed publication, and removal of recovery workflow/OIDC permission committed (`a84e75aa9`).
- [x] Task 5 repository work: Operator docs, amended spec/plan, and approved minor changeset prepared. Final whole-change reviewer found one blocker; corrected and focused follow-up found no new blockers.
- [x] Verified on Node `24.13.1` via temporary package runner: 33 Desktop script tests, 931 Desktop Vitest tests, and 53 release/policy/upload/signer tests pass. Root TypeScript build check and Desktop production build pass. Actual version-propagation assertion and diff whitespace check pass.
- [x] ESLint passes excluding unrelated `.worktrees/**`. Changed-file formatting passes. Unfiltered formatting fails nine inherited `.superpowers/sdd` files; unfiltered lint scans stale sibling-worktree files. No unrelated files changed.
- [ ] Full monorepo test success: root script suite passes (355 passed, one skipped), but shared concurrency test discovers stale sibling-worktree tests; remaining workspace run stops at database tests requiring `DATABASE_URL`. These are recorded verification limits, not passing results. No database provisioned for this task.
- [ ] Workflow-specific external syntax validation: `actionlint` unavailable; parsed-YAML structural tests and existing policy/version checks passed instead.
- [ ] Administrator configures protected environment, reviewers/main restriction, Apple credentials, and team variable.
- [ ] Authorized release executes real Developer ID signing/notarization and packaged startup gates; first signed release gets recorded clean-Mac download/launch acceptance.
- [ ] Push/PR/release: not performed. No CI run claimed.

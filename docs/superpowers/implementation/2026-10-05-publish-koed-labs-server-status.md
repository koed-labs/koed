# Public server distribution: branch status

This branch is ready for review and merge, but it is **not release-ready**. Merging publishes nothing: production install and release promotion fail closed until the external gates below are closed in a follow-up.

**Do not merge the "Version Koed" release PR until the external gates are closed.** Merging it runs `release.yml` without pending changesets: it creates a draft GitHub release, and the asset jobs fail at the external-signer step because the signer and trust-root repository variables are unset. npm promotion (`release-desktop-assets.yml`, `workflow_dispatch` only) additionally requires `KOED_NPM_PUBLICATION_AUTHORIZED` and `KOED_RELEASE_PROMOTION_APPROVED`.

## Implemented

- Public `@koed-labs/server` identity, coordinated minor changeset, lean independently installable `koed` control plane and lazy command dispatch.
- Strict effective configuration, hermetic base/privacy assembly, authenticated component manifests and bounded archive/tree verification.
- Immutable component staging, generation records, lifecycle exclusion, ownership, process pins, stopped activation and rollback guards.
- Trusted standalone startup and AI Client integration paths, explicit component provisioning commands, offline inputs and npm installation smoke coverage.
- Release artifact identity, immutable uploads/retries, external signing and npm candidate verification/promotion adapters. Production authorization remains gated.
- Desktop bundle validation and sealed internal capabilities, optional component and launcher Preferences controls, IPC interfaces, conflict-safe launcher/PATH helpers and runtime helper probe.

## Implementation status and remaining verification

1. Desktop bundled Base now has capability-gated private generation admission and supervisor startup authority. Bundle records survive restart; private status and stopped activation use reverified records. Public unsigned generation reads remain rejected. Fresh-home/restart tests and full native packaged Personal/Base lifecycle smoke pass, including core/Codex setup, doctor, reconnect, and owned-supervisor stop/restart.
2. Desktop Preferences now calls manager-owned `privacyInstall` over nonce- and request-ID-correlated private supervisor RPC. Status/install/cancel/progress, exact-version canonical online assets, signed offline triplet selection, stopped activation, restart, and rollback attempt are wired and covered by deterministic manager/IPC/UI tests. Production install remains fail-closed and unavailable because shipped production component trust roots are empty; packaged Personal/Base smoke and Team startup denial pass, but positive signed Team installation/end-to-end activation acceptance is not claimed.
3. Private supervisor authority and bundled-generation pinning are implemented in source. Packaged Personal/Base lifecycle now passes on local macOS arm64. Relocation, failure-injection rollback and terminal-helper validation still need integration-level/platform verification; do not bypass authority with environment variables, CLI owner flags, unsigned public manifests or weakened standalone ownership checks.
4. Relocation, uninstall and terminal-helper validation still need implementation-level integration and platform verification; Personal/Base lifecycle is locally verified.

Items 3 and 4 remain unverified (relocation, failure-injection rollback, uninstall, terminal helper). They are not claimed as accepted and are tracked in `TODO.md`. Packaged Personal/Base lifecycle smoke and fail-closed Team startup denial pass in CI on the private Desktop lifecycle harness (`apps/desktop/scripts/packaged-desktop-lifecycle.mjs`).

## External gates

- Install real production trust roots into control-plane builds; configure an authorized signer and matching trust-root identities.
- Confirm npm organization/package ownership and publication credentials; execute authorized release promotion separately.
- Validate Linux/native artifacts and packaged Electron runtime/helper/fuse behavior on supported targets.
- No publication, signing-service authorization or credential changes were performed locally.

## Verification

Final local checks used Node 24.13.1:

- Server: 55 test files, 747 tests passed; typecheck and build passed.
- Desktop: 86 test files, 803 tests passed; typecheck and build passed. Existing large-chunk warning remains.
- Script suites after final fixes: 307 passed, 1 skipped, no failures.
- Root lint passed after final fixes.
- Targeted formatting passed during implementation. Full formatting remains affected by locally ignored SDD working Markdown; final tracked-file formatting is checked separately.
- Root database-dependent test suite previously stopped at `Missing required environment variable: DATABASE_URL`; no database readiness claim.

Latest direct-fix checks used Node 24.13.1: 23 focused server tests and 92 Desktop manager tests passed; server/Desktop typechecks, root lint, changed-file Prettier and `git diff --check` passed. Full Prettier check still reports only nine ignored SDD working Markdown files. No full-suite or packaged-platform rerun is claimed.

PR #404 conflict/CI repair merged current `main`, retaining both the renamed Server dependency and the new MCP dependency. Root `pnpm typecheck:test` had exposed fixture and mock contract drift that production-only typechecking does not cover; test fixtures now match those contracts without changing runtime behavior or security assertions. Node 24.13.1 verification: root production and test typechecks, lint, changed-file formatting and `git diff --check` passed; Server 57 files / 758 tests and Desktop 92 files / 894 tests passed; Desktop build passed with the existing large-chunk warning. Root `pnpm test` stopped at `packages/db/tests/managed-journal-projection.test.ts` with `Missing required environment variable: DATABASE_URL`. Full formatting still reports only the nine ignored local SDD Markdown files. No packaged-platform acceptance or database readiness claim.

Fresh-checkout CI then exposed a missing build prerequisite: root script tests assemble the public package from `packages/koed-server/dist/cli.js` before recursive package tests build the Server. Root `pnpm test` now builds the Server first. With Server `dist` removed, both package smoke tests reproduced the missing-entry error before the fix; after the fix, root tests rebuilt the CLI and all 309 script tests passed (one skipped), before the same local `DATABASE_URL` limitation stopped database tests. Existing local build output must not substitute for clean-checkout validation.

Subsequent CI exposed the same generated-output dependency in the signed setup fixture: it read the copied MCP prompt under `dist`. The fixture now reads the tracked canonical prompt and still stages it at the signed runtime path. With generated MCP prompts absent, four affected tests failed before the fix and all eight setup-security tests passed after it; the complete Server suite remained 758 tests passing.

Earlier packaged Desktop CI blocker (superseded by the local acceptance update below): the legacy smoke enabled Team and directly validated `koed-runtime/privacy-service/dist/index.js`, but this PR intentionally excludes Privacy from bundled Base. The smoke also starts bundled services through public CLI rather than the new private Desktop manager/supervisor authority. Correct migration needs explicit Personal/Base smoke plus separate fail-closed Team provisioning coverage and actual packaged private lifecycle validation. Restoring bundled Privacy, granting unsigned public authority, skipping required checks, or claiming full CI green is not an acceptable repair. Production-positive signed Team acceptance still requires approved signer/trust roots.

Latest direct-fix regressions cover bundled-generation restart/status/reactivation, foreign-owner pointer preservation, and cancellation while status RPC is pending. The private bundle reader requires a sealed capability and rechecks disk inventory; it does not introduce unsigned public trust. Cancellation latches before the first asynchronous RPC, preventing install and activation after early cancellation.

One final security review identified Desktop integration and launcher/filesystem safety blockers. Launcher and filesystem findings were fixed. Desktop manager/IPC/UI wiring now has targeted coverage, but empty production trust roots and unverified packaged activation remain release blockers. Unit tests do not establish packaged Desktop acceptance.

Latest PR404 continuation used npm-provided Node 24.13.1 because Homebrew Node's `libsimdjson.30.dylib` is missing. Private manager/supervisor status, doctor, core setup, and Codex setup/repair now retain sealed Desktop capability without public CLI or environment authority. Guided setup uses the same transport; late status responses cannot emit unhandled IPC errors after disconnect. Server: 57 files / 766 tests passed. Desktop: 93 files / 900 tests passed. Production/test typechecks and native package build/integrity passed. Full native Personal/Base smoke passed core/Codex setup, doctor, reconnect, stop/restart/final stop; separate Team startup denied missing authenticated Privacy. Masked-assets smoke passed and restored native assets. Evidence: `/tmp/pr404-status-smoke-final.log` and `/tmp/pr404-status-masked-final.log`, both exit 0. Positive Team provisioning remains blocked by empty production signer trust roots. Root lint and changed-file formatting pass. Root `pnpm test` is blocked by `Missing required environment variable: DATABASE_URL`; root formatting is blocked by pre-existing local SDD planning files. No commit/push or additional changeset.

Architecture and operation documentation were updated. Remaining work must preserve fail-closed behavior and replace unavailable adapters with real integration, not simulated success.

Final CI at PR head `abb18f36f`: Tests, Build, Static checks and the packaged Desktop smoke all passed. Setup tests now use explicit executable paths and no longer depend on installed Claude or Pi. Packaged smoke uses the private Desktop lifecycle harness and status RPC instead of bundled Privacy or public CLI authority. Full formatting reports only locally ignored SDD working Markdown. No signing, publication or credential changes were performed.

# Task 1: Public identity and coordinated version policy

## Status

Implemented and committed on `feat/publish-koed-labs-server`.

Commit: `9e913a1961d2ea1696a87d6dda79f0524edfdf12` (`feat(release): publish Koed Server identity`).

Preserved existing untracked handoff `docs/handoffs/publish-koed-labs-server.md` unchanged and un-staged. PR #400, current product version `0.8.1`, Changeset consumption, versioning, and publishing were not touched.

## Changes

- Published identity is `@koed-labs/server`; manifest marks package non-private, configures public access, Node `>=24 <25`, and sole `{ "koed": "dist/cli.js" }` bin.
- Added a `prepublishOnly` source-workspace block. Direct publishing from workspace manifest fails with `Publish assembled artifact only; source workspace publication blocked`.
- Changesets uses exact fixed group `["@koed/koed", "@koed-labs/server"]`, public access, and no longer ignores public server. Added approved minor changeset for both release units.
- Release policy tests enforce public classification and exact coordinated group. Version synchronization refuses a mismatched server version and only synchronizes root/Desktop; it never bumps the fixed-group members itself.
- Renamed workspace dependency references, runtime staging wrappers, Desktop package paths, CLI invocations, and active user-facing examples to new package/`koed` command. Kept package directory and Koed Server branding unchanged.
- No service ordering, service boundary, ingestion, retrieval, storage, or AI-client flow changed; no architecture documentation update needed.

## RED / GREEN

- Intended RED: new public-identity policy assertion failed against old `@koed/koed-server` identity; this established regression before manifest and release-policy implementation.
- GREEN: final focused policy/CI/runtime-staging tests passed 32/32; packaged Desktop runtime-path tests passed 9/9.
- Changesets CLI `status --output` ran on isolated copied workspace fixtures with baseline `0.8.1`, for product-only, server-only, and combined minor Changesets. All three planned exactly two releases at `0.9.0` (`@koed/koed` and `@koed-labs/server`), proving fixed-group propagation without source workspace version edits.
- Invoked source package `prepublishOnly` directly; expected nonzero exit and exact blocking error confirmed. No `publish`, `changeset version`, or source version edit ran.

## Verification

- `pnpm lint` — pass.
- `pnpm -r --workspace-concurrency=1 typecheck` — pass (15/16 workspaces; database package has no typecheck script).
- `pnpm --filter @koed-labs/server typecheck` — pass.
- `pnpm release:check` — pass; product release version remains synchronized at `0.8.1`.
- Targeted Prettier check over modified tracked files — pass; `git diff --check` — pass.
- Release/CI/runtime-staging Node tests — 32/32 pass. Koed Server package tests — 605 pass; Desktop tests — 792 pass; MCP Server — 543 pass, one skipped; evals — 499 pass, eight skipped. Canonical macOS `TMPDIR` used for workspace tests to avoid `/var` → `/private/var` test-path mismatch.
- Full `pnpm fmt:prettier:check` remains blocked only by pre-existing untracked `.superpowers/sdd/2026-10-05-publish-koed-labs-server/progress.md` and `task-1-brief.md`; preserved, not reformatted.
- `pnpm test` root Node suite — 249 passed, one database-dependent test skipped; required suites fail without `DATABASE_URL`. Workspace test runs were incomplete due unrelated environment/test failures: one API PTY integration test reports `Terminal could not start`; one Worker checkout test fails at `apps/worker/src/execution-checkout.test.ts:263` with `ENOENT` opening `.git/info/exclude`. API report had 1162 passed / 1 failed; Worker report had 324 passed / 1 failed / 3 skipped. Other relevant focused suites passed as listed.

## Task 9 publishing prerequisite

The source manifest intentionally remains unpublishable: it contains `workspace:*` dependency and always-failing `prepublishOnly`. Task 9 assembler must produce the complete publish payload, rewrite/resolve workspace dependencies, and remove or replace this source-only guard in assembled output before publish. Do not publish raw workspace package.

## Changed paths

- `.changeset/config.json`
- `.changeset/public-koed-server.md`
- `.env.example`
- `README.md`
- `TODO.md`
- `apps/desktop/README.md`
- `apps/desktop/electron-builder.yml`
- `apps/desktop/package.json`
- `apps/desktop/scripts/desktop-artifact-report-lib.test.mjs`
- `apps/desktop/scripts/smoke-packaged-desktop-app.mjs`
- `apps/desktop/src/collaboration/local-transport.test.ts`
- `apps/desktop/src/collaboration/local-transport.ts`
- `apps/desktop/src/koed-server/manager.collaboration.test.ts`
- `apps/desktop/src/koed-server/manager.test.ts`
- `apps/desktop/src/koed-server/manager.ts`
- `apps/desktop/src/koed-server/runtime.test.ts`
- `apps/desktop/src/koed-server/runtime.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/renderer/devices/DeviceRequestPanel.test.tsx`
- `apps/desktop/src/renderer/devices/DeviceRequestPanel.tsx`
- `apps/desktop/src/renderer/devices/DevicesModal.test.tsx`
- `apps/desktop/src/status-model.ts`
- `apps/desktop/tsconfig.json`
- `apps/privacy-service/README.md`
- `docs/codex-integration.md`
- `docs/configuration.md`
- `docs/desktop-internal-artifacts.md`
- `docs/desktop-ui.md`
- `docs/device-pairing.md`
- `docs/embedding-service-python-venv-evaluation.md`
- `docs/native-runtime-artifact-procurement-spike.md`
- `docs/native-runtime-assets.md`
- `docs/observability.md`
- `docs/pi-integration.md`
- `docs/running-koed.md`
- `docs/server-deployment-boundary.md`
- `docs/service-sequence-overview.md`
- `docs/standalone-koed-server-package.md`
- `docs/two-user-vps-dogfood-runbook.md`
- `docs/version-and-processing-epoch-inventory.md`
- `examples/docker-compose/README.md`
- `examples/server-compose/README.md`
- `package.json`
- `packages/app-runtime-stage/package.json`
- `packages/koed-server/Dockerfile`
- `packages/koed-server/package.json`
- `packages/koed-server/src/cli.test.ts`
- `packages/koed-server/src/cli.ts`
- `packages/koed-server/src/local-embedding-runtime.ts`
- `packages/koed-server/src/local-models-runtime.test.ts`
- `packages/koed-server/src/local-models-runtime.ts`
- `packages/koed-server/src/local-postgres-runtime.ts`
- `packages/koed-server/src/personal-sync.ts`
- `packages/koed-server/src/pi-setup.ts`
- `packages/koed-server/src/privacy-model-runtime.ts`
- `packages/koed-server/src/restart.ts`
- `packages/koed-server/src/runtime-homebrew.ts`
- `packages/koed-server/src/runtime-packaged.ts`
- `packages/koed-server/src/setup.test.ts`
- `packages/koed-server/src/setup.ts`
- `packages/koed-server/src/start.test.ts`
- `packages/koed-server/src/start.ts`
- `packages/koed-server/src/status.test.ts`
- `packages/koed-server/src/status.ts`
- `packages/koed-server/src/stop.ts`
- `packages/koed-server/src/upstream-enrollment.ts`
- `pnpm-lock.yaml`
- `scripts/app-runtime-staging.mjs`
- `scripts/app-runtime-staging.test.mjs`
- `scripts/build-koed-server-package.mjs`
- `scripts/bundled-local-smoke-lib.mjs`
- `scripts/hosted-backup-lib.mjs`
- `scripts/lcm-smoke-test.mjs`
- `scripts/native-runtime/validate-runtime.mjs`
- `scripts/native-runtime/validate-wsl.mjs`
- `scripts/personal-device-sync-fixture.mjs`
- `scripts/product-release-version-lib.mjs`
- `scripts/product-release-version-lib.test.mjs`
- `scripts/source-runtime-build-lib.test.mjs`
- `tsconfig.base.json`

## Round 1 follow-up: fresh review findings

- Fixed all active CI/release/cache workflow package filters to `@koed-labs/server`; added `scripts/ci-policy.test.mjs` regression coverage across the five workflows.
- Changed general and Personal Sync CLI help executable strings to `koed`; added CLI help assertions in `packages/koed-server/src/cli.test.ts`.
- Updated stale active CLI command examples in docs, including deployment configuration, pairing, observability, runbook, package, and service sequence docs. Kept internal service naming and ADR/history references intact.
- TDD RED: policy test failed on first old workflow filter; CLI test failed on `Usage: koed-server <command> [options]`. GREEN: `node --test scripts/ci-policy.test.mjs` passed 18/18; `pnpm --filter @koed-labs/server exec vitest run src/cli.test.ts` passed 45/45.
- Focused verification: `pnpm --filter @koed-labs/server typecheck` and ESLint on changed TS/MJS test/code files passed. Prettier initially flagged `packages/koed-server/src/cli.test.ts`; formatted it, then confirmed formatting in final verification.
- Round 1 files also include `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/release-desktop-assets.yml`, `.github/workflows/native-runtime-cache.yml`, `.github/workflows/native-runtime-linux-cache.yml`, `scripts/ci-policy.test.mjs`, `packages/koed-server/src/cli.ts`, and `packages/koed-server/src/cli.test.ts`.

## Round 2 follow-up: fresh reviewer executable references

- Updated secret-provider invalid-usage help to `koed secret-provider ...` and configuration examples to `koed secret-provider ...`.
- Updated missing standalone package remediation to `Run koed package install ...`.
- Follow-up scan found three actionable device-identity remediation strings in `packages/shared/src/device-identity.ts`; changed them from `koed-server identity rotate --json` to `koed identity rotate --json`, with regression assertion in `packages/koed-server/src/device-identity.test.ts`. Internal process/package naming remains unchanged.
- TDD RED: `vitest run src/cli.test.ts src/package-runtime.test.ts` failed exactly at old secret-provider usage and package-install remediation strings (63 passed, 2 failed). Device-identity targeted test failed on old `koed-server identity rotate --json` string. GREEN: focused Koed Server CLI/package/device-identity tests passed 79/79.
- Verification with Node 24 from `/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin`: `pnpm --filter @koed-labs/server exec vitest run src/cli.test.ts src/package-runtime.test.ts src/device-identity.test.ts` passed 79/79; Koed Server and Shared typechecks passed; ESLint on changed TS files passed; targeted Prettier check passed; `git diff --check` passed.
- Remaining `koed-server` occurrences found by scoped executable scan are package descriptions/internal message or a test negative assertion, not executable invocation guidance. No architecture/service flow changed; no architecture documentation update needed.

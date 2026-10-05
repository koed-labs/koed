# Task 7: Trusted service resolver and startup integration

**Status: Partial; Desktop ownership acceptance remains blocked.** This record captures implementation and verification completed for Task 7. Do not treat packaged Desktop startup as supported until a validated private Desktop supervisor channel is implemented and tested.

## Implemented

- `packages/koed-server/src/app-runtime.ts` resolves packaged app-service entries from verified base/privacy component roots only. Packaged resolution rejects `KOED_JS_RUNTIME_ROOT`, `KOED_REPO_ROOT`, `KOED_PACKAGED_RESOURCES_PATH`, and `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK`; missing authenticated base/privacy selection fails closed. Source-checkout execution retains `paths.repoRoot` compatibility, selected from the control-plane module location rather than caller flags.
- `packages/koed-server/src/effective-runtime-config.ts` resolves effective configuration and Team state before calculating required components/processes/models. Personal bundled-local startup requires base only; Privacy is required only for bundled-local Team. Bundled-local queue defaults to local unless process environment explicitly overrides it.
- `packages/koed-server/src/service-runtime-selection.ts` verifies/pins the active generation, compares generation product version with actual control-plane package version, resolves paths from the pin, and releases the pin if selection/validation fails. `packages/koed-server/src/start.ts` holds returned pin until supervisor cleanup and releases it through generation lifecycle token/process-identity checks. Startup does not install/download a generation.
- `packages/koed-server/src/local-privacy-runtime.ts` and `packages/koed-server/src/local-embedding-runtime.ts` accept selected runtime paths. Packaged Embedding Service lookup does not fall back to KOED_HOME, packaged-resource, or checkout JS entries after selection.
- `packages/koed-server/src/status.ts` reports absence of authenticated app-runtime generation as a setup/activation requirement without installing or activating components. `packages/koed-server/src/setup.test.ts`, `packages/koed-server/src/pi-setup.test.ts`, and `packages/koed-server/src/start.test.ts` no longer use Desktop/package environment flags as execution-mode authority.
- Updated `docs/running-koed.md`, `docs/configuration.md`, and existing coordinated minor `.changeset/public-koed-server.md`.

## Verification

Node 24.13.1 (`/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin/node`), freshly rerun before commit:

- `pnpm --filter @koed-labs/server test` — 51 files, 720 tests passed.
- `pnpm --filter @koed-labs/server typecheck` — passed.
- `pnpm --filter @koed-labs/server build` — passed.
- `pnpm lint` — passed.
- Targeted Task 7 suites (`app-runtime`, `service-runtime-selection`, `local-embedding-runtime`, `local-privacy-runtime`, `start`, `stop`, `status`, `effective-runtime-config`) — 8 files, 194 tests passed.
- `pnpm lint` — passed. One concurrent run transiently hit a generated test-fixture ENOENT; serial rerun passed.
- Targeted Prettier check and `git diff --check` — passed.
- `pnpm fmt:prettier:check` — blocked by pre-existing formatting findings in eight `.superpowers/sdd/2026-10-05-publish-koed-labs-server/{progress,task-1-brief,task-2-brief,task-3-brief,task-4-brief,task-5-brief,task-6-brief,task-7-brief}.md` files.

## Limits and follow-up

- `resolveKoedRuntimeOwner()` currently derives a standalone owner identity from the real control-plane package root. There is no validated private Desktop supervisor channel in this implementation. A Desktop-owned generation therefore fails closed with an actionable owner-mismatch error; Desktop must not pass owner authority through environment variables or spoofable CLI flags. This is an explicit unresolved Task 7 acceptance criterion, not a supported fallback.
- Production component trust roots remain empty and publishing/signing is an external gate; packaged roots remain fail-closed until trusted signer configuration is supplied.
- Setup/configuration callers do not acquire a service-runtime selection. Packaged setup integrations that need Base entry paths therefore fail closed without a selected generation; standalone packaged setup is not yet acceptance-complete. Fix requires async verified, no-pin generation selection for diagnostic/setup work (and the validated private channel for Desktop-owned setup). Never restore environment-path fallback.
- No documentation claims source fallback or implicit provisioning in packaged startup.

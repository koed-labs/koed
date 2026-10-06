# Task 7: Trusted service resolver and startup integration

**Status: Partial; Desktop ownership acceptance remains blocked.** This record captures implementation and verification completed for Task 7. Do not treat packaged Desktop startup as supported until a validated private Desktop supervisor channel is implemented and tested.

## Implemented

- `packages/koed-server/src/app-runtime.ts` resolves packaged app-service entries from verified base/privacy component roots only. Packaged resolution rejects `KOED_JS_RUNTIME_ROOT`, `KOED_REPO_ROOT`, `KOED_PACKAGED_RESOURCES_PATH`, and `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK`; missing authenticated base/privacy selection fails closed. Source-checkout execution retains `paths.repoRoot` compatibility, selected from the control-plane module location rather than caller flags.
- `packages/koed-server/src/effective-runtime-config.ts` resolves effective configuration and Team state before calculating required components/processes/models. Personal bundled-local startup requires base only; Privacy is required only for bundled-local Team. Bundled-local queue defaults to local unless process environment explicitly overrides it.
- `packages/koed-server/src/service-runtime-selection.ts` verifies/pins the active generation, compares generation product version with actual control-plane package version, resolves paths from the pin, and releases the pin if selection/validation fails. `packages/koed-server/src/start.ts` holds returned pin until supervisor cleanup and releases it through generation lifecycle token/process-identity checks. Startup does not install/download a generation.
- `packages/koed-server/src/local-privacy-runtime.ts` and `packages/koed-server/src/local-embedding-runtime.ts` accept selected runtime paths. Packaged Embedding Service lookup does not fall back to KOED_HOME, packaged-resource, or checkout JS entries after selection.
- `packages/koed-server/src/status.ts` now resolves Codex, Claude Code, and Capture Hook paths from authenticated packaged runtime selection; missing selection returns an actionable generation/setup state instead of comparing against current-directory or checkout paths. It does not install or activate components.
- Round 2 closes three overlooked setup entrypoints: exported `repairCodexIntegration` authenticates before writing Codex config, `setupClaude` before executable/MCP/Capture Hook operations, and `setupPi` before candidate selection/copy/install. `setupCodex` passes its previously authenticated runtime into repair. CLI awaits the now-async callers.
- `packages/koed-server/src/setup-runtime-security.test.ts` calls exported Claude setup, direct Codex repair, Pi setup, and `inspectCodex` with packaged execution mocked and a missing signed generation. Assertions prove no Claude/Pi spawn, Codex config write, or Pi package copy/install; status returns an actionable missing-generation result rather than trusting a planted CWD MCP CLI. These negative tests do not establish valid signed-selected path usage through each setup/status caller; separate runtime-selection tests cover authenticated selection itself.
- `packages/koed-server/src/start.ts` now covers all post-supervisor-lock initialization in guarded lifecycle flow, including identity, effective config, secrets, log directory, ports, repo env, credentials, and source prep. It tracks cleanup start and error phase; early failures release lock while cleanup-started failures retain ownership unless clean shutdown is verified. Device-request close errors aggregate without skipping child shutdown.
- Updated `docs/running-koed.md`, `docs/configuration.md`, and existing coordinated minor `.changeset/public-koed-server.md`.

## Verification

Node 24.13.1 (`/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin/node`) with cached pnpm JS `/opt/homebrew/Cellar/node@24/24.14.0/lib/node_modules/corepack/dist/pnpm.js`; PATH prepended with Node 24 bin so pnpm children also use Node 24:

- `pnpm --filter @koed-labs/server test` — 52 files, 727 tests passed.
- Focused setup/status/start suites, including new exported-entrypoint regressions — 6 files, 193 tests passed.
- `pnpm --filter @koed-labs/server typecheck` — passed.
- Root `pnpm typecheck` — passed after workspace build.
- Root `pnpm build` — passed.
- Root `pnpm lint` — passed.
- Targeted Prettier check over changed TypeScript and this report — passed.
- Root `pnpm test` — failed in `packages/db/tests/managed-journal-projection.test.ts`: `Missing required environment variable: DATABASE_URL`; other workspace suites reported pass, 1 DB-dependent suite could not initialize. Do not report root suite as passed.
- Root `pnpm fmt:prettier:check` not rerun; prior Task 7 check was blocked by pre-existing formatting findings in eight `.superpowers/sdd/2026-10-05-publish-koed-labs-server/{progress,task-1-brief,task-2-brief,task-3-brief,task-4-brief,task-5-brief,task-6-brief,task-7-brief}.md` files.

## Limits and follow-up

- `resolveKoedRuntimeOwner()` currently derives a standalone owner identity from the real control-plane package root. There is no validated private Desktop supervisor channel in this implementation. A Desktop-owned generation therefore fails closed with an actionable owner-mismatch error; Desktop must not pass owner authority through environment variables or spoofable CLI flags. This is an explicit unresolved Task 7 acceptance criterion, not a supported fallback.
- Production component trust roots remain empty and publishing/signing is an external gate; packaged roots remain fail-closed until trusted signer configuration is supplied.
- Round 2 added async no-pin authenticated selection to Codex repair, Claude setup, Pi setup, and status. Still unverified: valid signed-generation paths exercised end-to-end through each exported setup/status function; current new regressions verify fail-closed behavior only. Add fixture-adapter coverage before claiming this acceptance complete.
- Desktop ownership limitation remains: `resolveKoedRuntimeOwner()` derives standalone owner identity from real control-plane package root. No validated private Desktop supervisor channel exists. Desktop-owned generation fails closed; do not pass owner authority through environment variables or spoofable CLI flags.
- Production component trust roots remain empty and publishing/signing is an external gate; packaged roots remain fail-closed until trusted signer configuration is supplied.
- No documentation claims source fallback or implicit provisioning in packaged startup.

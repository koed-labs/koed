# Task 2 report: effective configuration and component contracts

## Implemented

- Added cross-task contracts in `packages/koed-server/src/component-contract.ts`: `ComponentId`, `ProcessId`, `ArtifactTarget`, `RuntimeIdentity`, `RuntimeCompatibility`, `ComponentManifest`, `ComponentSignature`, `RuntimeRequirements`, `RuntimeOwner`, `VerifiedComponent`, and `VerifiedGeneration`.
- Added `resolveEffectiveRuntimeConfig` and pure `calculateRuntimeRequirements` in `packages/koed-server/src/effective-runtime-config.ts`.
- Effective precedence: process environment > explicit `KOED_ENV_PATH` file > `KOED_HOME/config/server.json` > existing defaults. Explicit env paths must exist. Packaged mode never discovers checkout `.env`; source mode retains `.env` discovery and lenient legacy parsing. Explicit env files parse strictly and include source/line in syntax errors. Packaged server configuration rejects malformed JSON, non-object JSON, and invalid supported values instead of downgrading to defaults.
- Team derives from existing `KOED_TEAM_COLLABORATION_ENABLED` detector after env layering. Local privacy component/process/model are required only for Team + `bundled-local`. External dependencies do not select local privacy assets. Queue defaults to local for `bundled-local`, BullMQ for external; valid `WORK_QUEUE_BACKEND=local|bullmq` overrides. Bundled-local requirements include Postgres and llama-server native requirements and Embedding Service/embedding model. Existing external URLs remain resolved from server config and existing environment keys.
- Added strict parser/config, matrix, queue, Team, precedence, source compatibility, and invalid-input coverage. Documented behavior in `docs/configuration.md`.

## Verification

- Initial RED: `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server exec vitest run src/component-contract.test.ts src/effective-runtime-config.test.ts src/config.test.ts src/env-file.test.ts` — expected failure before implementation: `Cannot find module './effective-runtime-config.js'`; 17 existing tests passed, feature suite could not load before module existed.
- GREEN: same command after implementation — 4 files passed, 36 tests passed.
- `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server typecheck` — passed.
- `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server test` — 45 files passed, 626 tests passed.
- `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server build` — passed.
- `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm exec prettier --check packages/koed-server/src/component-contract.ts packages/koed-server/src/component-contract.test.ts packages/koed-server/src/effective-runtime-config.ts packages/koed-server/src/effective-runtime-config.test.ts packages/koed-server/src/config.ts packages/koed-server/src/config.test.ts packages/koed-server/src/env-file.ts packages/koed-server/src/env-file.test.ts docs/configuration.md` — passed.
- `git diff --check` — passed.

## Concerns / boundaries

- No launch integration was added; Task 7 remains responsible for wiring shared requirements into lifecycle flows, as specified.
- Effective external requirements preserve existing endpoint configuration; this task does not add new service configuration requirements or validate whether external services are reachable.
- Unrelated pre-existing untracked `docs/handoffs/publish-koed-labs-server.md` was left untouched and excluded from commit.

## Round 1 fixes

- Strict env parser now finds actual closing quote; accepts trailing whitespace/comments and rejects trailing non-comment text. Lenient source parsing stays unchanged.
- Strict persisted `hardwareAcceleration` validation now runs before environment precedence, so an environment override cannot mask invalid `server.json`; errors include config path.
- Expanded matrix to all 12 runtime/dependency/Team combinations; added source-vs-packaged `.env` discovery, malformed explicit env, invalid queue, and env-derived Team=true requirements coverage. External service endpoint tests remain unchanged; no new external service/token requirements added.

## Round 1 RED/GREEN and checks

- RED: `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server exec vitest run src/effective-runtime-config.test.ts src/config.test.ts src/env-file.test.ts` — `Test Files 3 failed (3); Tests 5 failed | 40 passed (45)`. Expected failures: quoted comments rejected as unterminated, trailing garbage accepted, invalid persisted hardware value masked by override, source `.env` Team discovery false, malformed explicit env reported as unterminated instead of trailing-text error.
- GREEN focused: `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server exec vitest run src/component-contract.test.ts src/effective-runtime-config.test.ts src/config.test.ts src/env-file.test.ts` — `Test Files 4 passed (4); Tests 46 passed (46)`.
- Full server tests: `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server test` — `Test Files 45 passed (45); Tests 636 passed (636)`.
- `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm --filter @koed-labs/server typecheck` and `pnpm --filter @koed-labs/server build` — passed under Node `v24.13.1`.
- `PATH="/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin:$PATH" pnpm lint` — passed.
- Targeted Prettier check for changed source/tests — passed. Full `pnpm fmt:prettier:check` remains blocked by existing formatting in `.superpowers/sdd/2026-10-05-publish-koed-labs-server/progress.md`, `task-1-brief.md`, `task-2-brief.md`, and `task-3-brief.md`; left unrelated files unchanged.

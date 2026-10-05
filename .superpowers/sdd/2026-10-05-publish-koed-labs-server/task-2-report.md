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

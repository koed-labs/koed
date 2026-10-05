# Task 6 implementation evidence — verified runtime lifecycle

## Scope

Implemented lifecycle primitives for verified runtime generations, without wiring source, Desktop, or standalone startup; that integration remains Task 7. Empty production component trust roots remain blocked. Existing coordinated `public-koed-server` minor changeset remains the release note; no additional changeset added.

## Implementation

- Added `packages/koed-server/src/generation-lifecycle.ts`: `readCurrentGeneration`, `pinGenerationForStart`, `activateGeneration`, and `cleanupGenerations`.
- Lifecycle exclusion uses atomic lock-directory creation, process start identity, and a random 256-bit token. Unreadable/malformed ownership and uncertain liveness fail closed; confirmed dead/PID-reused ownership can be reclaimed. Lock order is lifecycle exclusion → `proper-lockfile` store lock → supervisor state inspection.
- Startup pin verifies selected generation and owner, writes strict process/owner/token state atomically, and retains exclusion until matching-token `release()`. Activation/cleanup cannot mutate pinned runtime files. Activation checks legacy supervisor state too; malformed/live/uncertain lock blocks mutation.
- `components/current.json` switches with same-directory temp-file rename only after candidate re-verification, owner match, stopped-runtime checks, and package migration compatibility check. Cleanup deletes only verified inactive generations for matching owner; active/newest generations stay. User data and model roots are untouched.
- Exported existing package migration guard as `assertPackageMigrationCompatible` and reused it for activation. Unknown migration rollback policy conservatively blocks downgrade; existing `allowsRollback: false` regression remains covered by package-runtime tests.
- Added strict runtime generation state validation, lifecycle state path, supervisor lock fail-closed handling and identity-checked release. Added generation schema regression requiring `privacy` presence to match `components.privacy` presence.
- Updated `docs/running-koed.md` with lifecycle behavior, rollback boundary, cleanup preservation, and explicit non-integration status.

## Tests and verification

TDD RED: before implementation, focused test import failed as expected: `Cannot find module '/src/generation-lifecycle.js' imported from ...generation-lifecycle.test.ts` (0 tests). GREEN focused tests covered generation lifecycle, runtime state, supervisor lock, component store, and package runtime. Lifecycle tests use a promise barrier immediately before pin persistence, a spawned Node child process attempting the shared atomic lock-directory operation, and injected rename failure to verify interrupted pointer replacement leaves old pointer intact; no sleep-based race guesses.

Final Node 24 verification using `/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin/node` and `/opt/homebrew/Cellar/node@24/24.14.0/lib/node_modules/corepack/dist/pnpm.js`:

- `pnpm --filter @koed-labs/server test` — 50 files, 720 tests passed.
- `pnpm --filter @koed-labs/server typecheck` — passed.
- `pnpm --filter @koed-labs/server build` — passed.
- Targeted ESLint over changed TypeScript files — passed.
- Targeted Prettier check over changed TypeScript and `docs/running-koed.md` — passed.

## Limits

- Task 7 must call `pinGenerationForStart` at startup and release pin on every stop/error path; activation APIs are not wired into public commands or Desktop control-plane channel yet.
- Production official trust roots remain empty; fixtures use signed test keys only.
- Component generation records currently carry no migration journal metadata; therefore lifecycle downgrade is conservatively refused rather than guessing rollback compatibility. Existing package-level migration guard retains its `allowsRollback` policy.
- Full Linux/Windows runtime coverage and actual power-loss crash testing were not run; verification used available macOS Node 24 environment. Pointer test injects rename failure before replacement; atomic rename itself remains filesystem-provided.

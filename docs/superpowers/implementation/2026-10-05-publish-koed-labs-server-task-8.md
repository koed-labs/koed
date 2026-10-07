# Task 8 implementation evidence — explicit components CLI and lazy dispatch

## Scope

Implemented Task 8 from `.superpowers/sdd/2026-10-05-publish-koed-labs-server/task-8-brief.md`. The CLI exposes explicit signed component status, install, activate, and cleanup commands. Help and lightweight model/native status dispatch avoid importing the service command graph. No component, model, or native dependency installs implicitly on help, status, or start.

## Security and lifecycle

- Component install accepts exactly one signed source: complete offline archive/manifest/signature paths or complete archive/manifest/signature URLs. Inputs are rejected when incomplete, mixed, duplicated, or unsupported.
- CLI exposes no trust-root or owner override. Runtime identity, control-plane version, and owner come from Koed process context; component verification uses production trust roots and actual runtime compatibility.
- Installs for another product version, incomplete component sets, explicit stage-only requests, or running services remain staged. Matching current version activates only when required set is complete and service is stopped. Rollback activation requires matching control-plane version and a complete owned generation.
- Status distinguishes missing, installed, staged, active, incompatible, and not-required components. Cleanup delegates to verified generation lifecycle and retains two newest eligible generations plus current active generation.
- `docs/running-koed.md` documents explicit offline/network install, upgrades, stopped activation, rollback, cleanup, and fail-closed empty production trust roots.

## Tests and verification

Node `v24.13.1` via `/Users/jedd/.npm/_npx/8a4b1eccb173403d/node_modules/node/bin/node`:

- Focused component/CLI/lazy dispatch tests: 3 files, 58 tests passed.
- Full server suite: 54 files, 744 tests passed.
- `pnpm --filter @koed-labs/server typecheck`: passed.
- `pnpm --filter @koed-labs/server build`: passed.
- `pnpm lint`: passed.
- Targeted Prettier check for all changed TypeScript and `docs/running-koed.md`: passed.
- `git diff --check`: passed.
- Built CLI isolated-home smoke: help includes component commands; `models status --json` and `components status --json` succeed. `runtime status --json` returns valid missing-runtime JSON and exit 1 in empty home; no install occurred.
- Lazy-dispatch tests mock service startup import to throw; help, model status, and native status stay outside service graph, while service command failure returns actionable provisioning guidance rather than `ERR_MODULE_NOT_FOUND`. Fetch spy confirms help and lightweight status do not download artifacts.
- Component tests cover missing and installed status, signed offline staging, incompatible alternate version, control-plane mismatch, running-service staging, and exact-version signed remote fetch of manifest/signature/archive.

## Formatting limitation

Full `pnpm fmt:prettier:check` fails on nine pre-existing `.superpowers/sdd/2026-10-05-publish-koed-labs-server/{progress.md,task-1-brief.md,...,task-8-brief.md}` planning/brief files. Those files were not reformatted to avoid unrelated changes. Targeted formatting check for implementation and user-facing docs passed.

## Release note

No new changeset added. User-approved minor-bump decision for this release carries forward from earlier task approval.

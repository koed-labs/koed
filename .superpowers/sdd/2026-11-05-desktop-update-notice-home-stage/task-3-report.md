# Task 3 report: Home-stage update notice

Implemented approved notify-only desktop update notice. Main bar links to Preferences → About; panel shows installed/latest versions, plain release notes, manual check/current/error states, and official release-page action only. Existing About version remains sourced from `__KOED_DESKTOP_VERSION__`. State snapshots/actions cannot overwrite newer events. No download, installer, restart, or install-on-quit behavior added.

Private packaged smoke requests a disabled notice state using the actual Electron app version and does not invoke update/network authority. Added safe manual update procedure, documentation links, and approved minor `@koed/koed` changeset.

## Verification

- `pnpm --filter @koed/desktop test` — passed, 151 files / 1438 tests.
- `pnpm --filter @koed/desktop test:packaged-smoke` — passed, 40 tests.
- Focused update/App/harness Vitest — passed, 3 files / 15 tests.
- `pnpm --filter @koed/desktop typecheck` — passed.
- `pnpm --filter @koed/desktop build` — passed; existing large-chunk warning emitted.
- Targeted Prettier check over changed source/docs/changeset files — passed.
- `git diff --check` — passed.

## Limitations

- Workspace-wide formatting check remains blocked by unrelated `.superpowers` Markdown formatting; those files were intentionally left untouched.
- `pnpm lint` exceeded available Node heap under Node v26.3.1 (`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`). Project engine requests Node >=24 <25.

## Review corrections

Review follow-up moved the notice from the inactive legacy renderer into the production V1 Home shell and Settings → About. Removed dead update wiring from the legacy `App`, shell, and Preferences view. The Home indicator opens About; existing app version remains available while update state loads.

Private packaged smoke now reads `updateDiscovery.current()` rather than fabricating a disabled status. Its test uses a real ineligible discovery instance and verifies disabled state with zero fetches and no manager invocation. Renderer hook accepts a snapshot only if it is fresher than an intervening event, ignores stale snapshot failures, and clears superseded errors. About panel emits one alert per failure and includes a safe manual procedure (pause AI Client/CLI, stop each home via its Desktop CLI launcher, verify `ok: true` and `lifecycle.state: stopped`, stop if ownership is unclear, preserve home/config/models, then use the official macOS arm64 release page). No download/install/restart authority added.

TDD regressions: fresher snapshot wins after an earlier event, stale snapshot cannot overwrite a newer event, stale snapshot failures are ignored after live events, live events clear prior snapshot errors, V1 production wiring, smoke discovery/no-network state, safe procedure, and single error alert.

Correction verification:

- `pnpm --filter @koed/desktop test` — passed, 151 files / 1441 tests.
- `pnpm --filter @koed/desktop test:packaged-smoke` — passed, 40 tests.
- `pnpm --filter @koed/desktop typecheck` — passed.
- `pnpm --filter @koed/desktop build` — passed; existing node:crypto externalization and large-chunk warnings remain.
- Targeted Prettier check and `git diff --check` — passed.
- Node v26.3.1 still warns repo engine requires >=24 <25. Reviewer report file supplied at `/var/folders/1y/rhkfw3_91qjgspflp7kkxqkh0000gn/T/acp-delegate/del_mw49pwmp_xcli.out` was unavailable (ENOENT); fixes followed the five findings stated in the request.

No architecture documentation change needed: corrections alter active UI wiring and smoke verification, not service boundaries or update authority.

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

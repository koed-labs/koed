# Desktop Update Notice on Home-stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the packaged macOS arm64 notify-only Desktop update experience onto a new branch based on Koed Home-stage without importing the unrelated release stack.

**Architecture:** Add a strict shared update contract and main-process release-metadata discovery, expose fixed notice-only operations through authenticated IPC/preload, and adapt the existing Home-stage shell and About Preferences surface. Preserve Home-stage lifecycle/build code; users open the official release and update manually.

**Tech Stack:** TypeScript, Electron IPC, React, Zod, Vitest, Node smoke tests, Changesets.

**Spec:** `docs/superpowers/specs/2026-11-05-desktop-update-notice-home-stage-design.md`

## Global Constraints

- Base: `origin/claude/koed-home-stage`; working branch: `feat/desktop-update-notice-home-stage`.
- Preserve Home-stage product version `0.10.0`, lifecycle, renderer, and packaging scripts; do not replay the release stack or wholesale-replace shared files.
- Enable checks only for eligible packaged macOS arm64 builds; metadata checks are bounded, official-origin-only, and fail closed.
- No binary download, updater dependency, install/restart IPC, or install-on-quit.
- Keep release notes as plain text and use fixed renderer operations; renderer supplies no URL, path, header, tag, or installer option.
- Add a minor changeset for `@koed/koed`; do not target ignored `@koed/desktop`.
- Keep documentation specific to the notify-only/manual-update checkpoint; do not claim digest metadata proves native signing/notarization.

## Review Focus

- **Ineligible builds:** dev, private smoke, non-macOS, non-arm64, or invalid product versions remain disabled and make no request; test `never schedules or checks in ineligible builds`.
- **Untrusted metadata:** redirect, wrong origin/content type, hostile pagination Link, malformed JSON, or response-budget overflow fails closed; test `rejects malicious pagination and redirected responses` and `rejects an aggregate response exceeding the scan budget`.
- **Unsupported highest stable release:** do not fall back to an older release if required DMG/checksum assets are missing, malformed, or have unsafe destinations; test `fails closed when highest stable release lacks required assets`.
- **IPC authority:** reject subframes, same-origin foreign windows, bad origins, destroyed windows, and malformed requests; test `rejects subframes, same-origin foreign windows, bad origins and destroyed windows`.
- **Renderer races and action boundary:** stale snapshots/events cannot resurrect UI; manual update never exposes download/install/restart; test `ignores stale initial snapshot after newer event and removes subscription` and `shows installed/latest versions and plain-text notes, with no download/install action`.

---

### Task 0: Commit approved design artifacts

**Files:**

- Commit: `docs/superpowers/specs/2026-11-05-desktop-update-notice-home-stage-design.md`
- Commit: `docs/superpowers/plans/2026-11-05-desktop-update-notice-home-stage.md`

- [ ] **Step 1: Verify design-file formatting.** Run `pnpm exec prettier --check docs/superpowers/specs/2026-11-05-desktop-update-notice-home-stage-design.md docs/superpowers/plans/2026-11-05-desktop-update-notice-home-stage.md`; expected: both files pass. The current workspace-wide `pnpm fmt:check` also scans three unrelated, untracked `.superpowers/sdd/2026-11-03-peer-online-sync-slice/` files that already fail Prettier; do not modify them as part of this task.
- [ ] **Step 2: Commit the approved design and plan.** `git add docs/superpowers/specs/2026-11-05-desktop-update-notice-home-stage-design.md docs/superpowers/plans/2026-11-05-desktop-update-notice-home-stage.md && git commit -m "docs: plan Home-stage update notice port"`.

### Task 1: Shared contract and bounded release discovery

**Files:**

- Create: `packages/shared/src/desktop-update-contract.ts`
- Create: `packages/shared/src/desktop-update-contract.test.ts`
- Modify: `packages/shared/package.json`
- Create: `apps/desktop/src/main/update-discovery.ts`
- Create: `apps/desktop/src/main/update-discovery.test.ts`

**Interfaces:**

- Produce `desktopUpdateCommandChannel`, `desktopUpdateEventChannel`, `desktopStableVersionPattern`, `desktopUpdateRequestSchema`, and `desktopUpdateStateSchema` from `packages/shared/src/desktop-update-contract.ts`.
- Produce `DesktopUpdateState`, `DesktopUpdateRequest`, and `DesktopUpdateApi`; `DesktopUpdateApi` exposes `getState(): Promise<DesktopUpdateState>`, `checkForUpdates(): Promise<DesktopUpdateState>`, `openReleasePage(): Promise<DesktopUpdateState>`, and `subscribe(listener: (state: DesktopUpdateState) => void): () => void`.
- Produce `createUpdateDiscovery(options: DiscoveryOptions): DesktopUpdateDiscovery`, where `DiscoveryOptions` contains `eligible: boolean`, `installedVersion: string`, and optional `fetch?: typeof globalThis.fetch` and `random?: () => number`. The controller exposes `current(): DesktopUpdateState`, `subscribe(listener: (state: DesktopUpdateState) => void): () => void`, `check(): Promise<DesktopUpdateState>`, `start(): void`, and `dispose(): void`.

- [ ] **Step 1: Add contract tests first.** Assert requests accept only `get_state`, `check`, and `open_release`; the state schema is bounded and `available` always has a release while `idle`, `current`, and `disabled` do not.
- [ ] **Step 2: Run contract tests and confirm failure.** Run `pnpm --filter @koed/shared exec vitest run src/desktop-update-contract.test.ts`; expected: tests fail because the contract module does not exist.
- [ ] **Step 3: Implement the contract and package export.** Add `./desktop-update-contract` to the existing shared package exports without removing Home-stage exports.
- [ ] **Step 4: Verify contract.** Run the focused contract test and `pnpm --filter @koed/shared build`; expected: tests and build pass.
- [ ] **Step 5: Add discovery tests.** Cover eligibility/no network, highest stable selection across locally constructed pages, malformed/hostile pagination and redirects, unsupported highest-release assets, bounded bodies/timeouts, single-flight/cooldown/backoff, and disposal suppressing stale results. Use Home-stage product-version fixtures; do not copy the old branch's hard-coded `v0.8.1` environment assumption.
- [ ] **Step 6: Run discovery tests and confirm failure.** Run `pnpm --filter @koed/desktop exec vitest run src/main/update-discovery.test.ts`; expected: tests fail because the discovery module does not exist.
- [ ] **Step 7: Implement discovery.** Scan at most 10 locally constructed GitHub release pages, with 2 MiB/page and 10 MiB/scan budgets, a 10-second deadline, strict official URL checks, highest numeric stable-version selection, and required version-bound manual DMG/checksum eligibility.
- [ ] **Step 8: Verify task.** Run the contract and discovery test commands; expected: all focused tests pass.
- [ ] **Step 9: Commit.** `git add packages/shared/package.json packages/shared/src/desktop-update-contract.ts packages/shared/src/desktop-update-contract.test.ts apps/desktop/src/main/update-discovery.ts apps/desktop/src/main/update-discovery.test.ts && git commit -m "feat(desktop): add bounded update discovery"`.

### Task 2: Main-process lifecycle, authenticated IPC, and preload API

**Files:**

- Create: `apps/desktop/src/ipc/update.ts`
- Create: `apps/desktop/src/ipc/update.test.ts`
- Create: `apps/desktop/src/ipc/update-preload.ts`
- Create: `apps/desktop/src/ipc/update-preload.test.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.cts`
- Modify: `apps/desktop/src/types.ts`

**Interfaces:**

- `registerDesktopUpdateIpc(options)` registers only `desktopUpdateCommandChannel`, validates exact requests, checks the live main window, main frame, and approved origin, and returns an idempotent disposer.
- `createDesktopUpdatePreloadApi(invoke: (channel: string, value: unknown) => Promise<unknown>, events: { on(channel: string, listener: (...args: unknown[]) => void): void; removeListener(channel: string, listener: (...args: unknown[]) => void): void }): DesktopUpdateApi` implements fixed commands and validated state events.
- `DesktopApi.updates?: DesktopUpdateApi` is the renderer-facing entry point. `registerDesktopUpdateIpc(options: UpdateIpcOptions): () => void` returns an idempotent disposer.

- [ ] **Step 1: Add IPC tests first.** Assert only fixed operations register, invalid arguments fail, foreign/subframe/destroyed senders are rejected, opener errors are sanitized, and disposal removes only this handler/subscription.
- [ ] **Step 2: Run IPC tests and confirm failure.** Run `pnpm --filter @koed/desktop exec vitest run src/ipc/update.test.ts`; expected: tests fail because the IPC module does not exist.
- [ ] **Step 3: Add preload tests.** Assert exposed methods are frozen and limited to state/check/open; responses/events are schema-validated; unsubscribe removes the exact listener and late events are ignored.
- [ ] **Step 4: Run preload tests and confirm failure.** Run `pnpm --filter @koed/desktop exec vitest run src/ipc/update-preload.test.ts`; expected: tests fail because the preload module does not exist.
- [ ] **Step 5: Implement IPC and preload.** Add the API next to existing Home-stage preload APIs. In `main.ts`, create discovery from `app.isPackaged`, platform, architecture, argv, and `app.getVersion()` after `app.whenReady()`; register IPC before the Desktop window can issue requests; start the delayed metadata check only after registration; dispose the timer/request, subscription, and handler on the existing `before-quit` path without changing Koed Server shutdown ownership.
- [ ] **Step 6: Verify task.** Run both focused IPC/preload test commands and `pnpm --filter @koed/desktop typecheck`; expected: all tests pass and typecheck succeeds.
- [ ] **Step 7: Commit.** `git add apps/desktop/src/ipc/update.ts apps/desktop/src/ipc/update.test.ts apps/desktop/src/ipc/update-preload.ts apps/desktop/src/ipc/update-preload.test.ts apps/desktop/src/main.ts apps/desktop/src/preload.cts apps/desktop/src/types.ts && git commit -m "feat(desktop): expose secure update notice IPC"`.

### Task 3: Home-stage UI, packaged smoke, documentation, and release note

**Files:**

- Create: `apps/desktop/src/renderer/update/DesktopUpdate.tsx`
- Create: `apps/desktop/src/renderer/update/DesktopUpdate.test.tsx`
- Create: `apps/desktop/src/renderer/update/desktop-update.css`
- Create: `apps/desktop/src/renderer/update/use-desktop-update.ts`
- Modify: `apps/desktop/src/renderer/App.ipc-wiring.test.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/renderer/shell/AppShell.tsx`
- Modify: `apps/desktop/src/renderer/views/preferences/PreferencesView.tsx`
- Modify: `apps/desktop/README.md`
- Modify: `docs/running-koed.md`
- Create: `apps/desktop/scripts/desktop-update-notice-smoke.mjs`
- Create: `apps/desktop/scripts/desktop-update-notice-smoke.test.mjs`
- Modify: `apps/desktop/scripts/smoke-packaged-desktop-app.mjs`
- Modify: `apps/desktop/src/packaged-smoke-harness.ts`
- Modify: `apps/desktop/src/packaged-smoke-harness.test.ts`
- Modify: `apps/desktop/package.json`
- Create: `docs/desktop-updates.md`
- Create: `.changeset/desktop-update-notice.md`

**Interfaces:**

- `useDesktopUpdate(api?: DesktopUpdateApi)` returns `DesktopUpdateController` with `state`, `error`, `busy`, `check()`, and `open()`.
- `DesktopUpdateIndicator({ update, onOpen }: { update: DesktopUpdateController; onOpen: () => void })` renders only when a release is available.
- `DesktopUpdatePanel({ update }: { update: DesktopUpdateController })` renders the About panel and manual instructions.
- `AppShellProps.updateControl?: ReactNode` inserts the indicator into the existing main bar; `PreferencesViewProps.update?: DesktopUpdateController` supplies the panel to About.

- [ ] **Step 1: Add renderer tests first.** Assert installed/latest versions and plain-text notes render; no download/install/restart action exists; manual check/current/error states are truthful; stale snapshots/events cannot overwrite newer state; errors are sanitized and busy/listener state clears on unmount.
- [ ] **Step 2: Run renderer tests and confirm failure.** Run `pnpm --filter @koed/desktop exec vitest run src/renderer/update/DesktopUpdate.test.tsx`; expected: tests fail because the update UI module does not exist.
- [ ] **Step 3: Add packaged-smoke tests first.** Assert private packaged smoke proves the disabled/no-network notice state without requiring public feed access or updater authority.
- [ ] **Step 4: Run packaged-smoke test and confirm failure.** Run `node --test apps/desktop/scripts/desktop-update-notice-smoke.test.mjs`; expected: test fails because the smoke module does not exist.
- [ ] **Step 5: Implement the UI and adapt Home-stage integrations.** Add the indicator to the existing main bar through an `updateControl?: ReactNode` prop; put the Updates panel in the existing About section. Keep `__KOED_DESKTOP_VERSION__` as the About version fallback until the validated update state arrives. Do not replace `AppShell`, `App.tsx`, or `PreferencesView.tsx` from the old branch.
- [ ] **Step 6: Add isolated packaged-smoke wiring.** Add only the notice smoke test to existing Desktop smoke scripts/manifests; preserve all Home-stage test/build entries and avoid unrelated package-script changes.
- [ ] **Step 7: Add current manual-update docs and changeset.** Document the macOS arm64 notice, official release navigation, and manual safety procedure: pause AI Client/CLI activity, use the old installed Desktop CLI launcher for each home, require `koed stop --json` result `ok: true` and recheck `lifecycle.state: stopped`, preserve the home/configuration/models, and stop if ownership is unknown. State no-download/no-restart scope. Add concise links from `apps/desktop/README.md` and `docs/running-koed.md`. Add `.changeset/desktop-update-notice.md` with `"@koed/koed": minor` and a user-facing notice description.
- [ ] **Step 8: Verify task.** Run the focused renderer/smoke tests, `pnpm --filter @koed/desktop test:packaged-smoke`, `pnpm --filter @koed/desktop typecheck`, and `pnpm fmt:check`; expected: all pass.
- [ ] **Step 9: Commit.** Stage only the files listed for Task 3 and run `git commit -m "feat(desktop): add manual update notice UI"`.

### Final verification and branch publication

- [ ] Run `pnpm --filter @koed/desktop test`, `pnpm --filter @koed/desktop build`, `pnpm --filter @koed/shared build`, `pnpm typecheck`, `pnpm lint`, and `pnpm fmt:check`; record any environment-only limitations without treating them as passes. If workspace formatting still fails only on the pre-existing untracked `.superpowers/sdd/2026-11-03-peer-online-sync-slice/` files, run `pnpm exec prettier --check` on every changed Markdown/source path and report the workspace-wide limitation.
- [ ] Review `git diff --stat origin/claude/koed-home-stage...HEAD` and the complete file list; confirm there are no root/package version rewrites, release-stack files, updater/install code, or unrelated Home-stage deletions.
- [ ] Confirm the feature branch is based on the latest intended home-stage head, then publish with `git push -u origin feat/desktop-update-notice-home-stage`.

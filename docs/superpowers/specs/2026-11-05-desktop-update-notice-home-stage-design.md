# Desktop update notice on Home-stage

## Intent

Add the first-stage, notify-only Desktop update experience to the Home-stage branch so eligible Users can learn about a supported stable macOS release and follow Koed's safe manual-update process. The selected source is the final notice behavior from `a3b4a7d6d`, hardened by `a6d72101e` and latest-stable selection from `6c5f39f0e`.

## Goals

- Show an Update available indicator and Preferences → About → Updates for eligible packaged macOS arm64 Desktop builds.
- Fetch only official stable-release metadata with bounded, fail-closed checks; show the highest stable version and plain-text release notes.
- Offer Check for updates and View release, with a safe manual-update guide.
- Preserve the existing Home-stage Desktop lifecycle, current UI, version, packaging scripts, and all unrelated release behavior.
- Carry focused contract, discovery, IPC/preload, renderer, and packaged-smoke tests.

## Non-goals

- No binary download, updater dependency, installer, restart IPC, install-on-quit, or runtime lifecycle change.
- No import of the old release/distribution stack, package-version rewrites, or broad package-script changes from the 198-commit source branch.
- No claims that metadata or artifact digests prove native signature/notarization.

## Constraints

- Base the new branch on the current `origin/claude/koed-home-stage` head for PR #497; keep the original `feat/desktop-update-notice` and its remote unchanged.
- Adapt shared Home-stage files in place: Desktop main lifecycle, preload/types, renderer wiring, AppShell, and Preferences About. Do not replace those files wholesale.
- Add the shared update contract and its package export; preserve Home-stage package manifests and its `0.10.0` product version/build setup.
- Retain the notice feature's fixed operations, sender/frame/window checks, bounded official metadata requests, manual-only boundary, and tests.
- Add a minor changeset for `@koed/koed`, the public fixed-group package; `@koed/desktop` is ignored by the Changesets configuration.
- Keep `docs/desktop-updates.md` focused on behavior and operator-safe manual updates; omit stale release-stack ledger details unless they remain accurate on this base.

## Approaches considered

1. Rebase the entire pushed notice branch: rejected because it carries 198 commits and 45 merges of unrelated release work and produced extensive conflicts against Home-stage.
2. Cherry-pick the three notice commits: narrower, but their shared-file hunks target older main/preload/renderer layouts and package changes include unrelated version/build edits.
3. Manually adapt the final notice implementation and matching tests onto Home-stage: selected because it preserves current Home-stage behavior while limiting the diff to the notice feature.

## Validation

Run focused shared contract, Desktop discovery, IPC/preload, renderer, and packaged-smoke tests; run Desktop typecheck/build as feasible. Review the final diff against `origin/claude/koed-home-stage` to ensure no unrelated release stack or package/version changes were introduced. Record unavailable environment-dependent checks explicitly.

# Desktop Update Notices

## First release checkpoint: notice and manual update

Packaged macOS arm64 Desktop checks the official stable release metadata, shows a small **Update available** indicator and exposes **Preferences → About → Updates**. About displays the installed version supplied by Electron, latest eligible version and bounded plain-text release notes. **Check for updates** checks metadata; **View release** opens the official release page. The User downloads and installs outside Desktop.

There is no in-app binary download, download cache, updater dependency, install/restart IPC, runtime teardown or install-on-quit behavior. Closing Desktop retains existing ownership-aware lifecycle semantics. Automatic download and **Restart to update** belong to a separate, gated milestone in [proposed ADR 0058](adr/0058-desktop-background-updates-and-explicit-restart.md) and the [implementation plan](superpowers/plans/2026-10-26-desktop-update-milestones.md).

Checks are disabled in development, private packaged smoke, other platforms/architectures and builds without a strict stable product version. Unknown/disabled/offline states never mean “up to date.” No GitHub token or credentials are embedded or sent.

## Service ordering and security boundary

1. After Electron readiness, main creates notice discovery using `app.getVersion()` and packaged/platform eligibility. It registers a dedicated notice-only IPC handler before starting the delayed metadata check. Discovery does not depend on starting the Local AI Runtime or changing an active generation.
2. Main fetches only locally constructed `https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=N` URLs over HTTPS, at most 10 pages. Link headers are validated as pagination metadata, never used as request destinations. Redirects are refused; the entire scan, including streamed responses, has a 10-second deadline, 2 MiB per-page limit and 10 MiB combined response limit. A full page without a next Link triggers the next locally constructed page; malformed pagination or reaching the page limit fails closed. Initial check occurs after 5 seconds; normal interval is 6 hours with ±20% jitter. Failures back off from 5 minutes, multiplying by three up to 6 hours, with the same jitter. For HTTP 403/429, valid future Retry-After or X-RateLimit-Reset values delay manual and automatic checks. Finite representable deadlines are honored even beyond 6 hours, using bounded timers; unrepresentable numeric deadlines suppress checks for the rest of the session. Checks are single-flight and at least 60 seconds apart.
3. Discovery selects the highest numeric stable `vMAJOR.MINOR.PATCH` among non-draft, non-prerelease releases, independent of GitHub ordering. No stable release is an error, not an up-to-date result. The selected release must be published and have exact official release-page identity. If it is newer than the installed version, its assets must satisfy the contract below, without falling back to an older release; otherwise discovery reports current without checking artifact suitability. Notes are plain text, truncated to 4,000 characters; React never renders them as HTML or follows their links. Pagination is not an atomic snapshot: concurrent release changes can affect the scan.
4. A newer highest stable release must have uploaded, positive-size `Koed-<version>-arm64.dmg` and `koed-desktop-macos-arm64.sha256` assets, SHA-256 API digests, and exact version-bound official asset URLs. Duplicate/missing/malformed assets or the old `-unsigned.sha256` sidecar fail closed. No binary or checksum sidecar is fetched by notice discovery.
5. Renderer/preload use strict bounded state/request schemas and fixed `get_state`, `check`, `open_release` operations. Main verifies the live current Desktop window, main-frame identity and approved origin for every request; state events go only to that live authorized window. Renderer cannot supply a URL, path, headers, tag, process command or installer option. Main constructs the official release URL from a validated version.
6. Background failures have no modal/toast; About exposes check failure. Explicit action failures are sanitized. Snapshot/event races and unmounts cannot resurrect stale UI. On quit, notice timers, in-flight request, IPC registration and subscription are disposed independently of existing runtime shutdown.

The asset checks enforce distribution policy, not native signature/notarization verification. They rely on the existing protected signed-release publication gates; a filename/API digest is not proof of Apple signing identity. Before public release, validate the official manual path against genuinely signed/notarized supported artifacts and a clean supported Mac. Do not advertise an unsigned candidate as eligible by renaming its checksum sidecar.

## Safe manual update instructions

Use a supported signed macOS arm64 distribution at its existing supported installation location. Do not replace a running installation, reset Koed state, bypass Gatekeeper or downgrade an upgraded home.

1. In About, use **View release**. Confirm official `github.com/koed-labs/koed` release and matching stable version, choose its macOS arm64 DMG, and follow signed-install/checksum verification instructions. If the official release lacks a supported signed/manual path, stop.
2. Identify every known home using the installation being replaced. Pause AI Client and CLI activity that could start services; do not launch another CLI or Desktop during replacement. Quit Desktop. Merely closing a window is insufficient, and quitting Desktop intentionally leaves an adopted CLI runtime alive.
3. For each such home, use **its installed Desktop-owned CLI launcher for the old installation**, not an arbitrary source/npm CLI:

   ```bash
   koed status --json
   koed stop --json
   koed status --json
   ```

   Run `stop` only where a remaining runtime needs an explicit Operator stop. Require `stop` result `ok: true`. Inspect full final status JSON and require `lifecycle.state: "stopped"`; status exit code alone is not proof. Unknown ownership, a failed stop, remaining runtime or another process that can restart it blocks replacement.

   The launcher exports its configured `KOED_HOME` unconditionally. Prefixing another `KOED_HOME` does **not** select that other home. Use the correct launcher/configuration for each home. `koed runtime status` reports native dependency installation, not supervisor shutdown.

4. Replace the app at the same supported location, then reopen it. Verify installed version, runtime health, selected Base/Privacy profile and Personal Memory readability. Preserve Koed home, configuration, token references and models; no delete/reset/re-embedding step is part of an update.
5. If a launcher is absent, ownership cannot be verified, another home may still use the app or supported signing checks fail, do not guess or kill unrelated processes. Ask the Operator to resolve the blocker before replacement.

This manual procedure is not a global process inventory or durable replacement reservation. Automated runtime exclusion and one-click installation remain outside this checkpoint. Preserved files alone do not establish cross-version readability; public signed acceptance must cover that separately.

## Selective-port ledger

Initial foundation: #432 `1d492d3fe400e0d7d6bf568742f78f1308a7e0b3`; the branch also incorporates the subsequent pin-only stack through #432 `31c77c60afc52e8020a6689e39357a1f20d5571a`. Reference: #339 `055fab76571e6fa9afb77624c7c8b563b91c82bf`; #339 remains unchanged. New implementation is written against current foundation, informed by the useful #339 interface/test patterns below, not a merge of its old lifecycle or release code.

| Reference capability                                             | First-checkpoint disposition                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared update contract and version validation                    | Replaced with strict notice-only schema and stable numeric comparison; no old download/install states or permissive version regex.                    |
| Main-owned fixed IPC, preload cleanup and state subscriptions    | Adapted pattern; strengthened with current-window identity, exact requests, sanitized failure and initial-snapshot/event ordering tests.              |
| Coordinator scheduling/single-flight/disposal tests              | Reimplemented as metadata-only discovery with bounded network, backoff, artifact eligibility and no updater dependency.                               |
| Indicator, About surface, text notes and stale-response tests    | Selectively adapted to current shell/Preferences; one shared notice hook, installed Electron version, manual instructions and no Download/Restart UI. |
| Updater downloader, cache, native installer and quit coordinator | Deferred entirely to milestone 2. No normal download-consent step will be ported.                                                                     |
| Older main/manager lifecycle and workflow replacement            | Not ported. Current ownership, stopped-authority queue, signing, catalog and promotion code remain authoritative.                                     |
| Feed/artifact/native acceptance helpers                          | Deferred to milestone 2; notice eligibility tests cover current manual distribution policy only. No simulated signed/native acceptance claim.         |
| Old changeset/package metadata and obsolete tests                | Not copied. Current release conventions and current no-installer requirements govern new release notes/tests.                                         |

## Validation and public-release gates

Deterministic suites cover strict contract, metadata/asset validation, disabled platforms, request/body bounds, timeout, schedule/backoff, single-flight/cooldown, disposal, exact sender/frame/window checks, preload cleanup, plain-text UI, version/current/error behavior and stale-event protection. Registered packaged smoke inspects notice state and requires disabled/no-request state, preserving offline CI and no public feed traffic.

Live read-only inspection on 2026-10-26 confirmed unauthenticated HTTP 200 metadata and official page, latest tag `v0.8.1`, published stable status, and macOS arm64 DMG/ZIP with API digests. Latest release has only `koed-desktop-macos-arm64-unsigned.sha256`; it does **not** satisfy new manual-update eligibility. Source/installed development version is also `0.8.1`, so this inspection is not evidence of an available supported upgrade.

Local PR checkpoint and public release are distinct. Still required before public release:

- Retain the confirmed minor changeset; verify the release version under current fixed-group rules before publication.
- Publish through existing approved signed release gates; validate real supported official metadata/assets and signed manual instructions together.
- On supported clean Mac, verify official artifact/checksum, expected Apple identity, Gatekeeper/notarization, installed launcher/home binding, adopted-runtime stop, multiple-home limitations, replacement/reopen and readable preserved data/profile.
- Record actual final-head checks and packaged acceptance separately. No signing/cloud/publication authorization is implied by this document or local implementation.

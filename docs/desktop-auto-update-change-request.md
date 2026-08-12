---
title: Koed Desktop automatic updates
delivery_target: production
change_type: feature
repo_mode: brownfield
---

# Goal

Give an installed Koed Desktop application a secure, user-controlled update flow. The app should discover a newer release, show a visual in-app notification, download the update only after the User acts, and restart into the new version without losing Personal Memory, configuration, or bundled-local runtime state.

# Why

Desktop users should not need to monitor GitHub releases, download a replacement DMG, or reinstall Koed manually for every release. A dependable updater shortens the time between shipping a fix and users receiving it while preserving User control over when the app restarts.

# Current Situation

- Koed Desktop is packaged with Electron Builder for macOS arm64 as DMG and ZIP artifacts.
- Local and internal packaging creates ad-hoc-signed Desktop artifacts; public
  release automation requires Developer ID signing and notarization and
  publishes updater metadata and blockmaps to the stable R2 feed.
- The Desktop renderer obtains the running product version from Electron.
- The main process owns Koed Server and the PDS secret bridge lifecycle. Update installation must close both cleanly before Electron terminates.
- The Desktop update coordinator, typed update IPC contract, update UI, and
  deterministic two-version test are implemented.
- Production publication fails closed when Developer ID, Apple notarization, or
  R2 credentials are unavailable.

# Requested Change

## 1. Update coordinator

Add an Electron-main-process update coordinator using the stable `electron-updater` package that matches the existing Electron Builder toolchain.

The coordinator owns a typed state machine:

- `disabled`: development or unsupported package
- `idle`
- `checking`
- `available`
- `downloading`
- `ready`
- `installing`
- `error`

Automatic checks should occur shortly after packaged-app startup and periodically with per-install jitter. A manual check remains available from About. Network failures during background checks are silent and non-blocking.

Set automatic download and surprise installation off. A User action starts the download. Once the update is ready, the User explicitly chooses to restart and install it.

## 2. Narrow Desktop IPC

Expose only a typed, allowlisted update surface through preload:

- get current update state
- request a check
- start the approved download
- request restart and installation
- subscribe and unsubscribe from update-state changes
- obtain the running app version from Electron

Do not expose arbitrary URLs, filesystem paths, request headers, tokens, generic network access, or the updater object to the renderer. Validate IPC input and output at the main-process boundary.

## 3. Visual User experience

- Show a restrained `Update available` indicator in the existing Desktop shell. Do not send an operating-system notification.
- Clicking it opens a compact update surface with the installed version, available version, release-note summary, and primary action.
- Show determinate download progress when available without resizing or shifting the shell layout.
- When ready, use `Restart and update` as the explicit install action.
- Surface manual-check errors in the update surface; keep background-check failures unobtrusive.
- Replace the hard-coded Preferences version with Electron's packaged application version.

## 4. Graceful update installation

Before calling the updater installation/relaunch operation:

1. stop accepting new local runtime work;
2. stop Koed Server;
3. close the PDS secret bridge;
4. mark the quit as updater-driven so existing quit protection cannot recurse or cancel it;
5. invoke the updater installation and relaunch;
6. preserve `KOED_HOME`, configuration, Personal Memory, models, and bundled-local dependencies.

Handle Electron's updater-specific quit lifecycle explicitly rather than assuming the existing `before-quit` handler is sufficient.

## 5. Internal update feed and verification

The first implementation must provide a useful internal validation tier without
an Apple Developer membership:

- create updater metadata, ZIP artifacts, and blockmaps from one build;
- serve them from a deterministic local or internal HTTP feed;
- run an N-1 packaged test build;
- detect N;
- download N after User action;
- exercise the visual update flow and stop owned services before installation;
- validate artifact, manifest, feed, and shutdown behavior;
- fail closed when macOS refuses native replacement without an accepted signing
  identity.

Installing and relaunching N, reporting the new packaged version, and proving
post-update data readability belong to the credentialed macOS validation tier.
They require an Apple-issued Developer ID signing identity even when the
artifacts are distributed privately through GitHub or another internal feed.

Development mode must not contact a production update feed.

Internal unsigned/ad-hoc validation is a separate tier from public delivery.
Its local or internal feed is for controlled N-1-to-N testing only and must not
be promoted to the public channel.

## 6. Production release gate

Production distribution is a separate release-readiness gate and requires:

- Apple Developer membership and Developer ID Application signing;
- hardened-runtime signing of the app and bundled native executables;
- Apple notarization and stapling;
- release failure when signing credentials are absent;
- signature, Gatekeeper, and stapling validation on a clean Mac;
- an update feed that publishes the channel manifest only after the candidate passes installation validation.

Use a generic update feed at `updates.koed.ai` backed by Cloudflare R2 as the target scalable design. A public GitHub Release feed may be used temporarily for internal validation, but clients must not contain GitHub credentials.

The default channel is `stable`. Candidate artifacts must pass complete
manifest/ZIP/DMG/blockmap and installation validation before the channel
manifest is promoted atomically. A failed candidate is never published. A
withdrawal can protect Users who have not installed a bad release; Users who
already installed it require a higher corrective release. Beta and staged
rollout support may be added without changing the renderer IPC contract.

The first public updater-capable baseline is distinct from internal validation:
it requires Developer ID signing, hardened runtime, notarization, stapling, and
fail-closed release checks. Missing Apple credentials must fail the public
release path rather than silently falling back to ad-hoc signing.

# Constraints

- Initial platform scope is packaged macOS arm64 because it is the supported Desktop release surface today.
- Windows, Linux, and Intel macOS remain deferred until each has an explicit packaging, signing/trust, feed, and lifecycle design that preserves this coordinator and IPC contract.
- Preserve Electron Builder and the existing package layout.
- Do not implement a renderer-owned downloader or hand-roll artifact replacement.
- Do not update or delete Personal Memory, configuration, models, or bundled-local runtime state.
- Do not silently restart the application while the User is working.
- Release metadata and update artifacts must come from the same immutable build.
- Keep provider-specific credentials and private release endpoints outside the public repository.
- Server-side LLM synthesis remains out of scope.

# Acceptance Criteria

- A packaged N-1 test app discovers and downloads N from an internal HTTP update
  feed.
- No operating-system notification is emitted; the update is communicated visually inside Koed Desktop.
- The User can start the download and see useful status or progress.
- Installation occurs only after the User explicitly requests restart and update.
- Koed Server and the PDS secret bridge stop cleanly before installation.
- With an accepted Developer ID identity, the app installs and relaunches as N
  and reports its real packaged version.
- With an accepted Developer ID identity, existing `KOED_HOME` data and
  configuration remain usable after the update.
- Background network failures do not block app startup or normal operation.
- Development and unpackaged builds do not contact the production feed.
- Update IPC is narrow, typed, validated, and covered by tests.
- Release artifacts include the updater manifest and required blockmap alongside DMG and ZIP outputs.
- A documented production gate prevents unsigned or unnotarized public updater releases.
- An ADR records update trust, channel publication, graceful shutdown, and rollout decisions.
- Desktop, internal-artifact, release, and security documentation is updated.
- A minor changeset describes the User-visible Desktop update capability.

# Verification Expectations

- format: `pnpm fmt:prettier:check`
- lint: `pnpm lint`
- test: `pnpm --filter @koed/desktop test`
- typecheck: `pnpm --filter @koed/desktop typecheck`
- build: `pnpm --filter @koed/desktop build`
- package smoke: `pnpm desktop:package:smoke:mac`
- repository verification: `pnpm verify`
- updater E2E: credential-free discovery/download/shutdown proof, followed by
  Developer ID-backed N-1 to N install, relaunch, version, and data-preservation
  proof
- deterministic packaged N-1 to N proof: `pnpm desktop:update:e2e` builds isolated internal artifacts, serves the validated N feed on loopback, drives the packaged update IPC surface, and writes fresh evidence under the operating system temporary directory by default; the workflow fails closed with the exact installer error when macOS trust/signing prevents relaunch
- operational evidence: invalid IPC input rejection, background-failure non-blocking behavior, artifact coherence, failed-candidate non-publication, and atomic manifest promotion/corrective-release behavior

# Risks Or Known Unknowns

- The present ad-hoc-signed release cannot be treated as the production updater baseline. Existing testers may need one final manual migration install to the first Developer ID-signed updater-capable release.
- Bundled native executables may reveal additional signing or notarization requirements.
- Desktop artifacts are large. Differential downloads require publishing blockmaps and measuring real N-1 to N transfer size.
- A bad channel manifest can affect every eligible installation. Candidate validation and atomic manifest promotion are mandatory.
- Withdrawals only protect Users who have not installed a bad release; installed clients require a higher corrective version.

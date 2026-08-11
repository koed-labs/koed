# ADR 0025: Desktop Updates Are Main-Owned, User-Controlled, And Trust-Gated

- Status: Accepted design
- Date: 2026-08-09
- Related intent: [Koed Desktop automatic updates](../desktop-auto-update-change-request.md)

## Context

Koed Desktop is packaged with Electron Builder for macOS arm64. The current
release workflow produces internal/ad-hoc-signed DMG and ZIP artifacts, but it
does not publish updater metadata or provide an update coordinator. The main
process already owns the Koed Server and PDS secret bridge lifecycle. The
renderer is an untrusted UI surface and must not receive release credentials,
arbitrary network access, or authority to replace the application bundle.

An updater must therefore preserve two boundaries at once:

1. application updates replace the packaged Desktop bundle only; they must not
   migrate or rewrite `KOED_HOME`, Personal Memory, configuration, models, or
   bundled-local dependencies; and
2. internal unsigned validation is useful before Apple credentials exist, but it
   is not evidence that a public updater release is trusted.

## Decision

### Main-process coordinator and narrow IPC

Use the stable `electron-updater` package with the existing Electron Builder
toolchain. Do not implement a renderer downloader or hand-roll artifact
replacement. Electron main owns the updater instance, feed configuration,
state transitions, scheduling, download, and installation.

The coordinator exposes a typed state machine with these states:

- `disabled` for development, unpackaged, or unsupported builds;
- `idle`, `checking`, `available`, `downloading`, `ready`, `installing`, and
  `error` for packaged builds.

The preload bridge exposes only validated, allowlisted operations: read current
state, request a check, start a User-approved download, request restart and
install, subscribe/unsubscribe to state changes, and read Electron's running
application version. The renderer receives state and display-safe release
metadata only. It never receives updater objects, URLs, paths, headers,
credentials, tokens, or generic network/filesystem access. Main-process input
and output validation is mandatory.

Automatic checks run only for packaged supported builds, once after a short
startup delay and then on a jittered periodic schedule. A manual check remains
available from About/Preferences. Background-check failures are recorded as
non-blocking diagnostics and do not delay startup or normal operation; a
manual-check failure is shown in the in-app update surface.

### User-controlled visual experience

The only notification is a restrained in-app visual indicator and update
surface. The updater must set automatic download and surprise installation off.
The User starts downloading from the update surface, can see useful status or
determinate progress, and must explicitly choose `Restart and update` after the
artifact is ready. Koed must never silently restart while the User is working
and must not emit an operating-system notification for this feature.

The displayed version comes from Electron's packaged application version, not a
hard-coded renderer constant. Release-note text is treated as untrusted
display data and remains bounded by the typed contract.

### Graceful updater-driven shutdown

Before invoking updater installation and relaunch, main performs the same
owned-service shutdown in a defined order:

1. stop accepting new local runtime work;
2. stop Koed Server;
3. close the PDS secret bridge;
4. set an updater-driven quit guard before triggering Electron's install/relaunch;
5. invoke the updater installation and relaunch operation.

The guard is consumed by the existing quit lifecycle so the `before-quit`
handler cannot recurse, cancel the install, or run the normal shutdown path a
second time. A failed preparation or installation leaves the current app
running and reports an actionable error. No update operation changes memory
ownership, database schema, capture/retrieval behavior, or the AI-client-only
answer/LCM synthesis boundary.

### Immutable artifacts and channel publication

One immutable build version is the source for the updater manifest, ZIP, DMG,
and blockmaps. A manifest must never point at artifacts from another build.
The default channel is `stable`; the coordinator's typed contract must leave
room for future `beta` and staged-rollout selection without changing renderer
IPC.

The scalable target feed is `https://updates.koed.ai`, backed by Cloudflare R2.
Provider credentials and private release endpoints stay in CI/operator secret
configuration and are never embedded in the application or committed to the
repository. A temporary GitHub Release or deterministic local HTTP feed may be
used for internal validation only.

Publication is an atomic promotion sequence: build and sign candidate outputs,
validate the complete manifest/ZIP/DMG/blockmap set and N-1 installation, then
promote the channel manifest as one operation. If validation fails, the
manifest is not promoted. A withdrawal can protect clients that have not yet
installed a bad version; clients that already installed it require a higher
corrective release. Rollback therefore means atomic manifest correction or
withdrawal, never destructive mutation of an installed User's `KOED_HOME`.

### Trust gates: internal validation versus public delivery

Internal updater validation is explicitly a separate tier. Before Apple
credentials exist, an ad-hoc-signed or otherwise unsigned macOS arm64 build
may run on controlled test machines from a local/internal feed to prove N-1
discovery of N, User-controlled download, the visual update flow, artifact/feed
integrity, and graceful service shutdown. Native macOS replacement and relaunch
must fail closed without an Apple-issued Developer ID signing identity. Such
artifacts must be labelled internal and must not be promoted to the public
channel.

The first public updater-capable baseline is fail-closed and requires:

- Apple Developer ID Application signing for the app and bundled native
  executables, with hardened runtime;
- notarization and stapling;
- signature, Gatekeeper, and stapling verification on a clean Mac;
- release failure when required signing or notarization credentials are absent;
- candidate installation validation before atomic channel-manifest promotion.

The existing internal/ad-hoc release path remains useful for controlled
validation but cannot satisfy this public gate. Existing testers may need one
manual migration install to the first signed/notarized updater baseline.

### Platform posture and deferred work

Initial scope is packaged macOS arm64, matching today's supported Desktop
release surface. Windows, Linux, Intel macOS, and broader platform feeds are
deferred until each platform has an explicit packaging, signing/trust, feed,
and lifecycle design. Adding those platforms must preserve the main-process
ownership and typed IPC contract.

Product implementation, release workflow changes, feed provisioning, and
platform expansion are downstream tasks. This ADR freezes their contract; it
does not claim those tasks are complete.

## Required downstream evidence

Implementation and release tasks must provide concrete evidence for:

- typed IPC allowlisting and validation, including invalid-input rejection;
- packaged-only scheduling, startup delay, jitter, manual checks, and silent
  background failures;
- visual-only notification, User-started download, progress, and explicit
  restart/install;
- updater-driven Koed Server and PDS bridge shutdown without quit recursion;
- N-1 to N internal-feed discovery, download, install, relaunch, real version,
  and `KOED_HOME`/Personal Memory/configuration/model readability;
- one-build manifest, ZIP, DMG, and blockmap coherence;
- atomic channel promotion, failed-candidate non-publication, and
  rollback/corrective-release behavior;
- public signing, notarization, stapling, Gatekeeper, and fail-closed release
  checks once Apple credentials are available.

## Consequences

- The renderer remains a presentation and User-intent surface rather than a
  privileged update agent.
- Internal discovery, download, UI, feed, and shutdown testing can proceed
  before Apple enrollment without weakening the public trust model; native
  replacement and relaunch remain credentialed tests.
- Feed publication becomes an operationally controlled release step with an
  explicit blast-radius and correction strategy.
- Update installation is application replacement only; runtime and Personal
  Memory state remain under the existing Koed lifecycle and storage contracts.

## Non-goals

- Server-side LLM synthesis or any change to the AI-client synthesis boundary.
- Silent download, silent restart, operating-system notifications, renderer-owned
  artifact downloads, or arbitrary renderer network access.
- Public updater delivery from unsigned/ad-hoc artifacts.
- Automatic migration, deletion, or relocation of `KOED_HOME`, Personal Memory,
  configuration, models, or bundled-local dependencies.

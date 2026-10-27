# ADR 0058: Desktop Background Updates and Explicit Restart

## Status

Proposed for review. No implementation or publication authorization.

Replaces the User-initiated-download direction in #339's proposed updater design. Does not amend existing ADR 0025, which concerns MCP v2 and Local AI Runtime ownership.

Related: [0057 Versioned Component Manifest Pins](0057-versioned-component-manifest-pins.md), [implementation plan](../superpowers/plans/2026-10-26-desktop-update-milestones.md).

## Context

Desktop update support will be built on the current #432 runtime lifecycle and trusted release foundation. #339 contains useful updater code and tests, but its older lifecycle, packaging and workflow assumptions must not replace that foundation.

Two public milestones are useful:

1. Inform Users that a newer release exists and explain manual updating.
2. Download updates automatically in the background and require only an explicit **Restart to update** action for normal installation.

The earlier requirement for a User to start the download is superseded. A separate download-only public milestone is not planned.

Replacing an app is not equivalent to quitting its window. A CLI-started runtime may remain active and depend on app resources. Signing, final-byte artifact verification, component catalog trust and data compatibility remain independent release requirements.

## Decision

### 1. Notice-only milestone

A packaged supported Desktop build checks trusted stable release metadata in main. The UI shows an unobtrusive update indicator, installed/new version, a bounded release summary and **View release**.

The action opens an approved HTTPS release page through a main-owned, validated operation. Renderer input cannot choose arbitrary URLs. Instructions explain downloading the official installer, stopping runtimes that depend on the app, replacing the app and reopening it.

This milestone performs no in-app binary download, installation, restart or runtime teardown. Development builds do not contact the production update source. It can ship using the existing official release channel; it does not require completing the automatic-install feed first.

### 2. Automatic background download milestone

Normal flow is:

**Background check → automatic download and verification → Ready → Restart to update → install → relaunch on the new version.**

- No download confirmation, Download button or ordinary path requiring a second consent.
- For the full updater, `autoDownload = true` and `autoInstallOnAppQuit = false`.
- No automatic restart, installation on ordinary quit, or installation at next launch merely because a payload was cached.
- Main owns scheduling, download, verification, cache lifecycle, native installation and the update source. Use Electron Builder/electron-updater for supported native replacement rather than a custom installer.
- Initial native auto-update support is packaged macOS arm64. Do not narrow existing runtime platform support or imply unsupported updater platforms are supported.
- Cache reuse or interrupted downloads do not bypass version, identity or integrity checks. Repeated failure uses bounded backoff; no tight retry loops or unbounded disk growth.
- Background failures stay non-blocking and quiet; update UI can explain unavailable readiness. Manual checks may show actionable errors. No OS notification is required.
- Before Ready, UI may show checking/downloading progress without requesting action. Ready exposes **Restart to update**. Ready does not override a later runtime or installation blocker; revalidate immediately before installation.

If electron-updater cannot separate pre-consent download from privileged replacement sufficiently on a supported installation, resolve that limitation before enabling this milestone. Do not silently add a download confirmation or weaken native security requirements.

### 3. Explicit restart is scoped installation consent

The click authorizes preparing and replacing this Desktop installation, then relaunching it. It does not grant arbitrary process-stop authority, permission to bypass signature checks, or permission to discard Personal Memory.

Ordinary quit retains current ownership-aware shutdown/detach behavior. Explicit Operator stop remains distinct. An adopted CLI runtime is not implicitly stopped by the updater. If it still uses the app's resources, installation is deferred with an explanation; User/Operator must resolve that exceptional blocker through existing controls.

The one-click promise applies to the normal eligible installation path, not to bypassing safety blockers. No routine extra Download, confirmation, quit or launch action is required. An exceptional OS authorization or unsupported installation context must be identified during validation and represented honestly, not described as a guaranteed one-click flow.

Preparation must exclude concurrent runtime startup throughout replacement, including supported other homes and launch contexts. A one-time PID check or a lock released when the GUI exits is insufficient. Unknown ownership, retained pins, cleanup failure or unresolved process identity denies installation. A cleanup promise resolving `ok:false` is failure.

### 4. Preserve trust and active runtime behavior

Preserve the current component-assets → complete exact-version manifest catalog → trusted standalone/Desktop packaging order, required catalog identities, external control-plane boundary and packaged verification. An updater must not turn a staged component into installer authority.

Only a verified release from the approved update source is eligible. Validate final signed/notarized/stapled bytes, version, architecture and expected Apple identity; feed hashes must describe those final bytes. No feed edits inside an already signed app and no unsigned fallback for public delivery.

App replacement must not delete or downgrade `KOED_HOME`, Personal Memory, configuration, token references, models or runtime dependencies. New-version startup/data compatibility is a separate acceptance obligation, not a consequence of preserving files.

The upgrade must preserve the active supported Base/Privacy profile without silent fallback. A compatible runtime path must be proven for the ordinary one-click flow. If required runtime preparation introduces another normal User confirmation, the milestone is incomplete: resolve that design explicitly before release. Do not bypass existing component trust or run downloaded candidate code merely to avoid a prompt.

### 5. Release and publication authority remain separate

Use immutable versioned candidate assets. Matching bytes may be reused; the same version with different bytes is rejected. Verify complete remote bytes and evidence before changing a stable channel. Competing publishers must not race a partially validated candidate into production.

Native acceptance uses genuine signed N−1 and N artifacts, matching control planes/catalogs/components and actual relaunch/version proof. Same-source version simulation is useful testing, not historical upgrade acceptance. Gatekeeper bypass is not signed acceptance.

Public promotion, signing credentials, cloud writes, production enablement and closing/replacing #339 require their own authorization. The plan and this proposed ADR authorize none of those actions.

## Alternatives Considered

- **User starts download, then restarts:** rejected for the full milestone; it adds the extra interaction the User explicitly does not want.
- **Download-only public release:** rejected as the planned intermediate milestone; a managed updater cache is not a complete manual-install experience. Notice/manual instructions are independently useful.
- **Install on ordinary quit or restart without consent:** rejected; restart and replacement need the explicit action.
- **Merge #339 wholesale:** rejected; stale lifecycle and release assumptions create unnecessary conflict and regression risk. Port selected capabilities onto the current foundation.
- **Stop any detected runtime automatically:** rejected; observation does not confer ownership or destructive authority.

## Consequences

The first milestone can be smaller and publicly useful without exposing an unfinished installer. The second has a simple User experience but requires complete lifecycle, signing, publication and native acceptance work behind the button.

Automatic download consumes bandwidth and disk without per-download consent. It is intentional default behavior for the full milestone; bound retries/cache usage and document it. Metered-network policy or an updater preference is not specified here and must not be invented as an implicit extra requirement.

Runtime blockers may defer an update even when bytes are downloaded. Multi-home/system-installation coordination and interrupted-installer recovery require an approved implementation design; unsupported or ambiguous cases remain blocked rather than being advertised as supported.

The first updater-capable release may require manual installation. Neither this decision nor a staged feed proves already installed ad-hoc builds can update themselves securely.

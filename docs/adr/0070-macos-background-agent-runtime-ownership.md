# ADR 0070: macOS Background Agent Owns the Local AI Runtime

Status: Accepted. LaunchAgent inclusion requires a valid Developer ID signing configuration.

Related decisions:

- [0001 AI Client Synthesis Only](0001-ai-client-synthesis-only.md)
- [0068 Linux AppImage Candidate Verification Uses Trusted-Build Evidence](0068-linux-appimage-trusted-build-evidence.md)

## Context

Desktop can keep Koed available after its window closes, but a full Desktop quit
currently shuts down its tray and managed runtime. The macOS Background Agent
must therefore be a separate per-user process. Transferring a live supervisor
from Desktop would create ambiguous ownership, and existing manager paths can
fall back to CLI start/stop when no supervisor is attached. The Agent also
needs to preserve a custom `KOED_HOME`, which launchd does not inherit from the
shell that launched Desktop.

macOS terminates a running LaunchAgent when it is unregistered. Disable and
Quit must first persist a Stop request, stop the runtime, verify that it has
stopped, and only then unregister the service.

## Decision

- Use a separate Electron process launched as a per-user `SMAppService`
  LaunchAgent. It has an isolated Electron `userData` directory and singleton
  lock, its own menu-bar controls, and the sole ownership of its local runtime
  from startup. Desktop never transfers a live supervisor.
- Include the LaunchAgent property list in non-ad-hoc macOS builds configured
  with a valid Team ID. The after-sign hook verifies the signed app and unpacked
  native XPC addon share that Team ID. Ad-hoc and unpackaged builds cannot
  register the service.
- Expose a strict, versioned XPC control surface. Authenticate both peers by
  signed Team ID and bundle identifier; require Hello and installation identity
  before lifecycle mutations. Fence requests by persisted generation.
- Persist the installation UUID, canonical bundle path, `KOED_HOME`, generation,
  and durable Stop intent in private, owner-only state. Persist the selected
  `KOED_HOME` separately in Desktop `userData`, because launchd does not inherit
  the Desktop process environment.
- Inject an optional central lifecycle adapter into the Desktop server manager.
  When the Agent owns the runtime, start, stop, resume, and internal workflows
  route through XPC; Desktop shutdown detaches. An unavailable or mismatched
  Agent fails closed and must never trigger CLI fallback. The Agent's manager
  remains local and has no remote adapter.
- Stop is durable across Agent restarts; only explicit Start clears it. Disable
  and Quit verify Stop before unregistering. A LaunchAgent awaiting System
  Settings approval is not running and may be unregistered without XPC Stop.

## Consequences

- The Local AI Runtime and menu-bar controls can outlive the Desktop process
  while retaining a single, explicit runtime owner.
- Background Agent availability depends on code signing, notarization, native
  addon packaging, launchd/XPC identity, and release qualification. Packaging
  includes the LaunchAgent for builds with a valid Team ID and non-ad-hoc
  signing; the after-sign hook verifies app and addon signatures. Notarization,
  install, approval, reboot, Stop, restart, and unregister behavior still need
  qualification on supported macOS versions before release.
- Moving or duplicating an enabled app, corrupting bound state, or losing the
  authenticated XPC connection can require operator recovery. The system
  deliberately does not guess ownership or fall back to another runtime owner.
- Launch Koed at startup remains a separate Desktop preference; it does not
  grant the Background Agent permission or change runtime ownership.

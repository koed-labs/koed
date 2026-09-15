# Implementation backlog

## Joining-device-first Personal Device pairing

Implemented on 2026-09-14:

- Joining headless and Electron installations create a short-lived device request.
- The existing Authority-hosting Electron installation reviews and explicitly
  accepts that request, using the existing signed enrollment protocol.
- `pnpm koed-server pair` starts the native Personal runtime with automatic ports
  and credentials. CLI and Electron share supervisor-owned request state.
- Setup no longer requires a recovery JSON export or a recovery code. Advanced
  optional recovery export remains available through the CLI.
- Joined devices publish their own closed sessions without an Authority private
  key. User authentication and secure membership context remain required.
- Request transport is private LAN/Tailscale only. The existing Authority relay
  listener remains in Electron; the joining request listener lives in koed-server.

Validation and current operation are documented in `docs/device-pairing.md`.

Deferred work:

- Internet-accessible relay and restricted-network traversal.
- Approval from joined replicas that do not host the Authority.
- Moving the existing Authority relay listener into the supervisor.

## Personal Device session visibility and automatic publication

Implemented, following ADR-0045:

- Signed cumulative checkpoints preserve V1 permanent closure semantics.
- Durable Pi, Codex, and Claude Code completion evidence triggers publication.
- Ordered, deduplicated checkpoints extend one read-only received Session.
- Pairing and local replication progress are reported separately.

Remaining validation: physical Studio-to-Electron capture, later-turn updates,
and offline catch-up on the updated runtime.

Implemented: received-session badges use verified replica provenance and the
installation-local nickname; device icons no longer guess hardware by row order.

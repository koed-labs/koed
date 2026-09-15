# Personal Collaboration Sync And Cross-Platform Secret Providers

Status: Accepted for Personal collaboration; its PDS secure-provider
section is superseded by [ADR 0044](./0044-application-managed-pds-secret-storage.md).
Personal Notes are superseded by [ADR 0032](./0032-first-class-revisioned-personal-notes.md).

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](./0013-team-collaboration-authority.md)
- [0014 Hosted Personal Source Replication](./0014-hosted-personal-source-replication.md)
- [0044 Application-Managed PDS Secret Storage](./0044-application-managed-pds-secret-storage.md)

## Context

Personal channels currently live only in the local collaboration store. A User
therefore sees different Personal conversations on
two devices. Personal Device Sync cannot solve mutable collaboration replication:
its V1 contract transports immutable, closed Captured Session source packages
and compatible derived artifacts, not mutable notes or channel event streams.

Desktop PDS needs a cross-platform secure provider that can bootstrap, enroll,
refresh, and revoke without putting private material into renderer state or
ordinary configuration. Its `koed-server` child cannot directly access an
Electron-main-process closure.

## Decision

### Personal collaboration

When a User has enrolled a local edge with a remote Koed backend, that backend
is the authority for the User's Personal collaboration data: Personal channels,
messages, and their durable collaboration event stream. Personal Notes use the
separate first-class revision contract in ADR 0032.
Local edges keep encrypted durable pending sends for messages. Channel and
thread lifecycle mutations require the remote authority to be reachable and
fail closed without creating speculative local state. Each local edge persists
only its opaque subscription cursor and binding; it rebuilds the renderer view
from an authorized snapshot plus cursor replay after reconnect. Realtime is a
wake mechanism only; snapshots and cursor replay are the correctness path.

This is separate from Team collaboration. Personal collaboration never becomes
a synthetic Team, does not create Team Membership, and is visible only to the
owning authenticated User and that User's enrolled devices.

### Captured-session source replication

PDS carries encrypted immutable closed Captured Session sources and separately
signed compatible derived artifacts. It does not carry mutable Personal
collaboration records. Source replication, materialization, portable artifact
reuse, fallback derivation, and Recall continue to follow the PDS V1 protocol
independently from Personal collaboration replication.

### Secure secret providers

PDS secret custody is superseded by
[ADR 0044](./0044-application-managed-pds-secret-storage.md). The historical
platform-provider bridge and OS credential-store split described here are not
used by current PDS runtime storage. Personal collaboration authority remains
separate from PDS source replication and follows the decisions above.

## Consequences

- A remote-backed Personal channel written on Device B becomes visible on
  Device A through normal durable collaboration synchronization.
- Offline Personal messages retain their original remote authority binding and
  reconcile idempotently after reconnect. They are rejected if the backend,
  principal, device lineage, credential scope, or route policy changes.
- Offline Personal channel and lifecycle mutations are not accepted until their
  remote authority is reachable.
- A local-only Koed installation remains fully usable, but its Personal
  channels are local-only until the User explicitly connects a backend.
- PDS setup is available only where the application-managed store is genuinely
  usable. Unsafe filesystem state is an explicit readiness failure, not a
  degraded security mode.
- The implementation needs negative tests for cross-user access, stale or
  replayed events, revoked device credentials, unauthorized provider requests,
  plaintext storage, unsafe directories/files, malformed envelopes, and
  concurrent secret mutations.

# Personal Collaboration Sync And Cross-Platform Secret Providers

Status: Accepted.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](./0013-team-collaboration-authority.md)
- [0014 Hosted Personal Source Replication](./0014-hosted-personal-source-replication.md)

## Context

Personal notes-to-self and Personal channels currently live only in the local
collaboration store. A User therefore sees different Personal conversations on
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
is the authority for the User's Personal collaboration data: notes-to-self,
Personal channels, messages, and their durable collaboration event stream.
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

Desktop must expose one authenticated local-only secret-provider bridge to its
direct `koed-server` and Worker children. The bridge supports bounded `put`,
`get`, and `delete` operations by opaque reference; renderer IPC, ordinary
configuration, logs, and status never receive secret values. A per-launch
bridge capability is child-process configuration, not PDS material; it is never
exposed to renderer IPC or persisted state.

The bridge uses platform-backed storage only:

- macOS: Keychain through Electron `safeStorage`.
- Windows: DPAPI through Electron `safeStorage`.
- Linux: Secret Service/libsecret or KWallet through Electron `safeStorage`.
- WSL: Windows-host DPAPI through a narrowly scoped native helper when the
  Windows host is available.

Electron's `basic_text` backend, unavailable secure storage, unsafe store
paths, and unsupported platform backends fail closed. WSL uses a real Linux
secret service when one is available and otherwise uses the Windows-host DPAPI
provider. The helper is compiled from the source shipped with Koed using the
Windows framework compiler, accepts only bounded `get`, `put`, and `delete`
operations, and stores only DPAPI ciphertext. It must not silently store PDS
material in a plaintext file or environment variable. A Linux desktop without
a supported native keyring is a PDS-unavailable state, not an instruction to
install arbitrary secret tooling.

The local bridge has a per-launch random capability, private socket/pipe
endpoint, bounded framed requests, reference validation, and strict process
lifetime. Its capability is supplied only to the direct child invocation. When
Electron is the provider executable, Koed explicitly starts the provider script
in Electron's Node mode rather than relying on ambient child-process state.

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
- PDS setup is available only where a platform secure provider is genuinely
  usable. This is an explicit readiness state, not a degraded security mode.
- The implementation needs negative tests for cross-user access, stale or
  replayed events, revoked device credentials, unauthenticated secret-bridge
  requests, plaintext storage, unsafe bridge directories, insecure Linux
  backends, and concurrent secret mutations.

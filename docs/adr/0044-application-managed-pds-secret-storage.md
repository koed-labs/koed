# Application-Managed Personal Device Sync Secret Storage

Status: Accepted.

Supersedes the secure-provider portion of
[ADR 0018](./0018-personal-collaboration-and-cross-platform-secret-providers.md).

## Context

PDS previously split secret custody by runtime. Electron used an authenticated
main-process bridge backed by platform secure storage, while standalone
`koed-server` used `keytar`. Keychain, Secret Service, D-Bus, DPAPI, and
interactive-session requirements made SSH-only enrollment unreliable and gave
Desktop and headless installations different storage behavior.

PDS needs one local trust model for Desktop, API, Worker, and standalone CLI.
The Operator's account/filesystem boundary is the accepted alpha threat model;
same-user and root access remain trusted.

## Decision

PDS runtime and Authority secrets use one Koed-owned application-managed store
under `KOED_HOME/secrets`:

- `pds-secrets.json` contains versioned AES-256-GCM envelopes keyed by bounded
  opaque references. Each envelope authenticates its reference as AAD, so
  ciphertext cannot be transplanted between entries.
- `pds-secret-store.key` contains the local store key and is never placed in
  ordinary configuration or process arguments.

Koed creates the store directory with mode `0700` and files with mode `0600`.
Mutations use bounded values, owner-only temporary files, fsync, atomic rename,
and an inter-process lock that checks live PID/start identity before stale
recovery. Symlinks, unsafe ownership/permissions, malformed state, missing
keys, and oversized values fail closed. Native Windows ACL validation is not
part of this build; use WSL for Windows-hosted local runtime work. Desktop and headless processes
use the same paths and contract. PDS does not require Electron, `safeStorage`,
Keychain, Credential Manager, Secret Service/KWallet, D-Bus, WSL DPAPI, or an
interactive session.

The bundled provider command receives only `KOED_HOME`, an operation, and an
opaque reference. Secret values travel only over bounded stdin/stdout inside
that local process boundary. An explicitly configured Operator-managed provider
may replace the bundled command for special deployments, but it must preserve
this boundary.

Existing Electron OS-store state and branch-created `keytar` entries are not
migrated or silently deleted. A fresh `KOED_HOME` and device re-enrollment are
valid alpha reset paths. Legacy state remains outside the new store until an
explicit cleanup operation exists.

## Consequences

- SSH-only pairing works without an unlocked OS credential store.
- Desktop and headless PDS behavior is consistent across platforms.
- Local filesystem permissions and account isolation become primary custody
  controls.
- Changing or losing `KOED_HOME` requires explicit PDS re-enrollment.
- Same-user, root, and compromised local-process access remain in scope of the
  trusted local deployment boundary.

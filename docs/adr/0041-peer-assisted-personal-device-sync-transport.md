# Peer-Assisted Personal Device Sync Transport

Status: Accepted.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0019 Same-Network Personal Device Enrollment](./0019-same-network-personal-device-enrollment.md)
- [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md)

## Context

Personal Device Sync already defines signed membership, source-owned immutable
packages, encrypted recipient envelopes, idempotent materialization, conflict
quarantine, lifecycle controls, anti-entropy cursors, and a durable opaque
relay. Routing every package byte through that relay is unnecessary when all
intended recipient devices are simultaneously reachable on the same network.

A direct path must not create mesh authority, a second package format, a new
conflict model, or best-effort delivery that can be mistaken for durable sync.
It must also preserve offline delivery and convergence when routes disappear or
only some recipients can be reached.

## Decision

Koed adds an optional peer-assisted PDS data path. The Authority/Relay remains
the membership and lifecycle authority, route-discovery service, durable
mailbox, anti-entropy authority, and fallback. Peer transfer changes only where
the encrypted package bytes travel.

Each enrolled Desktop may publish a short-lived private-network `/pds` endpoint
through a signed relay request. The relay stores the canonical advertisement
and proof, rejects stale replacement, filters expired or revoked devices, and
returns routes only to authenticated members of the same Personal Device Group.
Recipients independently verify the advertisement, proof, active membership
certificate, current authority head, and epoch.

A sender uses direct delivery only when every intended recipient other than
itself has a valid route. It sends the unchanged signed encrypted package and
requires a normal recipient-signed materialization acknowledgement from every
recipient. The acknowledgement is verified against the package identity and
current membership certificate. Any failure falls back to normal relay upload.
The recipient advances the durable relay cursor after direct materialization;
duplicate relay delivery remains idempotent.

Desktop publishes its current endpoint through an atomic owner-only runtime
record under `KOED_HOME/run`. The Worker reads that non-secret record on each
route refresh, so listener changes do not require service restart. Headless
operators may provide the same endpoint explicitly. No device credential,
membership secret, or authority key is written to that record.

## Consequences

- Same-network devices avoid relay byte transfer when all recipients are
  reachable and acknowledge materialization.
- The relay remains necessary for enrollment, governance, discovery,
  anti-entropy, offline recipients, and any failed or partial direct attempt.
- Direct and relay delivery have identical package identity, authorization,
  validation, conflict, revocation, and idempotency semantics.
- Route metadata reveals a current private endpoint to other authenticated
  devices in the same Personal Device Group. It expires quickly and is not
  available through browser sessions or API Tokens.
- Direct delivery is all-recipient or relay-fallback. Koed does not treat a
  partial direct transfer as durable completion.
- NAT traversal, mDNS, public peer endpoints, WebRTC, Bluetooth discovery, and
  Authority transfer are separate decisions.

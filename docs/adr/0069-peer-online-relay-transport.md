# Peer-Online Relay Transport

Status: Proposed. This decision selects how the peer-online profile may reach
peers that are online together but cannot connect directly. It does not mean a
relay transport is implemented, reviewed or available.

Related decisions:

- [0066 Peer-Online Personal Device Sync and Group Governance](./0066-peer-online-personal-device-sync.md)
- [0068 Peer-Online Deletion Completion](./0068-peer-online-deletion-completion.md)
- [0041 Peer-Assisted Personal Device Sync Transport](./0041-peer-assisted-personal-device-sync-transport.md)
- [Peer-online sync protocol](../peer-online-sync-protocol.md)

## Context

ADR 0066 separates the synchronization contract from connection establishment.
It validates local and Tailscale connectivity first, and names relay v2 as the
intended starting point for a later internet transport, subject to security and
lifecycle validation. The relay may forward a protected connection but must not
store Memory for later delivery; the profile has no durable mailbox.

Peer-online connections already have an end-to-end security boundary that does
not depend on the network path. Both peers run TLS 1.3 with transport keys
pinned by active signed membership, and the peer-online authentication exchange
binds both device identities, both transport pins, the group, profile, version
and fresh nonces to a TLS exporter value. A network path that carries those TLS
bytes unchanged cannot impersonate a member or read records without a member's
transport private key.

The relay v2 prototype (`prototype/pds-relay-v2-protected`) runs the published
Paseo relay (`@getpaseo/relay@0.14.0`, as a Cloudflare Durable Object adapter or
the upstream Elixir image). The relay rendezvouses a registered server control
socket with per-client data sockets. Its optional protected mode adds a Noise IK
channel in which the client pins the server's static key. The prototype found
that protected mode:

- authenticates only the server key, not the connecting client;
- provides no Koed authorization, durable delivery or production key
  distribution;
- leaves connection metadata visible to the relay; and
- relies on an upstream handshake path that can construct a channel after the
  handshake was rejected, which the prototype can hide but not cancel.

The prototype did not test binary messages, persistence or production
operations.

The existing PDS V1 Authority/Relay is a different component with governance,
discovery and mailbox duties. This decision does not change it.

## Decision

Treat a relay as an untrusted byte path for the unchanged peer-online
connection. A relayed connection carries the same TLS 1.3 handshake, ALPN
`koed-peer-online/1`, transport pins, exporter-bound authentication and
messages as a direct connection. The relay is never a membership, deletion,
authorization or key-distribution authority, and peers do not accept a record
or acknowledgement because of the path that delivered it.

Use relay v2 rendezvous and data sockets as the carrier. Do not depend on Paseo
protected mode for confidentiality, integrity or peer authentication. Koed may
enable it later only as defence in depth, after the upstream handshake defect
is fixed and the added code is reviewed; its failure must not weaken or replace
the inner peer-online checks.

Relay use is opt-in and Operator-configured per installation. Koed ships no
default relay endpoint. An installation with relay enabled registers a control
socket for its own rendezvous identifier and acts as the TLS server for relayed
connections it accepts; the peer that dials acts as the TLS client. Either
member may dial the other, so neither is permanently privileged.

Prefer a direct connection when one authenticates. Fall back to the relay only
when direct connection fails, and never fall back to a weaker inner protocol,
an earlier version or an unauthenticated mode. A failure on the relay path is a
transport failure: work that was not committed stays pending and is retried
under the existing idempotency, checkpoint and deletion-acknowledgement rules.

Rendezvous identifiers must not be a stable public group or device identifier.
Derive each member's identifier from group secret material and its device ID,
with a defined rotation, so the relay operator cannot link it to the Koed group
ID and an outsider cannot predict it. Squatting or replacing a registration can
deny service but must not let anyone pass the inner authentication.

The relay stores no Memory, deletion records or acknowledgements. A relayed
connection exists only while both peers are connected. This keeps ADR 0066's
no-mailbox requirement: changes are not delivered while no two relevant peers
are online together.

Pairing over the internet is out of scope. Invitation and admission continue to
require the connectivity and ceremony ADR 0066 and the protocol describe. A
later decision may let an invitation carry a relay rendezvous hint; it must not
make the relay a source of trust for the trusted endpoint's identity.

## Consequences and Required Invariants

- Direct and relayed connections have one security and record contract. Tests
  and reviews for records, membership, deletion and acknowledgement apply to
  both paths without a relay-specific variant of the data protocol.
- The relay operator can observe IP addresses, timing, message sizes, and how
  long each connection lasts, and can deny or delay service. It cannot read
  records or impersonate a member without a member's transport private key.
  Status and documentation must say this; status must not imply a relayed peer
  is synchronized merely because a relay connection exists.
- Revocation and membership-conflict fencing apply unchanged. A revoked device
  that can still reach the relay fails inner authentication like any other
  non-member.
- Relay frames must carry inner TLS bytes unchanged and in order. Koed must bound
  frame size, buffered bytes, pending connections, handshake time and idle time
  on its side, and must fail closed on reordering, truncation or an unsupported
  relay protocol version.
- Running a relay adds an Operator-facing service with its own abuse controls,
  such as relay-level admission for registrations. Relay-level credentials are
  separate from Koed membership and grant no access to Memory.
- Paseo is a third-party dependency. Koed pins a reviewed version or image
  digest and treats upgrades as security-relevant changes.

## Alternatives

**Use Paseo protected mode as the security layer:** reuses upstream encryption
but authenticates only the server, does not bind Koed membership, introduces a
second key-distribution problem, and depends on a handshake path with a known
defect. Layering Koed authentication on Noise would need channel binding the
library does not expose in a reviewed form.

**Tailscale or LAN only:** has no new service or metadata exposure, but leaves
installations on different networks without sync unless the User runs a
tailnet. It remains the default and preferred path.

**Store-and-forward relay or mailbox:** delivers while peers are offline, but
contradicts ADR 0066 and would require retention, encryption at rest, deletion
and governance of stored Memory.

**Build a Koed-specific relay protocol:** avoids a third-party dependency but
duplicates rendezvous, connection management and deployment work the prototype
already exercised. Revisit if relay v2 cannot carry the inner connection within
the required limits.

## Open Design and Validation Work

Before implementation is enabled, specify and review:

1. The wire mapping from relay v2 data sockets to an ordered byte stream,
   including binary framing, back-pressure, limits and close semantics, and test
   it against both the Workers adapter and the Elixir image.
2. Rendezvous identifier derivation and rotation, registration admission at the
   relay, and behaviour under squatting, replacement and connection floods.
3. Direct-versus-relay selection, retry and timeouts, and how status reports the
   path in use without overstating synchronization.
4. Relay configuration, operation and monitoring for the Operator, and how
   relay credentials are stored separately from group secrets.
5. Two-installation tests through a real relay: authentication against
   substituted, revoked and non-member peers; interrupted, stalled and dropped
   connections before and after commit; replay; and deletion delivery and
   acknowledgement. Then validate between installations on different networks.

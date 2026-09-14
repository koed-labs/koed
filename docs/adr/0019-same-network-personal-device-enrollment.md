# Same-Network Personal Device Enrollment

Status: Accepted, amended by current capability-pairing policy below.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0018 Personal Collaboration Sync And Cross-Platform Secret Providers](./0018-personal-collaboration-and-cross-platform-secret-providers.md)
- [0044 Application-Managed PDS Secret Storage](./0044-application-managed-pds-secret-storage.md)
- [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md)

## Context

PDS V1 already defines signed device enrollment, membership epochs, recipient
key envelopes, and an opaque encrypted relay.
Those primitives did not provide a usable same-network Desktop ceremony. A
User needed a safe way to connect a second device without copying an API Token,
browser cookie, recovery key, device private key, or PDS runtime secret.

Plain HTTP bearer invitations are not acceptable on a LAN. A passive observer
could copy the bearer value and race the intended device. A general local API
listener is also too broad: pairing must not expose Personal Memory, Team
routes, operational routes, or arbitrary proxy behavior.

PDS V1 is relay-backed. Same-network pairing and peer-assisted transfer reuse
the same membership and package protocols; neither creates a second sync
protocol. In the local self-hosted topology, the
inviting installation may co-locate the neutral PDS Authority/Relay service
role and provides a narrowly scoped route to it. The Authority has a separate
signing identity in the application-managed PDS secret store and no group
content keys; it is not the inviting device's member identity. That route is an
availability dependency for replication, not a source-of-truth or plaintext
Memory authority.

## Current capability-pairing amendment

This amendment is authoritative for the current build and supersedes conflicting
ceremony details below. A one-time invitation link is the enrollment capability.
After Koed validates expiry, group, transport binding, the signed joining-device
request, and single-use state, possession completes enrollment automatically.
There is no human-facing short code, comparison ceremony, or separate **Approve
device** action. `challenge_id` remains an internal binding identifier only.

SSH/headless redemption accepts the link only through `--link-stdin` or
`--link-fd <fd>`. The former `--link <link>` argument is removed so bearer
material is not intentionally placed in process arguments.

Desktop paste or QR scan is preferred. The registered `koed-pair://` protocol is
also supported, but OS activation has platform-specific argument exposure:
macOS normally delivers the URL through Electron's `open-url` event; Windows and
Linux may deliver the complete URL through process arguments on initial launch or
single-instance activation. That exposure is inherent to those OS protocol
handlers, not a blanket Koed guarantee. Koed must not log or persist the URL;
users who want to avoid argv exposure should paste or scan instead.

## Decision

Koed Desktop exposes a **Devices** action in the account rail. The installation
hosting the group's neutral Authority/Relay can create a ten-minute, one-use
invitation and show it as both a QR code and a copyable link. The receiving
Desktop accepts the link through explicit paste, QR scan, or the registered
`koed-pair://` deep link. Koed validates the signed joining-device request and
completes enrollment automatically.

This control-plane placement does not make that installation a plaintext
Personal Memory authority or aggregate Recall host. Every admitted device
remains a symmetric source and replica in the data plane. It does make the
installation an operational availability hub in V1: enrollment, governance,
route discovery, and offline fallback pause when its Authority/Relay route is
unavailable. Already discovered reachable peers may continue transferring
packages directly until their short-lived routes expire. A
joined replica does not advertise an invitation action that its local Authority
key cannot countersign; the User creates the next invitation on the same
Authority-hosting installation. V1 has no Authority transfer or rotation
ceremony. Moving that role requires a later protocol decision and cannot be
approximated by copying the Authority key between devices.

The invitation link has this shape:

```text
http://<private-ip>:3310/pair/<invitation-id>#token=<256-bit-secret>
```

The URL fragment is never sent by a browser HTTP request. Desktop derives an
AES-256-GCM transport key from the secret with HKDF-SHA-256, the protocol
identifier, and invitation ID. Invitation retrieval, signed-request
submission, enrollment, and bounded control requests use authenticated encrypted
envelopes. Direction, invitation ID, and message ID are authenticated
additional data. Every message has a fresh nonce and message ID.

The listener:

- accepts only private IPv4 invitation destinations;
- permits at most eight live invitations;
- permits at most 64 unique exchanges per invitation;
- limits encrypted and plaintext messages to 256 KiB;
- rejects unknown fields, methods, routes, replays, wrong-direction messages,
  altered ciphertext, expired invitations, and wrong secrets;
- invalidates the invitation immediately after successful enrollment;
- uses a no-store, no-referrer landing page with a nonce-scoped CSP;
- exposes only the exact PDS enrollment control routes needed by the joining
  device;
- exposes the PDS package data plane only with the existing membership
  certificate and signed relay-proof contract;
- never accepts a browser session, API Token, device credential, or pairing
  secret as PDS governance authority.

Invitation state is temporary; the authenticated package receive path is not.
Every Desktop with a Personal Device Group starts the same-network listener and
restores it when local services resume. Only the Authority-hosting installation
may create invitations. Joined replicas expose no enrollment authority, but
may advertise a short-lived peer receive route through the Authority/Relay.
After an invitation is invalidated, only membership-certificate and signed-proof
package traffic remains available.
Listener startup failure is surfaced in Devices status while Personal capture
and Recall remain usable.

The main process proxies enrollment control to the loopback local API with the
scoped `Koed-Desktop` credential. That credential is accepted only by a
`local_personal` API on loopback and only for its recorded Personal owner.
Neither it nor any device or Authority private key crosses renderer IPC. The
renderer receives only the invitation display value, expiry, device label,
and coarse state. During explicit first-device setup, it may also
receive the newly generated recovery code once so the User can record it. The
main process writes the encrypted recovery kit through a native save dialog,
passes the recovery code to `koed-server` through an owner-only temporary file
descriptor, and never persists or logs the plaintext code.

Desktop provisions the local Authority signing key as a separate opaque secret
and verifies it before starting the API child. The API and Worker resolve only
opaque references through the application-managed store; Authority private
material remains forbidden inside shared device runtime payloads and renderer
IPC. Store reads fail closed on unsafe permissions, malformed state, missing
keys, or failed authentication.

Desktop and headless processes use the same `KOED_HOME/secrets/pds-secrets.json`
store. No platform credential provider, in-memory bridge cache, or Electron
child-process bridge is required. Writes use the store's atomic locking path so
concurrent Desktop and service mutations cannot overwrite each other.

A protected local runtime is not enrollment by itself. If its profile-local
Personal database has no matching group and local User binding, Desktop reports
recovery as required and must not render cached members as connected. Reusing a
profile path after deleting its database therefore cannot silently attach the
new local Personal principal to secrets retained in the application store.

The joining device still generates its own Ed25519 and X25519 keys. The active
device signs the membership transition and creates recipient envelopes through
the existing PDS implementation. The Authority countersigns it, both devices
acknowledge the new epoch, and the joining device stores only its own secrets
through the application-managed PDS store.

Pairing progress uses held encrypted requests and Desktop IPC completion. It
does not poll. Closing an invitation before its commit boundary cancels it.
Once Koed commits the membership transition, it keeps the gateway available
until the joining device acknowledges and activates the new epoch; that
transition can no longer be canceled as though no membership change occurred.

Desktop atomically replaces the protected runtime after bootstrap, enrollment,
or epoch refresh, then sends a loopback-only authenticated wake. The worker
adopts the new runtime at the next reconciliation-cycle boundary. Enrollment
must not restart API, Worker, capture, or Recall services.

## Consequences

- A copied landing-page URL without its fragment is useless.
- A passive LAN observer cannot recover the invitation, enrollment request, or
  control responses.
- Possession of the QR/link is the enrollment capability; validation of the
  signed PDS transition, expiry, transport binding, and single-use state remains
  mandatory, but no second human approval is required.
- The Authority/Relay route must be reachable for enrollment, lifecycle,
  discovery, anti-entropy, and offline delivery. A temporary outage does not
  stop local capture, Recall, or transfer over already discovered peer routes.
- Loss of the Authority-hosting installation strands V1 enrollment, governance,
  new route discovery, and durable offline delivery until a supported Authority
  recovery/transfer protocol exists. Replicas retain local use of already
  materialized Memory.
- A joined replica remains symmetric for capture and replication and may host a
  signed peer package receive path, but it does not host the group's enrollment
  authority. It directs the User to create another invitation on the
  Authority-hosting installation.
- Idle synchronization uses database notifications and one authenticated held
  relay wake request. Persisted retry due-times use exact one-shot timers;
  continuous interval polling is forbidden.
- Unauthenticated peer mesh, Authority transfer/rotation, mDNS discovery,
  public-address pairing, and Bluetooth proximity are not silently inferred.
  Peer routes are signer-bound, short-lived records discovered through the
  Authority/Relay and carry only the existing encrypted package protocol.
- Retrying the exact signed joining request reuses the locally protected
  pending keys and request. A different request cannot replace it. This makes
  response loss recoverable without creating a second logical device.
- The QR renderer uses the established `qrcode` package with high error
  correction. A future logo may be composited without changing invitation
  bytes or the pairing protocol.

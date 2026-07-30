# Account-Assisted Personal Device Enrollment

Status: Proposed.

Related decisions:

- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0012 Symmetric Replicated Personal Memory Across Devices](./0012-symmetric-replicated-personal-memory.md)
- [0019 Same-Network Personal Device Enrollment](./0019-same-network-personal-device-enrollment.md)
- [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md)

## Context

A User who signs into Koed on a second device expects Koed to recognize their
account and offer to connect their Personal Memory. Requiring the User to find
the Devices screen and manually transfer a same-network invitation makes the
normal cloud-connected path unnecessarily difficult.

Human authentication is not Personal Device Sync authorization. A WorkOS or
local browser session may prove which Koed User is present, but a stolen browser
session, compromised email account, or mistaken external identity mapping must
not be sufficient to admit a device to an encrypted Personal Device Group.
Personal Device membership gives the device access to replicated Personal
Memory and therefore requires cryptographic authorization by an existing active
device or the User's recovery root.

Remote Account Links, upstream device credentials, Team Membership, and
Personal Device Group membership remain separate relationships. Connecting two
installations to the same remote `koed-server` does not itself synchronize
Personal Memory.

## Decision

Koed supports **account-assisted Personal Device enrollment**.

After an authenticated User connects an otherwise healthy local installation
to a remote `koed-server`, the remote service may report that the mapped Koed
User has an existing Personal Device Group. Koed Desktop then automatically
offers to connect the local installation. Discovery and prompting are
automatic; membership and data transfer are not.

The default Desktop flow is:

1. The User authenticates through a supported browser identity provider.
2. Koed resolves the provider identity through an explicit Koed identity
   mapping. Email equality alone is insufficient.
3. The remote backend returns only the minimum account-scoped enrollment
   availability needed by Desktop.
4. Desktop opens a **Connect this device to your Personal Memory?** modal.
5. The modal names the current device, describes the eligible data that will
   synchronize, and requires an explicit **Connect device** action.
6. The joining installation generates and protects its own device signing and
   key-agreement keys, then submits a proof-of-possession enrollment request.
7. An existing active device receives a durable realtime approval request. It
   must explicitly approve the exact joining device and comparison code.
8. If no active device is available, the User may choose the existing
   recovery-root flow. Browser authentication alone is never the fallback.
9. The Authority verifies the group-authorized transition, countersigns it,
   and issues the joining device's bounded membership state and encrypted key
   material.
10. The joining device durably reconciles the group, membership, keys, and
    Personal Sync Policy into its own local database before reporting success.
11. Eligible synchronization starts only after that local reconciliation.

Approval delivery is subscription-driven and durable. It does not use interval
polling. Reconnect performs a post-subscription durable catch-up so an approval
request or decision cannot be lost while either Desktop is offline.

The modal may be dismissed without changing membership or synchronization
state. Dismissal is remembered so Koed does not repeatedly interrupt the User.
The Devices surface continues to show a clear **Connect this device** action,
and a material account or group-state change may make the offer relevant again.

Cancel, expiry, denial, identity mismatch, group ambiguity, key-store failure,
or incomplete local reconciliation fails closed. Desktop must explain the
recoverable next action without claiming that the device is connected. A local
installation already bound to a different Personal Device Group is never
silently merged, replaced, or reset.

## Hosted Authority And Relay

A private, self-hosted, or Koed-managed remote `koed-server` may operate the
Personal Device Group Authority and encrypted Relay using the same protocol
contract.

The hosted Authority/Relay:

- may associate an authenticated Koed User with enrollment availability;
- may deliver durable enrollment requests, decisions, membership statements,
  encrypted key envelopes, and opaque encrypted packages;
- may remain available while personal devices are offline;
- cannot decrypt Personal Memory or group content keys;
- cannot authorize a joining device without an active-device or recovery-root
  signature;
- cannot use WorkOS, email access, Team authority, support authority, or an
  upstream device credential as Personal Device Group authorization;
- must keep identity-provider mapping, upstream enrollment, Personal Device
  membership, and Team authorization as separate auditable records.

This hosted topology removes the product requirement that the original laptop
remain online merely to relay packages. It does not turn the remote service
into the plaintext Personal Memory authority. Deployment capability discovery
must state whether account-assisted enrollment and hosted Authority/Relay are
available; clients must not infer support from a hostname.

The current same-network V1 Authority/Relay-hosting installation remains a
supported topology until a hosted profile is implemented and selected.
Same-network QR/link pairing remains available for local-only deployments and
as an explicit alternative where the devices can reach one another.

## Synchronization Boundary

Enrollment does not broaden the Personal Device Sync data contract.

The current V1 data plane synchronizes eligible future closed Captured Sessions
and compatible allowlisted portable derived artifacts according to the
normative Personal Device Sync protocol. Historical backfill, open/live Session
replication, mutable Personal collaboration state, and any broader source class
remain separate capabilities until explicitly designed and implemented.

The connection modal must describe the effective capability honestly. It must
not imply that historical or live Conversations synchronize when the selected
deployment cannot provide that behavior.

## Security And Privacy Requirements

- Require recent authenticated browser identity before starting remote
  enrollment.
- Require explicit consent on the joining device and cryptographic approval by
  an existing active device or recovery root.
- Bind approval to the exact group, joining deployment, device keys, challenge,
  comparison code, expiry, and current group-log head.
- Generate device private keys locally and store them only through the
  supported platform secure provider.
- Never expose group identifiers, membership details, key references, Personal
  Memory metadata, or recovery material through public capability discovery.
- Rate-limit and expire discovery and enrollment challenges without using rate
  limits as the primary authorization boundary.
- Audit redacted enrollment state transitions without logging provider tokens,
  browser cookies, email addresses, device proofs, keys, invitation secrets, or
  replicated content.
- Revocation of browser sessions, upstream credentials, Personal Device
  membership, and Team Membership remains independent.

## Consequences

- The common same-account path becomes discoverable and requires very little
  manual configuration.
- A browser login cannot silently grant access to encrypted Personal Memory.
- A User still performs one meaningful approval, normally on an existing
  device.
- Recovery remains possible without an online existing device, but only with
  the User-held recovery authority.
- Hosted Authority/Relay availability can improve offline delivery without
  weakening the end-to-end Personal Device trust boundary.
- Local-only users retain same-network pairing and local capture/Recall.
- The account link alone continues to synchronize nothing.

## Non-Goals

- Automatic membership based on email, WorkOS identity, Team Membership, or
  possession of an upstream credential.
- Operator, support, or authority-only device admission.
- Automatic merging of separate Personal Device Groups.
- Historical backfill or open/live Conversation replication.
- Authority access to plaintext Personal Memory or group content keys.
- Replacing Team Share Grants or Cross-Identity Sync with Personal Device Sync.

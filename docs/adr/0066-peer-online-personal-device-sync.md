# Peer-Online Personal Device Sync and Group Governance

Status: Accepted. This decision selects a separately versioned peer-online
profile; it does not mean the profile is implemented or available.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0019 Same-Network Personal Device Enrollment](./0019-same-network-personal-device-enrollment.md)
- [0041 Peer-Assisted Personal Device Sync Transport](./0041-peer-assisted-personal-device-sync-transport.md)
- [0045 Incremental Personal Session Checkpoints](./0045-incremental-personal-session-checkpoints.md)
- [0065 Capture and Recall Without Managed Conversation Execution](./0065-capture-and-recall-without-managed-conversation-execution.md)
- [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md)

## Context

A User may capture Conversations and use Recall on multiple personal Koed
installations, such as a laptop and a headless desktop. Each installation must
continue local capture and Recall while disconnected. When both are online and
connected, eligible single-origin Personal Memory and authorized deletions
should converge after validation, provided the required data remains available
and no unresolved conflict prevents application. Neither installation is a
permanent Memory hub or requires a UI to participate.

A mobile application may connect to an available installation and request
access to its combined view. It is a separately authorized client, not a
Personal Memory replica, and does not receive the group sync credentials merely
by connecting.

The User accepts that changes need not be delivered while no two relevant peers
are simultaneously reachable. A durable intermediary mailbox is therefore not
required for this profile. A future internet relay may forward a protected
connection without storing Memory for later delivery. Initial validation can use
local-network or Tailscale connectivity.

Current PDS V1 has symmetric data replicas but a fixed Authority/Relay host.
That host provides membership, lifecycle coordination, route discovery,
anti-entropy, and a durable mailbox. Direct transfer is an optional data path,
not independent peer governance. In particular, ADRs 0012 and 0041 require the
Authority/Relay for their existing profile. Equal data-plane participation does
not currently make group governance independent of that host.

## Decision

In line with ADR 0065, AI Clients create and continue Conversations outside Koed;
this profile synchronizes eligible captured Memory rather than managing their
execution. Introduce a separately versioned peer-online profile rather than silently
changing PDS V1. Retain existing PDS package, checkpoint, local storage, and
materialization foundations where their contracts fit; evaluate their actual
dependencies before choosing whether to adapt or replace individual pieces.
Local capture and Recall must not depend on a peer, an Authority service, or a
relay being online.

Each supported Captured Session has one originating installation, the sole
writer of its source stream. Other installations materialize read-only replicas;
repeated delivery of the same valid record is idempotent. Ordered, cumulative
checkpoints and the read-only receiver boundary from ADR 0045 remain applicable
where supported. Exact checkpoint eligibility and historical backfill remain
open.

Independently capturing or continuing a copied AI Client Session on another
installation is unsupported for this profile. It does not deduplicate or
converge independently observed Sessions across origins, transfer source-writing
authority, or promise automatic source-conflict recovery. This exclusion does
not by itself prohibit local historical import under its applicable consent
rules. Unsupported copies may appear as separate Memories if no mismatch is
detectable.

No machine is permanently privileged because it was enrolled first or runs a
UI. A new installation joins only after explicit User approval on any one
existing trusted installation, with both installations online for pairing.
Approval binds the new installation's cryptographic identity to the Personal
Memory group; discovery or possession of a network address alone grants no
access. A trusted installation can present a short-lived, single-use pairing
link as a URL and QR code, including in a headless terminal. After the new
device opens the link, it generates and displays a short code. The User enters
that code on the trusted installation that originated the link to approve the
pairing. Possession of the link alone does not approve admission. The link and
code are sensitive and must be protected from disclosure. Their authentication
and binding to the pairing attempt, the trusted installation, and the new
device, as well as expiration, single-use enforcement, and protection against
code guessing, must be specified before implementation. The link must not
contain reusable group credentials. Scanning a link does not by itself make a
mobile client a replica.

If one installation is permanently lost, a surviving trusted installation
can help the User pair a replacement while the group is unconflicted. The initial version does not provide
separate group recovery material: if all trusted installations are lost, the
group cannot be recovered. This does not transfer authorship of an existing
Session or recover data that existed only on a lost installation. Restoring old
Koed data from a backup is unsupported in the initial version; backup recovery
and any future recovery material require a separate design. Koed is not assumed
to detect every restored backup automatically.

Separate the synchronization contract from connection establishment. First
validate local and Tailscale connectivity; later add internet pairing and a
protected relay transport without changing the meaning of the replicated
records. Relay v2 is the intended starting point for that later transport,
subject to security and lifecycle validation; its prototype is not production
integration. A protected channel alone does not establish group membership or
authorize a mobile client.

The User can revoke an installation from any one remaining trusted
installation. The initiating installation immediately stops accepting sync from
the revoked device and propagates an authenticated revocation to other peers
when they reconnect. Status must distinguish local revocation from acknowledgement
by all known peers; offline peers cannot know of it until they receive it. A
revoked installation must pair again as a new device rather than silently
regain access. Revocation cannot erase data or credentials already obtained by
that device.

If conflicting membership changes are detected, fail closed: each installation
pauses Memory synchronization for the whole group when it learns valid conflict
evidence. Offline or unaware installations cannot pause until they learn of it.
Do not automatically choose or merge either change. A peer that is merely behind is
not, by itself, a conflict and should catch up after its history is validated.
Local capture and Recall remain available, and safe conflict evidence is
retained. The initial release does not resolve membership conflicts in place;
synchronization remains paused. Recovery through a new group and re-pairing is
a later feature, not an automatic fallback. A future resolution design must
retain every valid revocation observed on any conflicting branch, require fresh
User approval for conflicting admissions, and not silently restore a revoked
device. The User may authorize a resolution only from an installation that was
trusted before the histories diverged and has not been revoked on any validated
branch. The initial protocol must define conflict detection, validation of
revocations and status without relying on that future resolution process.

Revoking an installation does not undo admissions it validly approved before
the revocation. It prevents future approvals; concurrent or disputed approvals
follow the fail-closed conflict process. Propagation of approvals, causal
ordering, key rotation, and fencing require specification before implementation.
Handling permanently unavailable members requires a separately designed recovery
path.

## Consequences and Required Invariants

- Each installation retains durable local work while peers are unavailable.
  After recoverable interruptions, exchange must resume safely, and applying the
  same change repeatedly must be idempotent. Membership conflicts remain paused
  as described above. A session not yet exchanged can be lost with its only copy.
- Detected identity, origin, signature, sequence, closure, checkpoint-prefix,
  or immutable-record mismatches fail closed: do not silently overwrite or
  merge conflicting source data, project it as valid, advance a success cursor,
  or acknowledge successful materialization. Retain safe diagnostic evidence
  and report the failure. Missing predecessors may remain pending for catch-up.
  The protocol must define safe retention and manual recovery; automatic
  conflict resolution or recovery is not promised.
- Deleting a Session on any trusted installation requests deletion across all
  paired installations. Delete locally immediately and retain a durable,
  authenticated deletion event for propagation after reconnection. An offline
  peer may continue to show previously retained Memory until it learns of the
  deletion; status must show deletion as pending on peers that have not
  acknowledged it. The design must specify authorization, local versus group
  completion and retained deletion history. Stale packages or device state
  must not silently resurrect deleted data; handling restored backups requires
  a separate design.
- Membership and recovery must handle divergent histories and revoked or
  returning devices without silently restoring authority. Restored backups are
  unsupported, not assumed detectable, and require a separate recovery design.
  Revocation cannot erase Memory or keys already obtained by a previously
  trusted device.
- A User must explicitly authorize new devices. Headless operation must not
  require running Desktop on the headless installation or sharing an API Token
  as a device credential.
- Mobile access and revocation are separate from replica enrollment; neither
  mobile access nor device pairing grants Team Membership or Workspace Access.
- The transport may observe network and traffic metadata even when content is
  protected. Peer identity and group authorization must be verified separately.
- Offline capture and Recall remain available, but governance and deletion
  propagation may be pending. Status must not imply that an offline peer is
  already synchronized.

## Alternatives

**Retain the fixed Authority/Relay and durable mailbox:** preserves the current
V1 model and simplifies coordination, but retains a special host for governance
and makes recovery depend on it. It also provides offline intermediary delivery
that this use case does not require.

**Converge independently observed Sessions across origins:** preserves the V1
cross-origin deduplication capability, but requires verified identity, conflict
resolution, and recovery for copied or divergent source histories. Defer this
capability rather than silently choosing or merging incompatible observations.

**Build a new peer protocol from scratch:** may remove inherited Authority
coupling more cleanly, but would require new, verified package, replay,
lifecycle, and recovery behavior. Reusing proven PDS foundations is preferred
where their dependencies permit; this is not yet a claim that adaptation is
faster or that all existing components are suitable.

**Use a designated Personal Memory hub:** simplifies aggregation but makes
combined local Recall dependent on a privileged installation, contrary to the
equal offline-replica requirement.

## Open Design and Validation Work

Before implementing the new governance profile, specify and review:

1. Membership authorization, concurrent offline decisions, fail-closed conflict
   detection, revocation, and fencing of an old Authority or device. Recovery
   from a membership conflict is deferred to a later feature.
2. Deletion authorization, offline intent, acknowledgements, retained deletion
   floors, stale-backup handling, and the meaning of completed deletion.
3. Which Captured Sessions and checkpoints are eligible, whether historical
   backfill is supported, and what happens when no copy of data remains.
4. Peer discovery, mutual authentication, endpoint key binding, key custody,
   protocol versioning and upgrade/cutover from existing PDS V1.
5. Two-installation tests for independent Sessions from each origin, read-only
   replicas, same-origin replay, missing predecessors, detected identity and
   history mismatches, reconnect and restart, deletions and stale restore.
   Where unsupported copied Sessions are detectable, verify safe failure rather
   than cross-origin convergence. Then validate on physical headless and laptop
   installations. Synthetic tests alone are not evidence of end-to-end AI
   Client capture.

For the peer-online profile only, this decision supersedes conflicting
requirements in ADRs 0012, 0019 and 0041 for fixed Authority/Relay governance,
a durable mailbox, V1 enrollment and recovery, and cross-origin convergence,
including the associated V1 identity and deletion requirements. ADR 0045's
checkpoint ordering, integrity and read-only receiver requirements remain
applicable where checkpoints are supported; eligibility remains open.

Existing PDS V1 requirements and behavior remain in force for V1 until a
separately specified, authenticated upgrade or cutover is implemented. This
decision does not silently change V1. Independent consent, security,
provenance, capture, Team access and lifecycle requirements remain applicable
unless explicitly changed. Define authenticated version negotiation and cutover,
and update protocol and operational documentation as part of implementation.

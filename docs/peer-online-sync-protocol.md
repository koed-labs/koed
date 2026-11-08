# Peer-online Personal Device Sync protocol

**Status: design in progress; not enabled.** This document develops the separate
peer-online profile described by [ADR 0066](adr/0066-peer-online-personal-device-sync.md).
It does not change or negotiate the Authority-based PDS V1 profile. Implementations
must not advertise peer-online sync as available until the requirements and acceptance
tests below are implemented and independently reviewed.

## Scope and trust

Two approved installations may synchronize directly while both are online. Each
continues local capture and Recall while offline. An address, a Tailscale identity,
or possession of a link alone is not Koed membership. Received Sessions are
read-only replicas with one origin. A relay or durable intermediary mailbox is not
part of this profile; protected relay v2 is a later transport.

Each installation needs separate signing, encryption and transport identities.
Membership binds their public keys to a device ID and group. Private keys and group
secrets stay in protected local storage. A trusted genesis anchor and the signed
history identify the group; a self-signed genesis received from an untrusted
connection is not enough. The profile and every signed record use distinct versioned
domain separation. Unsupported versions fail closed; there is no implicit V1
fallback or automatic migration.

## Pairing and protected connection

A User intentionally obtains an invitation from a trusted installation. The
invitation must bind the group and trusted endpoint identity, including its pinned
transport public key, as well as a short-lived single-use attempt. The joining
installation validates that identity over an authenticated encrypted connection,
generates its own keys, and displays a short code. The User enters the code on the
trusted installation to authorize the specific joining identity. The admission
transaction rechecks the trusted installation's current authority, the attempt's
expiry and one-use state, and the joining identity before committing membership.

The final ceremony must bind the invitation, both device identities and all keys,
group, version and connection transcript; demonstrate possession of the joining
signing and encryption keys; protect the code against disclosure and offline
verification; and limit guessing and resource consumption. A reviewed authenticated
key-exchange design and explicit crash/retry behavior are prerequisites, not implied
by the current pairing-attempt code. The code or invitation must not appear in logs.

A candidate bootstrap design uses an invitation carrying a random 256-bit
single-attempt capability and the trusted endpoint's transport SPKI pin. The
joining installation verifies that pin before sending the capability or any
candidate details. The six-digit code is transported only inside that pinned TLS
connection and is not persisted as an offline verifier. The invitation must reach
the User through an authenticated, confidential channel: pinning an attacker-
substituted invitation authenticates the attacker, not the trusted installation.
This design is not an implemented or reviewed pairing ceremony. Address-range
checks, including the shared `100.64.0.0/10` range used by Tailscale, do not prove
that an interface or remote peer belongs to a particular private network; bind
and firewall policy must be configured independently.

Normal peer connections require mutually authenticated encryption. Bind both
transport keys to active signed membership and bind session authentication to the
protected channel, group, profile and version. Before data exchange, peers reconcile
membership and deletion evidence. Recheck authorization and local fences at each
sensitive durable commit, not only when a connection opens. Revocation or a detected
membership fork closes or fences affected work. An offline installation cannot
observe a revocation until evidence reaches it; an unaware peer may continue to
share data during that interval.

## Membership and conflict

Only a device authorized at a validated parent may sign a membership decision.
Missing ancestors require catch-up and are not evidence of a fork. Two valid,
distinct children of the same parent are a fork. Persist validated evidence and a
fail-closed group sync pause atomically. Invalid or unauthenticated oversized input
must not create a durable pause. The initial profile has no in-place fork resolution;
local capture and Recall remain available. A peer must not treat unvalidated or
resource-limited history as current. The current bounded membership implementation
retains the first authenticated limit-triggering record but does not validate or
retain subsequent evidence after that limit. A limit therefore requires an explicit
operator-visible pause; it is not a complete audit of later forks or revocations.
Membership v2 requires canonical X25519 SubjectPublicKeyInfo DER and a matching
SHA-256 digest; this validates key format, not key possession or history freshness.
A genesis anchor alone cannot detect rollback to an older, internally consistent
database snapshot. Do not authorize sync after restore or rollback without an
independent freshness mechanism or authenticated reconciliation that detects it.

Revocation fences known future access and requires rotating future shared secrets
away from the revoked device. It cannot erase secrets or Memory previously obtained.
Re-enrollment requires a fresh identity and User approval. Key rotation, conflicting
decisions and offline peers require durable state and explicit status; accepting a
signature alone is not a complete authorization protocol.

## Checkpoints and deletion

Exchange authorized membership and deletion evidence before checkpoint data.
Authenticate the original producer independently of the serving peer, validate
immutable history and predecessors, and durably materialize before acknowledging
success. Duplicate delivery is idempotent; absent predecessors remain pending.
Received replicas must not become new origin writers. A sync commit must recheck the
local membership fence and deletion floor in the same durable boundary as its
visibility and acknowledgement.

A User-requested Session deletion is group-wide. Its authorized deletion record or
transactional outbox must survive a crash together with local deletion. A receiving
installation applies it durably and removes or hides the corresponding source and
derived Recall data before acknowledging. Retain deletion evidence or equivalent
floors for the life of the group so delayed checkpoints cannot resurrect deleted
Memory. Offline devices remain pending until they acknowledge; revocation does not
prove that a device deleted data. ADR 0068 defines the recipient roster, signed
acknowledgement, retry and completion semantics; authorization across concurrent
deletion and membership decisions and durable transaction ordering still require
review before enabling the profile.

## Gated persistence foundation

The database floor repository is an unintegrated acceptance foundation, not a
sync or deletion implementation. It replays membership under the same per-group
transaction lock, retains an immutable binding through its repository interface,
blocks checkpoint acceptance after a deletion floor, and records ordered checkpoint
receipts. Sequence starts at zero; each later predecessor is the base64url SHA-256
of `koed/peer-online-checkpoint/v1/record\n` followed by the canonical previous
envelope. A missing predecessor is not retained. Per session, at most 16 checkpoint
rows and 32 MiB of stored envelope plus base64 payload are retained; per group,
at most 128 rows and 128 MiB. Admission over either limit returns
`quota_exceeded` without changing the chain; exact duplicates remain retryable.
There is no compaction or automatic eviction: capacity recovers when deletion
atomically removes that session's checkpoint rows while retaining its deletion
floor. These are logical data limits, not PostgreSQL disk-size or WAL limits.
Stored checkpoint payloads are not materialized by the floor repository. A separate
internal client-taking primitive can materialize a replica and source items in a
caller-owned transaction, checking the existing receipt, floors and immutable
source history. It requires independently authenticated decrypted input and fresh
membership. The caller must hold the group then owner locks, persist the receipt in
that same transaction, and commit before acknowledging. Database guards restrict
source mutation and V1 Session-closure publication; they do not replace deletion
fencing across all writers and readers. Do not enable the profile on the strength of
this primitive.

### Checkpoint receiver

An unintegrated receiver composes floor acceptance, decryption and materialization in
one group-locked transaction. It is not yet called by any network service. Under the
lock it:

1. requires an immutable group-to-owner binding (`peer_online_group_owners`) whose
   group matches the trusted genesis anchor; otherwise it reports `fenced`;
2. replays membership and reports `fenced` unless the head is current, conflict-free
   and complete, both the receiving device and authenticated transport peer are
   active, and the trusted session revision exactly matches that local head. The
   session context is supplied separately from wire JSON;
3. applies the floor repository checks (origin signature at the current head,
   immutable binding, deletion floors, predecessor chain, quotas) and records the
   receipt;
4. rejects a checkpoint whose origin is the receiving device, so a Session never
   returns to its origin as a replica;
5. decrypts the payload for the receiving device and parses canonical
   `koed/peer-online-session-snapshot/v1` plaintext;
6. requires the snapshot's source Session identity to match the binding's
   `sourceIdentityCommitment`; and
7. materializes the append-only read-only replica under the group's owner.

Any failure after step 3 rolls back the receipt as well. Only `accepted` and
`duplicate` results carry an acknowledgement, and both are returned after commit.
`duplicate` is acknowledged only when the replica already reflects that sequence.
`pending`, `deleted`, `invalid`, `quota_exceeded` and `fenced` must not be
acknowledged. The snapshot carries source facts only. The receiver derives local
Session and item identifiers, transport, visibility and idempotency keys, so a peer
cannot choose them. PDS canonical JSON has no JSON numbers, so integers travel as
canonical decimal strings and raw source JSON travels as JSON text.

An origin seals a checkpoint by encoding the full Session snapshot, encrypting it to
every active member at the current head and signing the envelope. The binding commits
to the source Session identity as a domain-separated hash of its source kind, adapter
version and external Session ID.

Accepting a received deletion now also marks an already-materialized replica Session
and its derived Recall rows deleted, in the same transaction that records the
permanent floor. Later checkpoints for that Session report `deleted`. A deletion
with the same identity (group, origin, Session key and event ID) re-prepared at a
newer membership head reports `duplicate` and leaves the original floor
unchanged; a deletion with a different identity reports `deleted`.

A future authenticated member session hands its socket to one bounded framed
message channel and supplies the trusted transport peer ID and membership revision
that it authenticated against as an internal `PeerOnlineSessionContext`. This
context is passed separately from decoded wire JSON; the protocol adds no
`sessionContext` field. Floor APIs receive the trusted local device ID separately;
the receiver uses its configured local ID. The context grants no authorization by
itself: each floor/receiver commit checks it under the same-group transaction
against a complete, conflict-free replay, the current local head, active local
and transport-peer devices, and a clear restore quarantine. An absent, stale or
invalid context returns `fenced` before receipt/duplicate lookup, deletion-floor
writes or materialization. The signed checkpoint/deletion origin is still
validated independently and is never replaced by the transport peer. The fence
relies on the same-group advisory lock and cooperating peer-online writers only;
it does not protect against unrelated writers or database rollback. These APIs
remain unintegrated with production transport.

An unintegrated local deletion outbox transaction records a permanent unsigned
intent, removes stored checkpoint payloads, and marks the owner's personal Session
and existing derived rows deleted. The intent also blocks future floor-repository
checkpoint acceptance. The caller must establish the local-to-peer Session
association; this repository does not establish or authenticate it. Preparing a
signed deletion requires current membership and stores a separate sendable
preparation for the same permanent deletion identity; a newer membership head may
require re-preparing its signature, but cannot rewrite the original deletion floor.
Pending enumeration revalidates the prepared record against current membership
under the group lock and withholds stale records until re-prepared. Membership
can change after enumeration, so delivery must recheck the fence at its own
sensitive boundary.

Migration 0061 backfills existing deletion floors by clearing their checkpoint
cursor and deleting their checkpoint rows. Database triggers make deletion floors
and checkpoint records immutable, prevent changing or deleting a floor, and block
new checkpoint rows after a floor exists. Re-preparation can update only the
sendable signed representation for the same deletion identity; it does not replace
the permanent floor. Local visibility changes do not fence
non-cooperating writers or guarantee every read path honors deletion.
The repository assumes cooperating database writers; direct database writes can
change or erase floors and bindings. It does not protect against database rollback.
Do not expose it as peer sync until those boundaries are enforced and reviewed.

### Deletion recipients and acknowledgement

Migration 0063 adds a per-deletion recipient roster, following ADR 0068. A local
deletion request records the requesting device and, under the group lock, adds
every other active member as a pending recipient. Accepted membership appends and
admissions reconcile every roster in the same transaction: new members are added
as pending recipients, and a pending recipient that is no longer active becomes
`revoked_unconfirmed`. A conflicted or incomplete membership view changes nothing.
Database triggers reject deleting roster rows and changing an acknowledged row.

Receivers correlate deletions by identity. Accepting a deletion, or a deletion with
the same identity signed at another head, returns the identity, the retained floor
hash and the current head, which the caller signs into a
`koed/peer-online-deletion-ack/v1` record after commit. The outbox verifies an
acknowledgement against the recipient's historical key, requires that it names the
local floor's identity and a rostered recipient, and records it once. Delivery
enumeration per recipient honours capped, jittered backoff unless a new session
requests immediate delivery. Completion is reported per deletion as `pending`,
`complete`, `complete_unconfirmed` (some recipients revoked without
acknowledging), or `roster_unknown` for intent recorded before the roster existed;
completion stops retries only. Any active member may re-sign a stored floor at the
current head and serve it. Delivery enumeration, attempts and acknowledgements
fail closed while restore-quarantined. No transport sends or relays these records
yet.

Integration requires a single lock order spanning membership, owner, and session
locks; atomic deletion and source visibility changes; and fencing every capture,
checkpoint, Projection, embedding, LCM, publication, and replay writer. All source,
inspection, graph, and Recall reads must honor the same floor, including archived
paths. Existing PDS floors and locks do not provide these guarantees. Transport
integration of deletion delivery, relay and acknowledgement remains
unimplemented.

### Explicit restore quarantine

Migration 0062 adds a durable, one-way per-group restore-quarantine declaration.
Database triggers reject ordinary `UPDATE`, `DELETE`, and `TRUNCATE` of the
latch; privileged DDL remains outside this application-level guarantee.
Declaration requires an existing membership group and matching genesis anchor,
serializes through that group's advisory transaction lock, and is idempotent.
Cooperating membership writes, owner binding, floor acceptance, receiver
acceptance/duplicate results, direct materialization, and outbox send-eligibility
(`pending`/`prepare`) must fail closed while quarantined. Local deletion requests
remain allowed to hide the local replica and preserve intent, but quarantine
prevents that intent from becoming sendable.

This is an explicit post-restore or rollback-suspicion action only. The database
cannot detect a coherent rollback, and a restore to a backup predating the
declaration loses the latch. Quarantine reason and time are diagnostic only, not
freshness evidence. There is no Local Operator Scripts command, automatic restore
workflow, trusted-peer reconciliation, clear, or force-resume in this gate.
The per-group advisory lock serializes cooperating peer-online repository operations only;
arbitrary Capture/Recall writers and their lock order are outside this guarantee.
This does not authenticate a peer session, wire a network receiver, or enable
production sync.

### Current membership-auth snapshot lookup

The DB package now exposes `createPeerOnlineAuthMembershipLookup` for future auth
integration. Given a trusted genesis anchor and expected local owner ID, it reads
the persisted owner binding, restore-quarantine latch, and active membership head
under the same per-group lock. It returns `{revision, local, peer}` with only the
active device IDs, signing public keys, and transport SPKI pins. `revision` is
this database's local snapshot, not global freshness evidence.

The lookup requires a pool with `connectionTimeoutMillis` between 1 and 10,000 ms,
uses a 5-second lock timeout and 10-second statement timeout, and honors abort by
rejecting promptly and destroying an active client. A cancelled pool waiter may
remain queued until its bounded connection timeout. No production auth caller or
transport is wired to this API. The snapshot does not authenticate a TLS session,
provide pairing proof, establish an acknowledgement, or demonstrate sync between
installations. Keep peer sync disabled until the release gate below is met.

## Release gate

Before enablement, specify and review exact wire formats, limits, cryptographic
handshakes, identity custody and recovery, lifecycle authorization, deletion
anti-resurrection and transactional fencing. Test against invalid and replayed
inputs, endpoint substitution, unauthorized approvals, offline and concurrent
membership changes, deletion/materialization races, crashes and restarts. Exercise
real capture, bidirectional sync, offline catch-up, Recall, deletion and revocation
between independently running installations over LAN and Tailscale. Unit tests or
in-process two-database fixtures alone do not demonstrate the production profile.

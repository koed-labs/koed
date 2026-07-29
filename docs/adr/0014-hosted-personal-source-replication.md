# Hosted Personal Replication Uses The Conversation Source Journal

Status: Accepted.

Related decisions:

- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0009 Commercial SaaS Encryption And Key Management](./0009-commercial-saas-encryption-key-management.md)
- [0012 Symmetric Replicated Personal Memory Across Devices](./0012-symmetric-replicated-personal-memory.md)
- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](./0013-team-collaboration-authority.md)

## Context

Koed now retains eligible provider-native Conversation source as bounded,
immutable Conversation Source Journal segments and derives canonical
Conversation rows, Projection, Memory Events, embeddings, indexes, and LCM
Summaries from that journal.

Existing synchronization paths do not provide continuous hosted Personal
source replication:

- Directed Hosted Cross-Identity Sync sends policy-selected canonical semantic
  records to a Team-personal identity and deliberately leaves the complete
  provider transcript local.
- Personal Device Sync V1 replicates immutable closed Captured Session source
  packages through an end-to-end encrypted relay. It is not a hosted Personal
  processing backend and does not replicate active source segments.
- Share Grants authorize Team access to selected ready Memory. They do not
  synchronize Personal source.

A User who selects a hosted Personal backend expects eligible future
Conversations to remain available when the originating device is offline and
to become recoverable on another authenticated Personal device. The local
capture path must remain fast and offline-capable. The hosted backend must not
receive provider credentials, repository credentials, raw local paths, or
authority merely because a Project maps to a Team Workspace.

Literal PostgreSQL replication is unsuitable. Local and hosted schemas,
processing epochs, vector hardware, retention, encryption providers, and
deployment lifecycles may differ. Replicating database rows would also blur the
source, canonical, derived, Personal, and Team boundaries.

## Decision

Koed implements hosted Personal synchronization as application-level
replication of the Conversation Source Journal.

One Captured Session and one Conversation Source Artifact have one logical
identity and may have multiple physical replicas. The local execution-side
journal is the sole writer while that execution is active. Hosted and
downloaded replicas are read-only source replicas. They do not become forks and
cannot independently append to the same source generation.

The protocol identifier is
`koed.conversation-source-replication/v1`. Unsupported, missing, or downgraded
versions fail closed.

### Consent And Scope

Selecting a hosted Personal backend and explicitly enabling Personal Sync
Policy authorizes future eligible Captured Sessions for replication.
Registering an upstream, joining a Team, linking a Project to a Workspace, or
creating a Share Grant does not.

The normal setup flow may recommend enabling all eligible future Personal
Sessions, but the resulting policy and effective start boundary must be
persisted and inspectable. Historical source remains a separate bounded,
previewable operation. Capture Policy continues to decide whether source is
eligible for Personal Memory before Personal Sync Policy applies.

### Source And Replica Identity

The source deployment creates a random logical source id, a random source
generation id, and an origin signing key when journalling begins. A source
generation is immutable once closed. Copying or restoring a device may preserve
a physical replica id but never creates a second writer for an existing
generation. Importing unrelated bytes, provider rollback, or explicit fork
creates a new logical source or generation with recorded lineage.

Every segment has an origin-signed content manifest. Koed canonicalizes the
manifest with RFC 8785 JSON Canonicalization Scheme and signs it with Ed25519.
The signature binds:

- protocol version, logical source id, generation id, and origin key id;
- segment index, byte and record ranges, and predecessor content digest;
- plaintext content digest, source format, and adapter version;
- source creation epoch and previous-generation closure where present.

The signed content manifest is encrypted with the source bytes. A separate
authenticated transport envelope binds the ciphertext digest, recipient,
relationship, upload operation, key epoch, and signed-content digest as AEAD
associated data. Randomized encryption may produce different ciphertext for the
same signed content without creating a conflict.

Before accepting segment zero, the authority commits a create-generation
transaction that binds the immutable Ed25519 public key to the owning User,
origin deployment and enrolled device, logical source, generation, source
creation epoch, and optional prior-generation closure. First-seen segment keys
are never trusted. Every verifier resolves this authority record, pins the
public key, and checks current lifecycle floors before verification.

An origin key never rotates within a generation. Key loss leaves an open
generation incomplete; continuation creates a new linked generation after a
fenced authority transition. Device cloning or two create-generation requests
for the same authority position is a conflict. Revocation prevents future
acceptance and publication but does not rewrite signatures on retained
evidence. A trusted replica verifies through the same pinned authority record
and cannot substitute its own key.

The target derives no identity from email equality, local path, hostname, Git
remote, Project name, or client-supplied database identifier. It accepts a
segment only after authenticating the relationship, decrypting the envelope,
verifying the origin signature, and matching the signed plaintext digest.
Repeated delivery of the same signed content identity is idempotent even when
the outer ciphertext differs. Different valid origin-signed content for the
same logical source, generation, and segment index is origin equivocation. It
quarantines the generation and withdraws any derived rows from new display,
Recall, Share Grant publication, and LCM processing until an Operator resolves
the conflict.

### Active Segment Replication

The local journal seals complete provider records into bounded immutable
segments during active execution. A foreground Capture Hook, app-server event,
or prompt submission never waits for network transfer.

The default active-source recovery-point objective seals at the first complete
record after any of:

- 1 MiB of unsealed source;
- 128 unsealed provider records; or
- five seconds since the first unsealed record.

Deployments may publish stricter compatible limits. A provider record is never
split solely to meet these thresholds. An individually oversized record is
stored as one bounded exceptional segment and remains subject to the protocol's
absolute record and artifact limits.

The local sequence is:

1. Durably append complete provider bytes to the local journal.
2. Persist the local journal checkpoint and canonical-ingestion work.
3. Add or coalesce a durable source-replication outbox entry.
4. Continue local canonical ingestion, Projection, and realtime delivery.
5. Let a background worker upload missing sealed segments.

An open segment is never acknowledged remotely. Session finalization seals the
remaining complete records and creates an origin-signed deterministic closure
manifest binding the final segment count, total byte and record ranges, final
chain head, and source root digest. Closure is terminal for that generation.
Closing a Conversation is not required before earlier sealed segments can be
uploaded, ingested, displayed, projected, or embedded remotely.

### Package And Transport

The protocol uses:

- a strict versioned manifest with unknown-field rejection;
- opaque deployment, User, device, logical source, replica, and relationship
  identifiers;
- monotonically ordered segment indexes and exact source byte/record ranges;
- plaintext and ciphertext digests;
- previous-segment digest linkage;
- canonical source-format and adapter-version metadata;
- bounded chunk sizes and total artifact limits;
- resumable upload sessions and missing-chunk discovery;
- package, chunk, and operation idempotency keys;
- replay, reorder, truncation, decompression, and downgrade protection;
- a final closure manifest over the immutable ordered segment set.

Acceptance is one compare-and-swap transaction per segment. The target locks
the replica generation, verifies that the index, predecessor, byte start, and
record start exactly extend its contiguous head, inserts the accepted content
identity, advances the head, and writes durable work atomically. Closure is
accepted only at that head and permanently rejects later append. Gaps remain
pending; overlaps, divergent predecessors, and post-closure append fail
permanently.

Every mutation carries a scoped idempotency key and canonical request digest.
The scope includes relationship, logical source, generation, operation family,
and authenticated actor. The target atomically stores and replays the original
status and response for the same digest. Reuse with a different digest is a
permanent conflict.

Object-store publication is staged. The target writes ciphertext under an
unpublished staging reference, verifies it, commits the accepted segment row
and final immutable object reference in one database transaction, then exposes
it to materialization workers. Retries may adopt a verified staged object. A
sweeper removes unreferenced staging objects; committed rows never reference
missing or mutable objects.

TLS is mandatory but insufficient. Remote/commercial bytes use the existing
encrypted package and envelope-provider boundary. Managed deployment profiles
use their accepted KMS, BYOK, or CMEK posture. A private test deployment may
use the explicitly labelled operator-managed test-key mode. Plaintext source,
raw Data Encryption Keys, provider credentials, repository credentials, local
paths, object-store credentials, and sensitive manifest text never enter
PostgreSQL operational rows, queues, logs, metrics, traces, diagnostics,
support surfaces, or object keys.

The source authenticates through a scoped, revocable upstream device
credential. The credential identifies the device; it does not cache current
User, policy, lifecycle, or authorization. The target rechecks those records
inside every mutating transaction.

### Cursors And Readiness

Every cursor is a versioned claim over:

```text
logical source + generation + stage + processing epoch
+ contiguous segment index + chain head + byte end
```

The source generation and chain head make a cursor unusable against a divergent
or restored stream. The processing epoch distinguishes reprocessing without
changing immutable source identity. The following stage cursors remain
independent:

- local provider-to-journal cursor;
- local canonical-ingestion cursor;
- local replication outbox cursor;
- remote accepted-byte cursor;
- remote verified-segment cursor;
- remote canonical-ingestion cursor;
- remote Projection cursor;
- remote Memory Event embedding readiness;
- remote LCM readiness;
- authorized device download cursor.

An acknowledgement advances only the boundary it proves. Remote byte
durability cannot imply canonical ingestion. Canonical ingestion cannot imply
Projection or semantic readiness. LCM readiness is never required for exact
source durability.

Cursor updates compare-and-swap against the prior cursor and never move
backwards. Replaying an old backup cannot lower a lifecycle floor, policy epoch,
source generation, chain head, or processing cursor.

Remote status exposes only redacted identifiers, counts, byte totals,
timestamps, stage, freshness, retry state, and stable error codes. It does not
expose source text, prompts, tool output, paths, keys, credentials, or sensitive
manifest fields.

### Wake Delivery And Reconciliation

Committed replication, processing, and source-readiness changes write durable
outbox state in the same transaction as the product mutation. PostgreSQL
notifications and authenticated remote SSE are wake signals only. They prompt
the relevant worker or client to resume from its durable cursor; they are never
the source of truth and never advance a cursor themselves.

Continuous interval polling is not part of the normal synchronization or UI
path. A process performs bounded reconciliation when it starts, reconnects,
receives a wake signal, or reaches the persisted due time for retryable work.
SSE reconnect uses bounded exponential backoff with jitter, then resumes from
the last committed cursor. Missed, duplicated, reordered, or expired wake
delivery therefore changes latency only: durable cursor reconciliation remains
the correctness mechanism.

### Remote Materialization

After complete encrypted bytes are durable, the target:

1. rechecks target User, device lineage, relationship, policy, lifecycle, key,
   and package compatibility;
2. verifies the transport envelope, decrypts only the selected package, and
   verifies the origin-signed content manifest;
3. verifies the strict manifest, segment hash chain, contiguous ranges, record
   boundaries, and closure where present;
4. materializes the exact Conversation Source Artifact through the configured
   object-storage abstraction;
5. invokes the same provider source adapter and canonical ingestion boundary
   used locally;
6. derives target-local Projection, Memory Events, embeddings, indexes, graph
   state, and LCM work;
7. publishes each readiness cohort only when its own atomic visibility
   contract is satisfied.

Remote object bytes never bypass canonical ingestion. Projected rows,
embeddings, vectors, Memory Nodes, and summaries are deployment-local derived
data and are not source replication primitives.

Publication records retain the source generation and signed chain head from
which they were derived. Origin equivocation, source revocation, deletion, or
failed re-verification atomically makes affected derived rows unavailable to
display, Recall, Share Grants, and downstream summarisation before asynchronous
cleanup begins.

### Personal Device Download

Raw-source discovery and download require a fresh authenticated User operation,
step-up authentication where supported, proof of possession of an enrolled
device signing key, and a scoped short-lived download grant. Browser session
authentication or an API Token alone is insufficient. The server rechecks
device, User, relationship, policy epoch, lifecycle, and source scope before
each read and decrypt.

The server re-encrypts origin-signed segment content to the enrolled device's
X25519 recipient key. It never returns a hosted Data Encryption Key or
long-lived plaintext URL. A download grant binds source generation, allowed
contiguous range, recipient key, expiry, and operation id.

The device verifies protocol version, identity, ranges, digests, ordering, and
closure before materializing the source into its local Koed source storage.
Local canonical ingestion and derived processing then use the normal source
adapter. The device must not create a second Captured Session or duplicate
canonical source rows for a logical source it already holds.

Hosted source availability permits complete Conversation viewing, deterministic
reprocessing, and preparation for execution portability. It does not itself
authorize or prove provider-session continuation or repository/worktree
availability.

### Offline And Failure Behavior

Remote outage, stale capability metadata, revoked credentials, key-provider
failure, or upload backpressure never stops eligible local capture, local
journalling, local Projection, or local Recall. Replication pauses visibly and
retries from durable cursors with bounded exponential backoff and jitter.

Worker crash, process restart, duplicate signal, reordered request, and lost
response cause replay rather than loss or duplicate source. Authorization
uncertainty, incompatible format, digest conflict, unknown source generation,
or decryption failure quarantines the affected replica and fails closed.

An origin that disappears with an open generation leaves a durable incomplete
prefix. The backend never invents records or closure. That prefix may be viewed
and processed only with an explicit incomplete-source label and cannot support
same-Conversation execution handoff.

Hosted account recovery may authorize enrollment of a new device according to
deployment policy, but it does not recover Personal Device Sync group keys. PDS
recovery requires an existing group device or an explicit PDS recovery
mechanism.

### Lifecycle And Deletion Floors

Policy pause stops future transfer without deleting accepted bytes. Sync
revocation rejects new upload and download grants. Device revocation rejects
that device immediately. Replica removal deletes one physical replica without
changing the logical source. Personal deletion and legal hold are independent;
hard purge occurs only when no hold or retained Personal policy applies.

Lifecycle decisions use a monotonically increasing policy-admission epoch and
server-owned lifecycle sequence, never client wall-clock ordering. The backend
stores a deletion/revocation floor in authority state excluded from ordinary
data rollback. Restored backups and stale devices cannot upload, download,
re-publish, or re-materialize source below that floor. Purge writes a tombstone
before removing object bytes, manifests, derived rows, and wrapped keys.

Backup and restore procedures preserve or advance the authority floor. A
deployment unable to prove that invariant remains read-only until an Operator
reconciles authority state.

### Relationship To Personal Device Sync

Hosted Personal source replication and Personal Device Sync may share proven
source closure, chunking, hashing, outbox/inbox, anti-entropy, and local
materialization components. Their protocols and trust models remain distinct:

- the hosted Personal backend is authorized to decrypt source for canonical
  processing under the commercial encryption boundary;
- the PDS relay and authority cannot decrypt source;
- hosted replication supports active sealed segments;
- PDS V1 transfers only closed source packages;
- hosted replication has one selected processing target;
- PDS distributes each eligible package symmetrically to every active group
  device.

No implementation silently reinterprets one protocol as the other.

Exact origin-signed content identity is the convergence key across hosted
replication, direct peer transfer, Personal Device Sync, historical import, and
device download. A trusted replica may re-serve exact signed bytes under a new
recipient-specific outer envelope, but cannot re-author, renumber, or replace
the origin-signed content.

### Relationship To Team Memory

Hosted Personal synchronization creates remote Personal source and derived
Personal Memory. Team visibility still requires an active Share Grant plus
current Team Membership, Workspace Access, lifecycle, retention, and
entitlement checks. Revoking Personal synchronization and revoking Team access
are separate operations with separate retention outcomes.

Share Grants authorize only eligible, ready derived Memory. They never
authorize raw-source discovery, decryption, download, execution, or workspace
snapshot access. Team, Workspace, Membership, and Share Grant identifiers do
not enter Personal source recipients, object keys, KMS context, or source
download authorization.

## Consequences

- Koed gains a durable Personal cloud source boundary without multi-primary
  database replication.
- Active Conversations can become remotely durable and visible while work
  continues locally.
- A new authenticated device can reconstruct exact Conversation source and
  derive local Personal Memory.
- Storage and processing costs increase because each processing backend derives
  its own semantic data.
- Exact source replication increases the sensitivity of hosted storage and
  requires strict envelope encryption, retention, deletion, backup, and support
  treatment.
- Executable continuation still requires the separate execution-handoff and
  development-workspace decisions.

## Rejected Alternatives

- PostgreSQL physical or logical replication between personal devices and
  hosted deployments.
- Treating canonical Memory Events or projected rows as a complete transcript.
- Waiting for Session closure before any hosted durability.
- Uploading source because a Team Workspace link or Share Grant exists.
- Making a hosted replica a second mutable writer.
- Reusing the PDS relay as a decrypting hosted processing backend.
- Copying provider, repository, API, browser, device, or KMS credentials with
  source data.

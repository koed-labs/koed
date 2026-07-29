# Self-Hosted To Hosted Sync

Status: Implemented for explicitly selected Captured Sessions.

This document defines the V1.0 direction for moving selected memory from a
self-hosted Koed deployment into a hosted Team-personal identity without
creating accidental forks, hidden ownership transfers, or ad hoc database
migration paths.

## Product Decision

The default path is Cross-Identity Live Sync, not one-time import.

V1 is a directed local-personal-to-hosted flow. It is not symmetric [Personal
Device Sync](personal-device-sync-protocol.md), a peer replication protocol, or
a mechanism for downloading one device's Personal Memory into another device's
local database.

Cross-Identity Live Sync means the selected memory keeps one logical lifespan
while becoming available across identities or deployments. A self-hosted source
can synchronize selected memory to a Team-personal target so the hosted side can
index, recall, and share the last synchronized state. The source deployment
remains the origin of truth unless the User later performs an explicit
Fork/Import operation.

Fork/Import is a separate future operation. It intentionally creates a new
memory lifespan that can diverge from the source. Koed should not use import
language, copy semantics, or mutable Team-personal replicas for normal
self-hosted to hosted sharing because that creates accidental forks and unclear
ownership.

## Scenario

Bob has used self-hosted Koed on his own infrastructure. Later, Bob joins
Company A, which runs Koed Team in the hosted service. Bob now has two
identities:

- Bob's self-hosted personal identity.
- Bob's Company A Team-personal identity.

When Bob wants selected personal memory to become usable in Company A, the
self-hosted deployment should package and sync that selected memory to Bob's
Team-personal identity. Company A can then receive Team Workspace access only
to the synchronized state that Bob has consented to share.

If Bob continues working in the self-hosted source, new source changes can sync
forward. If the source device is offline, Company A sees only the last
synchronized state and the hosted UI should make the stale/synced status clear.

## V1.0 Boundaries

V1.0 should support the Cross-Identity Live Sync contract and data model. The
first implementation may ship in stages, but the architecture should not rely
on raw database replication or implicit import.

Required V1.0 decisions:

- Source of truth: the self-hosted deployment remains the origin.
- Target: the hosted Team-personal identity receives a policy-aware replica.
- Mutability: the Team-personal replica is read-only for memory evolution.
- Sharing: Team Workspace grants can expose only synchronized and processed
  memory already present on the hosted side.
- Offline behavior: local Personal Memory remains available while transfer is
  unavailable. The target may retain the last synchronized state, but stale or
  partially processed replicas are excluded from Recall until they are ready
  again.
- Revocation: sync revocation stops future propagation; it does not
  automatically revoke existing Workspace shares or hard-delete retained data.
- Forking: any independently evolving target memory must be created through a
  future explicit Fork/Import operation.
- First selectable source boundary: Captured Session only. Project-wide,
  date-range, explicit Memory Node, and all-Personal-Memory sync are later
  expansions because they need separate closure, consent, and retention rules.
- Freshness: synchronized memory becomes stale when the sync relationship's
  `stale_after` timestamp has passed. Stale replicas remain retained but cannot
  influence Recall, ranking, graph expansion, citations, reranking, or Evidence
  Bundles until a successful package makes them ready again.
- Hosted processing outputs: the hosted side validates package provenance and
  may reuse source projection metadata, but hosted indexing owns the target
  processing cursor and rebuilds or verifies derived search artifacts under the
  target deployment's authorization and encryption policy.
- Transfer path: V1.0 uses chunked, resumable application-level upload
  sessions. Object storage is an implementation detail used when package size
  or deployment topology requires it; raw database replication is not the
  product primitive.
- Support diagnostics: failed sync support views may expose redacted package,
  cursor, checksum, state, and error-code metadata only. Raw Memory, source
  payloads, embeddings, package bytes, and provider credentials require the
  normal hosted support/break-glass policy before access.

## Architecture Principles

- Use an application-level sync package, not PostgreSQL replication as the
  product primitive.
- Preserve one logical memory lifespan unless the User explicitly forks.
- Treat sync as asynchronous and resumable.
- Upload and verify bytes first; then validate, transform, project, embed,
  index, and load on the hosted side.
- Keep provenance first-class across the sync boundary.
- Make sync state visible to Electron, hosted UI, and support/admin views.
- Do not let the Team-personal replica accept direct memory-evolution writes.
- Keep Team Workspace sharing separate from Cross-Identity Sync. Sync makes the
  target identity current enough to share; Share Grants decide which
  synchronized memory is visible in a Workspace, and Team Membership plus
  Workspace Access decide which callers can recall it.

## Sync Package Shape

A sync package should be a signed or checksummed application-level bundle with
versioned manifests and byte payloads. It should be safe to upload in chunks,
resume after failure, and process idempotently.

Sync/offload packages must use the shared encrypted package envelope. The
upload-session manifest is the redacted encrypted package manifest only; it may
carry object class, checksum, byte count, provider/key metadata, timestamps,
scope, and consent/provenance references. It must not carry raw Memory, source
payloads, credentials, plaintext-equivalent vectors, raw DEKs, wrapped DEK
ciphertext, or object-storage credentials. If the envelope provider cannot
encrypt or decrypt the package, package creation, intake, and restore must fail
closed.

Before accepting package bytes, the target validates a strict upload-manifest
contract containing only the `sync_package` object class, protocol format and
format version, package digest, recipient key ID and version, and bounded
canonical record count. Missing or unknown fields, unsafe metadata, unsupported
versions, and counts outside protocol bounds are rejected before an upload
session is created. The authenticated record count is checked again after
decrypting the package.

The V1 Captured Session package contains:

- Package manifest:
  - package format version.
  - source deployment ID.
  - source identity ID.
  - target identity ID.
  - stable package and sync relationship IDs.
  - created-at timestamp.
  - source software version.
  - package checksum.
  - authenticated canonical record count, verified again after target decrypt.
- Consent record:
  - consenting user.
  - selected memory boundary.
  - target Team-personal identity.
  - retention and revocation acknowledgement.
  - timestamp.
- Logical memory identity:
  - source logical memory ID.
  - target replica ID.
  - sync relationship ID.
  - source and target replica IDs.
- Source data:
  - selected Captured Session metadata.
  - canonical Memory Events and their permitted whole-item contributors.
  - source timestamps and ordering cursors.
- Processing data:
  - canonical event revision hashes and invalidation/delete operations.
  - metadata needed to preserve semantic item type and LCM eligibility.
- Sync cursors:
  - one monotonic semantic-change high-water mark for the selected session.
  - cursors may contain global sequence gaps and are not used as record counts.
  - idempotency keys.
  - last exported source sequence.
- Integrity data:
  - chunk checksums.
  - total byte count.
  - content hashes for deduplication.

Source embeddings, Memory Nodes, LCM Summaries, raw transcripts, and unrelated
Project or Personal Memory data are not synchronized. The target rebuilds
queryable vectors, indexing, LCM nodes, evidence links, and graph state through
the existing target processing paths.

## State Machine

Recommended sync states:

- `pending`: sync relationship exists but no package has been uploaded.
- `uploading`: the source is transferring chunks.
- `uploaded`: all bytes are present and checksum verification can run.
- `verified`: package integrity has passed.
- `processing`: hosted jobs are validating, transforming, projecting, and
  indexing.
- `partially_available`: canonical records are applied but target embedding,
  indexing, LCM, or derived-memory invalidation work is still running. This
  state is not recallable.
- `ready`: hosted replica is current to the latest processed cursor.
- `stale`: source has not synced within the expected freshness window.
- `failed`: processing failed and requires retry or user intervention.
- `revoked`: future sync is stopped.
- `purge_pending`: hard deletion has been requested and retention policy allows
  purge later.

State transitions must be idempotent. Retrying an upload, validation job, or
projection job must not duplicate memory or create another logical lifespan.
Hosted processing cursors belong in hosted upload-session and sync-relationship
persistence. The source package carries source cursors only, so target-side
resume state cannot be advanced or rewound by package payload data.

Relationship creation uses a two-phase handshake. The source first retrieves
the authenticated target deployment, User, replica, and recipient-key context;
then persists a paused local relationship; then creates the target relationship
idempotently; and only then activates its durable outbox. Package transport
cannot begin from a remote-only relationship.

The persistence model is intentionally explicit:

- `deployment_identities` identify source and target Koed deployments.
- `logical_memories` represent the one memory lifespan that must not fork
  accidentally.
- `memory_replicas` represent physical source and target copies of that logical
  memory.
- `cross_identity_sync_relationships` record sync/offload policy, consent,
  cursor, revocation, and state.
- `sync_package_upload_sessions` and `sync_package_chunks` make large package
  upload resumable and checksummed.
- `sync_outbox_entries` and `sync_inbox_entries` make source and target
  processing durable instead of ad hoc request forwarding.

V1.0 supports `captured_session` as the first source boundary. Project-wide or
global Personal Memory sync must be added deliberately later with its own
policy and closure rules.

## Large Transfer Flow

For large memory sets, the User should wait only for transfer and verification,
not for all hosted processing.

Recommended flow:

1. Electron or CLI asks the self-hosted API to prepare a sync export.
2. The source creates a manifest and chunk plan.
3. The hosted API creates an upload session and returns chunk upload targets.
4. The source uploads chunks with checksums.
5. The hosted API verifies the complete package.
6. The hosted API acknowledges receipt and moves the job to asynchronous
   processing.
7. Hosted workers validate, transform, project, embed, index, and load.
8. The Team-personal identity shows `partially_available` while processing and
   `ready` only after the atomic visibility boundary is complete.
9. A Share Grant can be created only for a ready synchronized session. Recall
   also rechecks readiness, freshness, membership, Workspace Access, lifecycle,
   and entitlement state on every request.

This keeps the user experience bounded by network transfer for large packages
while allowing cloud processing to continue in the background.

## Identity And Mapping

The sync contract must distinguish all of these identifiers:

- Source deployment ID: the self-hosted instance that produced the package.
- Source identity ID: the User identity inside the source deployment.
- Target User ID: the hosted User receiving the replica.
- Target Team-personal identity ID: the hosted personal memory space attached
  to the User in a Team context.
- Team ID: the Company/Team collaboration boundary.
- Workspace ID: the stable shared memory boundary for Team recall.
- Project metadata: local repo/path/ref/cwd context, never the durable
  authorization key.

Mapping must be explicit and auditable. A package should not be accepted merely
because two email addresses match.

Target intake authorizes the receiving User, enrolled device lineage, external
principal mapping, package tenant binding, and sync policy. It does not apply a
Team entitlement before decrypt because the replica is still Team-personal and
has no Team or Workspace scope. Team entitlement, Membership, Workspace Access,
and Share Grants are separate request-time checks when that ready replica is
later shared or recalled through a Team Workspace.

On the target, each sync relationship is bound to the exact enrolled source
device lineage that created it. A credential for another device owned by the
same User does not inherit access to that relationship. A replacement
credential may continue it only through an authenticated rotation request that
proves the active credential being replaced. Reusing the client-supplied device
instance identifier does not prove lineage. The target assigns the opaque
lineage identifier, and the first relationship permanently binds that lineage
to one source deployment identity; later requests cannot use it to claim
another source deployment. Every target intake mutation rechecks the presented
credential's owner, expiry, revocation state, and `sync` operation family inside
the same database transaction that changes sync state.

The same mapped User may verify another enrolled device and create a separate
sync relationship from that device. Re-verification rotates the principal's
recorded proof reference only when the local and external principal mapping is
unchanged; a proof already associated with that principal cannot be reused to
claim a different external principal. Each relationship still retains its own
exact device-credential binding and revocation lifecycle.

This is multi-device source participation, not bidirectional local database
replication. Each device keeps its own local Personal Memory and may push
explicitly selected Captured Sessions to the target. The hosted replica can be
recalled from authorized devices, but V1 does not automatically download one
device's local Memory Events into another device's local database. A future
pull protocol would need explicit cursor, conflict, deletion, key, retention,
and offline semantics before it could add that behavior.

Queue claims use a unique claim token plus a bounded lease. Completion, retry,
failure, and lease renewal require the current token, so an expired worker
cannot overwrite a replacement worker's result. If a worker disappears on its
final allowed attempt, lease recovery first reconciles an already-committed
source acknowledgement or target-ready package. Otherwise it fails ordinary
work through the same relationship and upload failure path instead of
stranding it in processing. Revocation delivery is reset and reclaimed because
it must continue retrying until acknowledged. Relationship or credential
revocation prevents new target mutations; relationship revocation also cancels
active queue claims and fails unfinished uploads.

Ready relationships use authenticated durable heartbeat outbox entries when no
semantic changes are pending. A heartbeat may refresh freshness only when its
acknowledged source cursor, target processing cursor, package sequence,
relationship, principal, and enrolled credential lineage still match. It
cannot carry Memory or advance processing state.

## Consent And Privacy

Before any upload leaves self-hosted infrastructure, Koed should present a clear
consent step explaining:

- which memory boundary will sync.
- which hosted identity receives the replica.
- whether the target Team can later receive Workspace access.
- that only synchronized data can be shared.
- that revoking sync stops future propagation.
- that Workspace share revocation is separate from sync revocation.
- what retention policy applies after personal deletion, Team exit, or User
  tombstone.

Consent should be recorded in the sync package and in the hosted audit log.

## Revocation And Retention

Cross-Identity Sync revocation stops future synchronization from the source to
the Team-personal target. It does not automatically:

- delete the self-hosted source memory.
- revoke existing Team Workspace Share Grants.
- hard-delete hosted retained replicas.
- create a fork.

Workspace share revocation controls Team visibility. Personal deletion controls
the owner's Personal Memory surface. Team retention policy controls whether
already-shared synchronized data remains available to authorized Team members.

These are separate lifecycle operations and should remain separate in schema,
API, audit, and UI.

## Unsupported Or Deferred

Deferred from the V1.0 implementation unless explicitly prioritized:

- Bidirectional sync.
- Direct Team-personal mutation of synchronized memory.
- Raw PostgreSQL logical replication as the user-facing migration primitive.
- Automatic sync based only on email matching.
- Conflict resolution for two active writers.
- Explicit Fork/Import.
- Full hard-purge automation across source and hosted deployments.

## Operation

### Upgrade from the foundation scaffold

The production Cross-Identity Sync protocol replaces the earlier metadata-only
foundation schema. Its migration resets only the old sync identity, replica,
relationship, queue, upload, and chunk rows because those rows lack the
recipient-key and cursor bindings required to prove a valid encrypted transfer.
Users, Captured Sessions, Memory Events, and Team Share Grants are retained.
Existing sync relationships must be enrolled again after the upgrade.

Cross-Identity Sync runs as durable source outbox and target inbox work. A
source signal coalesces changes for one relationship, packages only canonical
changes after the acknowledged cursor, encrypts bounded chunks to the target's
active recipient key, and resumes against the target upload status. The target
verifies the complete encrypted upload before queuing intake, decrypts only
after authorization and identity binding, applies canonical changes atomically,
and runs existing embedding and LCM paths before marking the replica ready.
The source remains `processing` and polls redacted target state without
consuming transport retry attempts; it advances its acknowledged cursor and
becomes `ready` only when the target relationship is `ready` (or subsequently
`stale`) and its processing cursor covers the package cursor. Upload
`completed` means canonical apply finished; it is not evidence that target
embedding, indexing, and LCM readiness finished.

Permanent policy, authorization, schema, identity, or payload failures fail the
relationship closed. Network, rate-limit, and server availability failures use
bounded retry with backoff and jitter. New source changes reset a terminally
consumed coalescing signal and continue from the durable acknowledged cursor.
Target retries reuse an existing embedding only when its source hash, model,
dimensions, version, vector rows, and complete chunk set match the current
canonical source. Partial or stale embeddings are regenerated.

Inbox work already covered by a strictly newer accepted package is completed
as an idempotent no-op. This reconciliation happens before claim when possible
and is repeated transactionally at failure time to cover races. An obsolete
package cannot regress a newer ready relationship or its replica to `failed`.
After a target package becomes ready, active continuous Share Grants advance
through their existing exact consent and policy bindings; snapshot grants do
not advance.

Operational status exposes queue depth and age, retries, redacted failure
class, ready/stale/failed/revoked counts, bytes and records completed in the
last hour, and source/target record lag. It never exposes package content,
customer identifiers, credentials, or key material.

Capability discovery reports Cross-Identity Sync as available only while the
target worker has a recent database heartbeat and application-layer encryption
is available. A local source additionally requires a fresh cached upstream
capability descriptor that explicitly advertises `memory.crossIdentitySync` as
available; a fresh cache timestamp alone is insufficient.

## Launch Decisions

- V1.0 starts with Captured Session sync as the only selectable source
  boundary.
- Staleness is controlled by explicit sync relationship state and
  `stale_after`, not by inference from UI activity.
- Target-side processing cursors are authoritative for hosted projection,
  embedding, indexing, and retry state.
- Stale, failed, paused, processing, and partially available replicas do not
  influence Recall.
- Chunked upload sessions are the API contract. Object storage can back large
  uploads, but clients should not depend on a specific storage provider.
- Failed sync diagnostics are redacted operational metadata unless a separate
  scoped support/break-glass workflow is approved.

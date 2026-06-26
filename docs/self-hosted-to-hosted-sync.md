# Self-Hosted To Hosted Sync

Status: Draft planning document.

This document defines the V1.0 direction for moving selected memory from a
self-hosted Koed deployment into a hosted Team-personal identity without
creating accidental forks, hidden ownership transfers, or ad hoc database
migration paths.

## Product Decision

The default path is Cross-Identity Live Sync, not one-time import.

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
- Offline behavior: hosted recall can use the last synchronized state with a
  stale marker.
- Revocation: sync revocation stops future propagation; it does not
  automatically revoke existing Workspace shares or hard-delete retained data.
- Forking: any independently evolving target memory must be created through a
  future explicit Fork/Import operation.

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

Minimum package contents:

- Package manifest:
  - package format version.
  - source deployment ID.
  - source identity ID.
  - target identity ID.
  - export job ID.
  - created-at timestamp.
  - source software version.
  - package checksum.
- Consent record:
  - consenting user.
  - selected memory boundary.
  - target Team-personal identity.
  - target Team, where known.
  - retention and revocation acknowledgement.
  - timestamp.
- Logical memory identity:
  - source logical memory ID.
  - target replica ID.
  - sync relationship ID.
  - parent/source lineage.
- Source data:
  - Captured Sessions.
  - Memory Events.
  - Memory Nodes and source links only when they are filtered or rebuilt from
    the selected source closure.
  - raw conversation/projection metadata required to rebuild derived memory.
  - Project metadata as local context only.
  - source timestamps and ordering cursors.
- Processing data:
  - projection versions.
  - embedding model metadata, if reused.
  - LCM Summary metadata, if synchronized.
  - invalidation and personal deletion markers.
- Sync cursors:
  - high-water marks per source table or source stream.
  - idempotency keys.
  - last exported source sequence.
- Integrity data:
  - chunk checksums.
  - total byte count.
  - content hashes for deduplication.
  - manifest signature or future signing hook.

## State Machine

Recommended sync states:

- `created`: sync relationship exists but no package has been uploaded.
- `uploading`: the source is transferring chunks.
- `uploaded`: all bytes are present and checksum verification can run.
- `verified`: package integrity has passed.
- `processing`: hosted jobs are validating, transforming, projecting, and
  indexing.
- `partially_available`: the package has been fully uploaded and verified, and
  some synchronized memory can be recalled while later hosted processing jobs
  continue.
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
8. The Team-personal identity shows `partially_available` or `ready`.
9. Team Workspace sharing can expose only synchronized memory with an active
   Share Grant and a recallable processing state.

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

## Follow-Up Implementation Tickets

Backend/API:

- Define `cross_identity_sync_relationships` and upload-session persistence.
- Add source deployment, source identity, target identity, logical memory, sync
  cursor, state, consent, and revocation fields.
- Add hosted sync package intake endpoints.
- Add sync package validation, idempotency, and manifest versioning.
- Add processing jobs for transform, Projection, embedding, and indexing.

Self-hosted source:

- Add export package creation for selected memory boundaries.
- Add chunked/resumable upload support.
- Add checksum and manifest generation.
- Add local progress and retry status.

Electron/CLI:

- Add consent UX.
- Add source-to-target identity connection flow.
- Add transfer progress, stale status, retry, and revocation controls.
- Show that Team-personal replicas are read-only from a memory-evolution
  perspective.

Hosted Team:

- Show sync state and provenance on Team-personal memory.
- Allow Team Workspace sharing only for synchronized and processed memory.
- Surface stale/partially available/ready states in recall and UI.

Docs/support:

- Explain Cross-Identity Sync vs Fork/Import.
- Explain offline/stale behavior.
- Explain revocation and retention boundaries.
- Explain that unsupported one-time database migration is not the product path.

## Open Questions

- Which source boundaries are selectable in the first implementation: Captured
  Session, Project, date range, explicit Memory Nodes, or all Personal Memory?
- What freshness threshold and UI treatment should mark synchronized memory as
  stale while still allowing recall of the last synchronized state?
- Which hosted processing outputs are reused from the package versus rebuilt in
  cloud?
- What is the maximum package size before requiring cloud object storage rather
  than direct API upload?
- What support/admin tooling is needed to diagnose failed sync without exposing
  Memory content?

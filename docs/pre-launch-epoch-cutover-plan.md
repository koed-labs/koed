# Pre-launch Epoch Cutover and Validation Plan

Status: implementation plan for [ADR 0026](adr/0026-pre-launch-schema-reset-and-processing-epochs.md). This document specifies work; it does not perform reset, migration, rename, or rebuild.

## Cutover gates

No profile activates clean release-V1 processing names until all applicable implementation issues provide:

1. generation-aware compatibility identities and bounded active/candidate/previous registry state;
2. deterministic stale detection and generation-aware key/query support;
3. resumable Source-cohort rebuilds;
4. resumable LCM-cohort rebuilds, including the durable summary-to-node-embedding handoff;
5. exact-compatible retrieval/reranking gates;
6. minimal status, lag, retry, failure, and rollback-preflight surfaces;
7. backup/restore reconciliation for retained generations and lifecycle high-water state;
8. source/payload/protocol negotiation and coarse derivation readiness for remote paths.

Activation evidence records release commit, migration revision, generation-set revision, active/candidate/previous manifests, fence high-water, approved reset/preservation scope, backup proof, and validation revisions. Secrets and Memory content are excluded.

## Common preconditions

1. Confirm target profile, database, `KOED_HOME`, object/package stores, queue backend, upstream relationships, and current migration revision.
2. Classify the database explicitly as `disposable_alpha` or `preserve_canonical`. Unknown classification aborts.
3. Verify installed release assets and retained old/new prompt bundles, immutable model revisions/provider-verifiable fingerprints, settings, tokenizers, and implementation manifests needed for candidate build and rollback. A mutable alias alone blocks LCM candidate processing and publication.
4. Create encrypted Postgres and required non-derivable local-state backups. Verify archive integrity and key access.
5. Export redacted pre-cutover status: canonical counts/hashes by scope, lifecycle floors, sync cursors, current generation-set revision, capability-schema-6 collaboration/realtime status, versioned collaboration audience/receipt state, Team Presence state, pending/settled authorization state, coverage state, queue state, and backup proof.
6. Confirm disk and capacity headroom for bounded active/candidate/previous coexistence and AI Client-backed LCM rebuild.

## Data classification

### Preserve

- Users, identity mappings, API Token verifier rows, device identity, credentials, encryption references, and lifecycle state only for `preserve_canonical`.
- Teams, Team Membership, Team Presence preferences and accepted human-activity timestamps, Workspaces, Workspace Access, Share Grants, Capture Policy/Pause, collaboration audience snapshots, Team Chat Message audience bindings, receipt cursors, and audit state.
- Captured Sessions, canonical conversation items/observations, source identities/hashes/order/timestamps, historical import checkpoints, sync lineage, and durable source packages.
- accepted Curated Memory assertions, review decisions, provenance, and evidence roles. Before derived invalidation, export each evidence pointer with its stable canonical source identity/closure/hash and old derived ID so it can be rebound exactly;
- Local-Edge Client Credential and upstream device credential custody references only after exact deployment/principal binding verification. Do not copy, derive, or silently regenerate reusable credentials as part of the processing reset; verification failure requires the owning enrollment, rotation, or revocation flow.
- PDS governance state: Personal Device Group/User subjects, members, signed statements, Key Bundles, membership certificates, Personal Sync Policy, Remote Account Links, freeze/quarantine state, audit, and high-water state. Preserve fixed V1 Authority/Relay operational-host topology. Frozen `koed/pds/v1` source manifests/package bytes remain unchanged; the full current Drizzle journal is applied separately.
- Immutable signed `koed/pds-artifact/v1` records: encrypted envelopes, manifests, artifact class/schema, source bindings, ordered content/payload hashes, compatibility contracts/hashes, and semantic-work claim provenance. Preserve transport bytes without rewriting them; artifact import/materialization remains derived and reusable only after exact contract validation.
- Settled high-risk approval and source-download authorization audit records where retention requires them. Pending Action Grants, browser confirmations, and source-download authorizations are not preserved as live authority: revoke or allow them to expire, then require a fresh exact action with current authorization, credential, lifecycle, and operation binding.
- Final `mcp_memory_answer` Memory Questions and their encrypted companions according to retention policy. These are completed Local AI Runtime results, not a resumable processing queue.

### Invalidate and rebuild

- local Projection outputs and locally generated Memory Events when retained raw source is authoritative;
- Memory Nodes, LCM Placeholders, LCM Summaries, and rollups;
- embeddings, vector partitions, auxiliary indexes, graph-derived state, caches, readiness aggregates, and local materializations of PDS artifacts that fail candidate exact-contract validation; immutable PDS artifact transport records remain preserved;
- old rebuild or handoff jobs that do not carry target generation identity and closure state.

### Discard or regenerate

- Redis queue state, temporary files, smoke data, fixture databases, stale capability caches, and benchmark output;
- retired Explorer-origin Memory Questions, pending Memory Questions, processing leases, worker claims, and local worker configuration; migration `0026_amused_zeigeist` purges or removes this unsupported state rather than restoring it;
- disposable alpha databases in full, after required backup and confirmation.

## Required ordering

1. Pause release deployment and ensure no incompatible mixed binary is publishing derived rows.
2. Install binaries and both retained old/new processing assets without activating candidate processing.
3. Apply the complete current database revision through migration `0027_friendly_king_cobra`; seed clean release-V1 payload baselines and generation-aware registry support; invalidate capability caches for current alpha schemas `2`-`6`. Preserve the Shared Memory artifact-policy proposal semantics introduced by `0025_unique_marvel_apes`, do not recreate the retired Explorer or pending Memory Question state removed by `0026_amused_zeigeist`, and keep ADR 0027 capacity-contract identity separate from ADR 0026 embedding compatibility and generation publication.
4. Import preserved canonical records or create a clean database. Preserve frozen PDS source and artifact transport bytes unchanged; after source materialization, verify artifact signatures, source bindings, schema/class, and compatibility contract/hash before any local artifact import.
5. Reconcile encryption, lifecycle, authorization, versioned collaboration audience/receipt state, Team Presence state, Local-Edge Client Credential and upstream device credential bindings, sync high-water state, accepted Curated Memory evidence manifests, and retained PDS artifact disposition before any derived publish. Revoke or expire pending Action Grants, browser confirmations, and source-download authorizations rather than carrying them through as live authority. If event-only or node-only evidence lacks a provable stable canonical anchor/rebuild mapping, abort `preserve_canonical`; do not invalidate its source or mark its assertion suppressed.
6. Seed active generation manifests and create candidate generation manifests with one generation-set control row, monotonic transition revision, and bounded per-family `{ current, servable[] }` manifests. Install and route no more than the exact old/new processing and asset versions.
7. Run Source-cohort rebuild:
   - candidate Projection through stable scope batches;
   - candidate Memory Event embeddings from candidate Projection output;
   - generation-aware source links, invalidation, and read isolation;
   - deterministic old-to-candidate derived-ID mapping from stable source lineage for Curated Memory evidence.
8. Run LCM-cohort rebuild through the single `koed-server`-supervised Local AI Runtime for AI-client-backed summary work:
   - candidate LCM leaf placeholders and summaries from candidate Projection output;
   - bottom-up rollups only from compatible completed children;
   - durable `summary_ready -> node_embedding_pending` outbox/reconciler;
   - candidate Memory Node embeddings only from compatible completed LCM Summary text; placeholders remain internal pending-build state;
   - short-lived MCP adapters and Desktop/API processes do not own persistent synthesis queues; the Worker retains downstream Memory Event and Memory Node embedding ownership.
9. Open a database-level derived-write fence, record the canonical high-water, and continue canonical capture.
10. Catch active and candidate work up to the fence high-water. Rebind Curated Memory evidence to exact candidate Memory Event and Memory Node IDs while retaining old evidence links until replacement validation commits.
11. Validate Source cohort coverage and every applicable Curated Memory evidence remap through the fence high-water. Publish Source cohort by compare-and-set revision only if query policy and status can safely expose LCM as unavailable and pending without combining new Source evidence with old LCM evidence; otherwise continue to full monolithic publish.
12. Validate the LCM cohort as `complete_summary_ready`, the sole V1 publish target. Placeholder coverage may report internal build progress but cannot satisfy activation.
13. Execute the dependency-ordered LCM cohort compare-and-set activation against the same control revision, rechecking coverage predicates, retained manifests, and fence high-water; then complete the active/candidate/previous role swap and collapse the servable window. A monolithic policy performs the Source and LCM publication in one transaction instead.
14. Process the post-fence canonical suffix in the new active generation until bounded lag returns to zero or accepted steady-state bounds.
15. Refresh capability caches and resume sync publication only after local derivation readiness, authorization closure, and required release-V1 capability-schema-6 collaboration/realtime revalidation are complete.

Canonical capture remains open throughout supported generation transitions. Derived publication may continue before all historical rebuild finishes only when new canonical rows target the active generation and Recall isolates one coherent published cohort selection. Recall must never mix active and candidate rows or combine new Source evidence with old LCM evidence.

## Cohort readiness rules

### Source cohort ready

- every eligible canonical source at or below the fence high-water has candidate Projection coverage;
- every eligible Memory Event has exact-compatible embedding coverage or explicit policy exclusion;
- authorization and lifecycle closure are satisfied for all published rows;
- candidate rows are isolated from active Recall until activation;
- every accepted Curated Memory source that points to a rebuilt Memory Event has one exact candidate replacement or retained stable canonical anchor; missing or ambiguous replacement blocks activation.

### Internal LCM Placeholder coverage

- compatible deterministic LCM Placeholders may track candidate-build progress through the fence high-water;
- Placeholder text and embeddings are never published, ranked, or returned as Recall evidence;
- Placeholder coverage cannot satisfy LCM cohort activation;
- no complete parent rollup is built from placeholder children.

### LCM `complete_summary_ready`

- every required leaf has a schema-valid LCM Summary with the candidate prompt/model/settings/tokenizer/algorithm identity;
- every parent uses only compatible completed children;
- every output records the immutable model revision/provider-verifiable fingerprint bound by the candidate LCM compatibility identity; mutable alias equality never satisfies readiness;
- every accepted Curated Memory source that points to a rebuilt Memory Node has one exact candidate replacement or retained stable canonical anchor;
- exact candidate Memory Node embeddings exist for the node text being published;
- any legacy placeholder embeddings are invalidated and excluded; the candidate build does not create them;
- the summary-to-node-embedding outbox and reconciliation report zero required pending/failed rows unless an explicit exclusion policy exists.

## Profile runbooks

### Developer and CI

- default to `disposable_alpha`, but require explicit harness confirmation;
- drop/recreate database and Redis; preserve developer secrets outside reset;
- regenerate intentional V1 fixtures and baselines;
- rollback by discarding the test database and rerunning the prior commit.

### Local personal / Desktop alpha

- default to safe abort until the Operator confirms the exact database/home classification;
- for disposable alpha, reprovision the Local AI Runtime's API Token verifier state and atomically update Koed-owned local runtime configuration after reset;
- for approved preservation, validate canonical counts/hashes and rebuild locally in the required order;
- status exposes generation state, lag, retry, and rollback preflight only; rich transition controls stay out of launch scope.

### Private VPS and Team Self-Hosted

- treat as `preserve_canonical` unless the environment is an explicit launch fixture;
- keep canonical capture open where supported, but serve only the last complete published generation during transition;
- enforce authorization closure for every retained generation, not just the active one;
- rollback requires retained assets plus catch-up through a rollback fence.

### Koed-managed cloud

- execute per environment or tenant shard with verified backup, KMS proof, restore smoke, capacity budget, and rollback owner;
- keep encrypted package/object retention intact;
- canary internal or synthetic cohorts first;
- stop promotion if lag, coverage, lifecycle, or outbox repair thresholds fail.

### Launch staging and deterministic Team fixture

- disposable reset is expected after encrypted backup where launch policy requires evidence;
- regenerate fixture outputs only where contract changes are reviewed;
- validate retained Team knowledge, revoked/private boundaries, API Token personal-memory scope, and exact-compatible Recall.

## Failure, retry, and rollback rules

- Each cohort reports `pending`, `running`, `blocked`, `failed`, or `complete`, plus dependency reason and fence lag where relevant.
- Retry reuses deterministic job keys and does not duplicate canonical or derived rows.
- Source-closure or target-generation changes supersede stale work; old result cannot publish.
- AI Client outage or unavailable immutable model identity leaves candidate LCM work pending. Alias-only output is quarantined and cannot count toward coverage. There is no backend LLM fallback.
- A failure after summary persistence but before node-embedding enqueue must be repairable from the durable outbox/reconciler.
- Embedding artifact/tokenizer mismatch blocks vector generation and vector Recall for that cohort.
- Rollback may publish only a generation that is still complete, lifecycle-valid, asset-complete, and caught up through the rollback fence high-water.

## Validation matrix

| Scenario                                        | Required assertion                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean install                                   | One active generation-set revision exists; no stale rows or lost handoff jobs; capability and status agree; capture and Recall succeed.                                                                                                                                                                                                                                                                                              |
| Disposable alpha upgrade                        | Explicit confirmation and backup precede reset; local API Token verifier state is reprovisioned; managed local credentials are replaced.                                                                                                                                                                                                                                                                                             |
| Canonical-preserving upgrade                    | Canonical counts, identities, ownership, lifecycle, encryption, sync cursors, accepted Curated Memory assertions, and evidence roles match pre-cutover; every rebuilt evidence pointer maps exactly to candidate derived IDs before publish; unmappable evidence aborts without suppression.                                                                                                                                         |
| Bounded fence lag                               | Canonical capture remains open during the derived-write fence; Recall stays available; measured lag is bounded and later returns to zero.                                                                                                                                                                                                                                                                                            |
| Old/new coexistence                             | Active, candidate, and previous processing assets remain routable only for the bounded transition/rollback window; no accidental third version appears.                                                                                                                                                                                                                                                                              |
| Interrupted Projection rebuild                  | Retry resumes without duplicate Memory Events or source links; downstream coverage remains blocked until complete.                                                                                                                                                                                                                                                                                                                   |
| Interrupted LCM rebuild                         | Leaf retries are idempotent; completed compatible leaves are reused; parents wait for compatible completed children; no backend LLM fallback.                                                                                                                                                                                                                                                                                        |
| Lost LCM embedding enqueue                      | A failure after summary persistence but before enqueue is recovered by the durable outbox/reconciler; activation still fails closed until node embeddings are covered.                                                                                                                                                                                                                                                               |
| AI Client outage                                | Source cohort can still progress; LCM cohort remains unavailable and pending; status reports the reason.                                                                                                                                                                                                                                                                                                                             |
| Placeholder coverage                            | Placeholders report internal candidate-build progress only and are never published, embedded, ranked, or returned as Recall evidence.                                                                                                                                                                                                                                                                                                |
| Complete-summary readiness                      | Completed compatible leaf and parent summaries with one immutable model revision/fingerprint plus exact node embeddings are required before normal LCM publish; alias-only output cannot satisfy coverage.                                                                                                                                                                                                                           |
| No mixed-generation Recall                      | Recall sees either the complete old generation or the complete new generation, never a mix of Projection, LCM, or embeddings across generations.                                                                                                                                                                                                                                                                                     |
| Lifecycle propagation                           | Deletion, revocation, and authorization closure invalidate active and retained generations; rollback does not resurrect revoked Memory.                                                                                                                                                                                                                                                                                              |
| Collaboration, credential, and approval control | Versioned collaboration audiences, receipt cursors, Team Presence preferences, and accepted activity retain their authoritative meaning; Local-Edge Client Credential and upstream device credential custody is accepted only after exact deployment/principal verification; pending Action Grants, browser confirmations, and source-download authorizations never resume as live authority and require a fresh current-bound flow. |
| Stale rollback rejection                        | Previous generation cannot reactivate until retained assets exist and it catches up through the rollback fence high-water.                                                                                                                                                                                                                                                                                                           |
| Local/remote capability                         | Fresh compatible source/payload/protocol support is required; stale/unknown capability state fails before intake or Recall; release-V1 capability negotiation preserves schema-6 collaboration, shared-memory, and realtime gates.                                                                                                                                                                                                   |
| PDS and Directed Hosted Sync                    | Source/package lineage survives; local derivation readiness gates publication; frozen PDS source manifests/package bytes contain no processing metadata. Separately signed PDS artifact manifests retain source bindings and compatibility contracts/hashes; exact-compatible Memory Event, embedding, and LCM Node artifacts may import, while incompatible artifacts rebuild locally.                                              |
| Benchmark and fixture regeneration              | Retrieval, LCM, capacity, Team fixture, and PDS fixed vectors regenerate only through reviewed contract changes.                                                                                                                                                                                                                                                                                                                     |

## Acceptance evidence

Implementation issues must attach:

- command/version and redacted environment/profile;
- backup verify and restore-smoke result;
- pre/post canonical count/hash and high-water report;
- generation-set revision plus active/candidate/previous manifests;
- coverage, lag, outbox-repair, and failure summaries;
- exact validation/fixture revisions and results;
- local/remote capability negotiation result;
- rollback preflight or drill result;
- security check proving no Memory, vector, credential, key, or package plaintext entered logs or status output.

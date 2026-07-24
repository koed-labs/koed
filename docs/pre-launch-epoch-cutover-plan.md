# Pre-launch Epoch Cutover and Validation Plan

Status: implementation plan for [ADR 0013](adr/0013-pre-launch-schema-reset-and-processing-epochs.md). This document specifies work; it does not perform reset, migration, rename, or rebuild.

## Cutover gates

No profile activates clean V1 processing names until all applicable implementation issues provide:

1. immutable epoch definitions and transactional active epoch set;
2. complete compatibility identity manifests for installed prompts/models/tokenizers;
3. deterministic stale detection and dependency ordering;
4. resumable Projection, LCM, and embedding rebuild jobs;
5. exact-compatible retrieval/reranking gates;
6. status, pause, retry, failure, and rollback controls;
7. backup/restore high-water reconciliation;
8. capability/source-contract negotiation for remote paths.

Activation artifact records release commit, migration revision, old/new active epoch-set revisions, exact compatibility IDs, approved reset/preservation scope, backup proof, fixture/benchmark versions, and Operator identity/time. Secrets and Memory content are excluded.

## Common preconditions

1. Stop new release deployment. Confirm no incompatible mixed binary is already writing.
2. Inventory profile, database, `KOED_HOME`, object/package stores, queue backend, upstreams, active sync relationships, Team sharing, encryption provider/key access, and current migration revision.
3. Classify database explicitly as `disposable_alpha` or `preserve_canonical`. Unknown classification aborts; tooling never chooses.
4. Pause capture/import/sync publication and new LCM work. Allow or cancel in-flight canonical writes at transaction boundary. Record queue and sync high-water marks.
5. Create encrypted Postgres backup and required non-derivable `KOED_HOME`/object-store backup. Verify archive and key access. Hosted profiles also complete clean restore smoke.
6. Export redacted pre-cutover status: migration revision, canonical counts/hashes by scope, lifecycle floors, sync cursors, active epoch revision, derived counts, queue state, and backup proof.
7. Verify installed release assets and exact prompt/model/tokenizer/artifact digests. Missing artifact identity aborts rather than guessing.
8. Confirm disk headroom for parallel replacement generations and compute/AI Client capacity for rebuild.

## Data classification

### Preserve

- Users, identity mappings, API Token verifier records, device identity, and credentials only for a classified `preserve_canonical` cutover. A disposable reset discards database verifier rows; Local Operator Scripts then provision a replacement local API Token and update managed local configuration/Explorer credentials. Upstream/device credentials survive only after restored principal-binding and verifier-state revalidation; otherwise revoke local secret material and re-enroll/rotate.
- Teams, Membership, Workspaces, Workspace Access, Share Grants, Capture Policy/Pause and lifecycle/audit state.
- Captured Sessions, canonical conversation items and immutable observations, source identities/hashes/order/timestamps, historical import checkpoints and provenance. Alpha payload envelopes pass an explicit validated transform into release V1 with old/new hashes and lineage recorded; labels are never rewritten in place.
- Directed-sync canonical target events where no raw target source exists, logical Memory/replica identity, consent/policy, package/source lineage, upload/inbox/outbox and cursor high-water state.
- PDS Local Personal Identity bindings, group/User subjects, members, canonical statement chain/head, Key Bundles, membership certificates, Personal Sync Policy, Remote Account Links, freeze/quarantine state, audit, cryptographic epoch and signed source packages/tombstone floors, if and when KOE-348 / PR #319 merges. Processing cutover never rewrites PDS cryptographic epochs.
- Curated Memory accepted source/provenance and other records explicitly classified canonical by owner.
- Encryption envelopes, provider/key references and wrapped material required to decrypt retained canonical data.

### Invalidate and rebuild

- Locally projected sessions/turns/messages/tool events and Memory Events where retained raw source is authoritative.
- Memory Nodes, LCM Placeholders, local LCM Summaries and parent rollups.
- Embeddings, vector partitions, lexical/vector auxiliary indexes, graph-derived state, caches and readiness aggregates.
- Old processing jobs whose payload lacks target compatibility identity; replace with reconciled jobs.

### Discard or regenerate

- Redis queue state, caches, temporary files, smoke data, benchmark/evaluation output, synthetic fixture databases, stale capability caches, derived diagnostics.
- Disposable-alpha databases in full, after backup/confirmation if policy requires.

## Required ordering

1. Pause affected writes and take verified backup.
2. Install binaries/assets without activating processing.
3. Apply database revision; activate release V1 payload baselines (including capability and canonical conversation envelopes); seed immutable epoch definitions. Invalidate alpha capability caches.
4. Import/preserve canonical records or create clean database.
5. Reconcile encryption/lifecycle/sync high-water state.
6. Transactionally activate Projection V1 target; stale old Projection and all downstream generations.
7. Run Projection rebuild by stable owner/session scope.
8. From complete active Projection, run Memory Event embedding rebuild independently and in parallel with LCM leaf rebuild. Memory Event semantic Recall readiness depends on Projection plus its exact-compatible embedding coverage, not LCM completion.
9. Run LCM rollups bottom-up after compatible leaves; incompatible children block parents. Run Memory Node embeddings only from completed/allowed placeholder Memory Nodes and complete LCM dependency closure.
10. Build retrieval indexes/partitions and activate retrieval/reranking epoch per source family only after its exact-compatible coverage gate passes. A profile may publish Memory Event Recall while LCM-derived Memory Node Recall remains rebuilding, when retrieval policy, authorization closure, and status describe that bounded availability.
11. Refresh capabilities/upstream caches and resume sync intake into non-recallable processing state.
12. Validate and atomically publish each complete family generation, then resume applicable Recall, sync publication, import, capture, and LCM background work in that order.
13. Retain rollback generation/backup through soak window; remove only by explicit audited cleanup.

Capture may resume before all historical rebuild finishes only when new canonical rows target active Projection and Recall can isolate complete compatible generations. Team-shared and synchronized scopes remain unavailable until authorization closure and local processing are complete.

## Profile runbooks

### Developer and CI

- Default classification: disposable, but require explicit test harness flag.
- Drop/recreate database and Redis; clear generated smoke state. Preserve developer `.env` secrets outside reset.
- Preserve real `KOED_HOME` only when test uses an isolated home; never delete default home from CI script.
- Run clean migrations, seed V1 active epoch set, regenerate fixtures and benchmark baselines.
- Validate unit/integration suites plus clean bundled-local smoke.
- Rollback: discard test database and rerun prior commit; no alpha data compatibility claim.

### Local personal / Desktop alpha

- Prompt User/Operator with exact database/home and classification. Default to safe abort, not deletion.
- Create encrypted database backup and separate backup of non-derivable device identity, source packages, Project metadata, credentials, and config. Do not copy API Tokens into logs/status.
- For disposable alpha: stop Desktop/`koed-server`, remove only selected database data, retain device identity/config/secrets, then reprovision API Token verifier state and atomically replace managed local token/Explorer credentials. Retained old API Token plaintext is invalid after reset. Retain upstream/device credentials only after restored principal-binding revalidation; otherwise revoke local secret material and require enrollment/rotation.
- For approved preservation: run canonical export/import, verify source counts/hashes and lifecycle state, then rebuild locally in required order.
- Desktop shows processing progress and permits local capture when safe; stale Memory is not Recall evidence.
- Rollback: before new canonical writes, stop and restore old backup/runtime. After new writes, restore plus replay canonical delta; automatic downgrade is forbidden.

### Private VPS and Team Self-Hosted

- Treat as preserve-canonical unless environment is explicitly launch fixture.
- Maintenance window pauses capture/import/sync and Team Recall publication. Verify envelope provider and restore host before cutover.
- Preserve Team authorization, Share Grants, audit, canonical source and sync lineage. Rebuild Team-visible derivations only inside exact authorized source closure.
- Run bounded owner/Workspace batches with disk/queue/latency monitoring. Team Workspace stays unavailable or on last complete compatible generation; partial generation is never searchable.
- Refresh every local edge capability cache after activation. Incompatible edges fail closed with upgrade guidance.
- Rollback uses retained generation when database revision remains compatible; otherwise clean restore plus canonical delta replay and cursor reconciliation.

### Koed-managed cloud

- Execute per environment/tenant shard with change record, verified encrypted backup, KMS access proof, restore smoke, capacity budget, and rollback owner.
- Pause package intake publication and affected Recall per shard, not global plaintext export. Keep encrypted package/object retention intact.
- Preserve tenant/source/authorization/encryption isolation. Rebuild with tenant-scoped jobs and rate limits.
- Canary internal/synthetic tenants first, then staged cohorts. Promotion requires error/latency, stale age, queue lag, vector coverage, LCM blockage, Team authorization, and sync freshness thresholds.
- Failed cohort stops promotion. Roll back active epoch pointer only to complete compatible retained generation; schema rollback uses restored shard and canonical replay.

### Launch staging and deterministic Team fixture

- Disposable database reset is expected after encrypted backup only where launch policy requires evidence.
- Regenerate Team synthetic fixture, expected IDs/hashes only where contract intentionally changes, retrieval benchmarks, LCM expected schema/provenance, capacity reports, and staged remote registrations.
- Validate revoked/private Memory remains excluded, retained Team knowledge remains authorized, API Tokens remain personal-only, and exact-compatible Team recall succeeds.

## Failure, pause, retry, and rollback

- Every family has independent `pending/running/paused/blocked/failed/complete` state and dependency reason.
- Pause is cooperative at batch boundary. Completed replacement rows remain unpublished until generation gate.
- Retry reuses deterministic job key and cursor. It does not duplicate canonical or derived rows.
- Source closure or target epoch change supersedes old job; old result cannot publish.
- Permanent parse/schema/lineage incompatibility quarantines scope and reports redacted reason.
- LCM AI Client outage leaves summaries pending and placeholders usable only if active retrieval epoch explicitly permits compatible placeholder evidence.
- Embedding artifact/tokenizer mismatch blocks vector generation and vector Recall; lexical fallback occurs only if active retrieval epoch specifies it.
- Rollback pointer selects only previously complete generation compatible with current canonical and payload schemas. It never lowers deletion, revocation, sync, or canonical source high-water state.

## Validation matrix

| Scenario                       | Required assertion                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean install                  | Migrations produce one active V1 epoch set; no stale rows/jobs; status and capabilities agree; capture through Recall succeeds.                                                                                                                               |
| Disposable alpha upgrade       | Explicit confirmation and backup precede reset; selected database resets; device/config secrets outside scope survive; local API Token is reprovisioned and managed configuration/Explorer credentials are replaced; fixtures regenerate.                     |
| Canonical-preserving upgrade   | Canonical counts, identities, closure hashes, ownership, lifecycle, encryption and sync cursors match pre-cutover; derived IDs may change; Recall becomes available only after complete compatible generation.                                                |
| Interrupted Projection rebuild | Kill before/after batch/publish; lease expires; retry resumes cursor; no duplicate Memory Events/source links; downstream remains blocked until complete.                                                                                                     |
| Interrupted LCM rebuild        | Leaf retries are idempotent; completed compatible leaves reused; parent waits for all compatible children; model failure visible; no backend LLM fallback.                                                                                                    |
| Interrupted embedding rebuild  | Partial chunk set never counts as covered; retry atomically replaces complete set; old incompatible partition excluded; Memory Event coverage/readiness can complete without waiting for LCM-derived Memory Node coverage.                                    |
| Mixed Projection epochs        | New LCM/embedding consumes active Projection only; stale row excluded or served solely through retained complete old generation; Memory Event embeddings do not wait for LCM completion.                                                                      |
| Mixed LCM children             | Parent construction blocks and schedules child rebuild; unsupported schema/text fallback cannot claim compatibility.                                                                                                                                          |
| Incompatible vectors           | Query never compares/fuses mismatched identity; explicit unavailable/degraded result; exact partition works.                                                                                                                                                  |
| Retrieval/reranker change      | Retrieval epoch can change without vector rebuild when embedding identity unchanged; old result policy is not silently mixed.                                                                                                                                 |
| Retry/idempotency              | Duplicate signal/job/package produces one logical output and stable progress counters.                                                                                                                                                                        |
| Pause/resume/cancel            | State visible and audited; pause at boundary; resume continues cursor; cancel cannot publish partial generation.                                                                                                                                              |
| Rollback                       | Retained complete generation restores Recall; canonical writes/lifecycle floors do not regress; unsupported database downgrade aborts.                                                                                                                        |
| Backup restore                 | Restore reconciles migration, active epochs, leases, stale rows, sync/deletion high-water; old derived rows rebuild; missing KMS fails closed.                                                                                                                |
| Local/remote capability        | Fresh compatible source/payload range permits intake; stale/unknown/incompatible cache blocks; release version alone never permits. PDS governance availability does not imply package transport, materialization, derived readiness, or Recall availability. |
| Directed Hosted Sync           | Canonical event package lineage/cursors survive; target local derivation gates `ready`; stale/partial replicas excluded.                                                                                                                                      |
| PDS V1 lineage                 | Origin signature, closure hash, protocol and source contract validated before materialization; local epochs may differ; incompatible source contract quarantines before Projection/Recall.                                                                    |
| Team sharing                   | Authorization applied before candidate selection; derived source closure contains only granted Workspace source; revoked/private sources never leak through rollup/vector/graph.                                                                              |
| Export/import                  | Canonical lineage and payload schema survive round trip; imported derived diagnostics never bypass local rebuild.                                                                                                                                             |
| Encryption rotation            | Rewrap changes key version without changing compatibility identity/source closure; unavailable keys block processing.                                                                                                                                         |
| Benchmark/fixture              | LCM, retrieval-success, capacity, Team fixture and PDS fixed vectors pass/regenerate only by explicit reviewed contract update.                                                                                                                               |

## Acceptance evidence

Cutover implementation issues must attach:

- command/version and redacted environment/profile;
- backup verify and restore-smoke result;
- pre/post canonical count/hash and high-water report;
- active epoch-set specification and compatibility IDs;
- rebuild progress/failure summary and elapsed resource use;
- exact test/benchmark/fixture revisions and results;
- local/remote capability negotiation result;
- rollback drill result or documented profile-specific boundary;
- security check proving no Memory, vector, credential, key, or package plaintext entered logs/status.

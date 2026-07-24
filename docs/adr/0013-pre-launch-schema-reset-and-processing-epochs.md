# Pre-launch schema reset and processing epochs

Status: Accepted.

Related decisions:

- [0001 Rely on AI clients for LLM synthesis](0001-ai-client-synthesis-only.md)
- [0003 Drizzle Schema And Hybrid DB Repositories](0003-drizzle-schema-and-hybrid-db-repositories.md)
- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](0004-team-memory-workspaces.md)
- [0012 Symmetric Replicated Personal Memory Across Devices](0012-symmetric-replicated-personal-memory.md)

Supporting plans:

- [Version and Processing Epoch Inventory](../version-and-processing-epoch-inventory.md)
- [Pre-launch Epoch Cutover and Validation Plan](../pre-launch-epoch-cutover-plan.md)

## Context

Koed is pre-launch. Current internal and alpha data uses accidental labels such as `conversation-projection-v3` and `lcm-codex-summary-json-v3`, while embedding rows use a model key as their version. These labels record development sequence but do not identify all inputs that affect derived meaning. Preserving them would make alpha history part of the external contract without solving future upgrades. Renaming them cosmetically would also fail: PostgreSQL migrations cannot identify Projection, summary, vector, or ranking compatibility.

Canonical source and lineage already cross local, Team Self-Hosted, managed, backup, Directed Hosted Cross-Identity Sync, and future Personal Device Sync boundaries. Derived records are often rebuilt independently on each backend. Koed therefore needs separate compatibility identities, deterministic staleness, and recoverable rebuild work before freezing first-release names.

## Terminology

- **Database schema revision:** ordered Drizzle migration state describing relational storage shape and constraints. Database package owns it.
- **Payload schema version:** version of one API, protocol, persisted JSON, log, manifest, or structured-record shape. Format owner owns it.
- **Processing epoch:** named, immutable specification for one derived transformation family. It references a deterministic compatibility identity; it is not a time period or cryptographic key epoch.
- **Projection epoch:** Processing epoch for transformation from canonical captured source to semantic rows, Memory Events, and source links.
- **LCM Summary schema:** payload schema for structured LCM output. It says which fields are valid, not how summary was produced.
- **LCM processing identity:** compatibility identity covering LCM schema, prompt set, model/settings, source-composition contract, compaction, and chunk/reduce algorithm. It excludes per-output source closure and child dependency manifests. Prompt version remains one input and provenance label.
- **Embedding epoch:** Processing epoch covering every input that can change document or query vectors or their valid comparison space.
- **Retrieval/reranking epoch:** Processing epoch covering candidate selection, compatible embedding partitions, scoring/fusion, lexical behavior, reranker identity, thresholds, and evidence ordering.
- **Compatibility identity:** domain-separated SHA-256 of canonical JSON containing complete, explicitly named meaning-affecting inputs and their content digests. Equal identities are compatible; display names alone never prove compatibility.
- **Active epoch set:** deployment-owned, revisioned selection of active Projection, LCM, embedding, and retrieval/reranking epoch records plus supported read/transition ranges.
- **Stale derived data:** derived record whose stored compatibility identity differs from required active identity, whose canonical source-closure hash changed, whose dependency is stale/incompatible, or whose identity cannot be verified.
- **Rebuild job:** durable, leased, resumable, idempotent reprocessing work targeting canonical scope, source-closure hash, and compatibility identity.

These terms are architecture mechanics, not new User-facing product concepts, so they remain in architecture documentation rather than `CONTEXT.md`.

## Decision

### Reset first-release names

Koed will reset alpha-era **externally consumed payload and user-memory processing labels** to clean V1 names before first external release. This includes the active canonical conversation JSON envelope (alpha V2 becomes release V1), public capability schema (alpha revision 4 becomes release revision 1), Projection epoch, LCM processing/prompt epoch, embedding epoch, and retrieval/reranking epoch display names. Old alpha V1 bytes do not gain compatibility merely because a clean release contract reuses `v1`; disposable stores are reset and the approved preservation path validates/transforms canonical records. Reset implementation is separate follow-up work; this ADR does not rename fields or records.

Already coherent first-version contracts remain V1 and are not renumbered: HTTP route namespace V1, `lcm-semantic-summary-v1`, Directed Hosted Cross-Identity Sync V1, frozen `koed/pds/v1`, source adapter V1 contracts, encryption envelope versions, package schemas, and log schemas. Internal persisted-file revisions such as Project metadata store V3 retain their independent history when they are not external compatibility claims. After cutover, every payload namespace, including capability schema, advances monotonically from its accepted release baseline. Evaluation-only schema versions retain their own history.

Rationale: first external Users should see one intentional V1 baseline, not alpha implementation count. Durable compatibility comes from complete identities and immutable epoch records, so future V2 changes do not repeat this reset.

### Data cutover scope

- Disposable developer, CI, synthetic fixture, benchmark, local alpha, and launch-staging databases are discarded and recreated from clean migration baseline. Operators receive explicit backup and confirmation steps; tooling never guesses that a database is disposable.
- No arbitrary alpha database compatibility is promised.
- A specifically approved internal dataset may use a one-time canonical-preservation path. It preserves Users, ownership, Captured Sessions, canonical conversation items/observations, Capture Policy, source identity/order/hash, Project/Workspace/Share Grant relationships, accepted Curated Memory source/provenance, encryption envelopes, logical-memory/replica lineage, consent/lifecycle/tombstones, sync cursors and durable source packages. Alpha canonical payloads are validated and transformed into accepted release V1 envelopes with old/new hashes and lineage recorded; label-only rewriting is forbidden. It does not preserve compatibility claims for derived rows.
- Memory Events and source links are canonical for current Directed Hosted Cross-Identity Sync package semantics but derived from raw conversation sources in normal local ingestion. One-time tooling classifies them by provenance: source-package canonical events are retained as target canonical inputs; locally projected events are invalidated and rebuilt from retained raw source.
- Projection outputs, locally generated Memory Events, Memory Nodes, LCM Placeholders/Summaries, embeddings, vector/index state, graph-derived state, retrieval caches, derived readiness counts, and old rebuild queue work are invalidated and rebuilt.
- For approved canonical preservation, device identity, credentials, API Token verifier rows, encryption metadata, membership/lifecycle state, Team authorization, and source-owned sync lineage are preserved; processing cutover does not regenerate them.
- A disposable database reset discards API Token verifier rows. After clean database creation, Local Operator Scripts must provision a new local API Token and atomically update managed local configuration/Explorer credentials; retained alpha plaintext tokens are invalid. Preserve an upstream or device credential only when its principal binding and verifier state are restored and authenticated revalidation succeeds; otherwise revoke local secret material and require enrollment/rotation. Processing tooling never silently rebinds a credential principal.

### Separate ownership namespaces

| Namespace                 | Owner                                          | Change trigger                                                                      | Compatibility effect                                                                                 |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Database revision         | `packages/db`                                  | relational shape/constraint change                                                  | migration required; does not imply reprocessing                                                      |
| Payload schema            | API/protocol/file/log owner                    | serialized shape/validation change                                                  | reader negotiation/migration required; may or may not imply reprocessing                             |
| Projection epoch          | DB Projection + Worker                         | source interpretation, policy, ordering, grouping, tokenization, source composition | stale Projection family and downstream dependants                                                    |
| LCM schema                | `@koed/core` + API                             | structured summary shape                                                            | parser/rollup compatibility; separate from prompt/model                                              |
| LCM processing            | MCP LCM Summary Service + DB compactor         | prompt/model/settings/source composition/compaction/reduction                       | stale summary and dependent rollups/embeddings                                                       |
| Embedding epoch           | Embedding Service + Worker + DB                | artifact/tokenizer/dimensions/prefix/chunk/pooling/normalization behavior           | vector comparison partition changes                                                                  |
| Retrieval/reranking epoch | API/MCP retrieval + Embedding Service reranker | candidate/filter/fusion/scoring/reranker/evidence behavior                          | query and result-policy compatibility changes; vectors may remain valid if embedding epoch unchanged |

No global application version replaces these namespaces.

### Deterministic compatibility identities

Every epoch record stores `family`, immutable display name, canonical specification JSON, `compatibility_id`, creation/release provenance, and lifecycle state. Canonical JSON uses sorted keys, explicit nulls where meaningful, content digests rather than mutable paths, no environment-dependent ordering, and domain `koed/compatibility/<family>/v1`. `compatibility_id = sha256(domain || 0x00 || canonical-json(specification))`.

Minimum specifications:

- **Projection:** source payload schema and adapter/parser contracts; canonical normalization and identity rules; Projection policy snapshot digest; ordering, terminal evidence and sealing rules; semantic unit and manifest schema; role/type mapping; content normalization; token counter/model; bundle and hard split limits/overlap; embedding/LCM inclusion selection; implementation algorithm digest.
- **LCM:** structured output schema; exact digest and declared version of base, leaf, rollup, partial, and reduce prompts after override resolution; AI Client provider; model identity boundary; reasoning effort and meaning-affecting generation settings; tokenizer; prompt budget; compaction thresholds/fanout/tail; placeholder, chunking and reduction algorithm; redaction/source serialization; implementation algorithm digest.

  Per-output lineage is not part of the LCM compatibility identity: each output and job stores its source-closure hash plus ordered source manifest; each rollup also stores an ordered child dependency manifest containing child compatibility IDs and closure hashes. This permits one active LCM identity while preserving deterministic dependency checks.

  A provider with immutable revision metadata stores provider, requested model name, resolved immutable revision, and revision source. If a provider exposes only a mutable alias, the canonical specification records that alias with explicit `null` revision and `model_identity_kind: "mutable_alias"`. Same alias is accepted compatibility boundary only; output must not claim exact model reproducibility, status exposes this limitation, and an Operator must activate a new epoch when provider change evidence or resolved metadata changes. Missing both immutable revision and a declared alias aborts processing rather than guessing.

- **Embedding:** exact model artifact digest; tokenizer artifact/config/special-token digest; dimensions and output precision; document/query role and instruction/prefix bytes; source text composition; semantic chunking/overlap and transport reassembly; pooling; normalization; quantization/runtime settings only where they alter vector values; implementation algorithm digest.
- **Retrieval/reranking:** required query embedding compatibility identity and allowed document embedding partitions; authorization/lifecycle/source filters; search domain/scope interpretation; vector metric/score transform; candidate stages and limits; lexical tokenizer/config; score thresholds; fusion/dedup/diversification/fallback; exact reranker artifact/tokenizer/prompt/truncation/pooling; final evidence ordering and citation expansion rules.

Derived rows store family compatibility ID and source-closure hash. Jobs store target ID and closure hash. Completion uses compare-and-set: if active target or source closure changed, result is not published and new work is reconciled.

### Active epoch-set source of truth

Database `active_epoch_set` state is authoritative for every running deployment profile. Immutable epoch definitions are release-owned seed data; active selection is a transactional database record with monotonically increasing revision and audit provenance. Environment and prompt/model asset resolution produce a candidate specification at startup. API, Worker, MCP Server, and Embedding Service must agree with database active identities before processing or serving affected Recall.

- Developer and local-personal profiles seed from installed release plus resolved local assets. Operator-approved prompt/model override activates a new immutable epoch, not silent mutation.
- Private VPS, Team Self-Hosted, and managed profiles activate through migration/release orchestration before workers publish new output.
- Cached upstream capabilities advertise capability schema, protocol ranges, active epoch-set revision/identities, supported source payload ranges, and whether remote processing can rebuild accepted canonical packages. KOE-348's `memory.personalDeviceSync` governance availability remains distinct from package transport, materialization, derived readiness, and Recall availability.
- Release version is diagnostic provenance only.

One deployment may retain old immutable epoch definitions and records during bounded transition, but has one active write target per family. A retrieval epoch may explicitly query multiple **compatible** embedding epochs as separate partitions only when its specification defines calibrated fusion. Default V1 supports exact one-partition identity.

### Staleness and rebuild orchestration

Staleness is computed, not remembered:

1. Compare derived compatibility ID and source-closure hash with active required identity and canonical dependencies.
2. Mark stale family and recursively stale dependants: Projection before LCM/embedding; child LCM before parent rollup; summary text before node embedding; embedding before retrieval readiness.
3. Upsert deterministic rebuild job key `(family, scope, target_compatibility_id, source_closure_hash)`.
4. Claim with token and bounded renewable lease. Check pause/cancel and source/target identity before each batch and publish.
5. Write replacement generation separately. Publish atomically only when complete; retain old generation for rollback until checkpoint and backup policy permit deletion.
6. Retry transient failures with bounded backoff. Permanent incompatibility enters failed/quarantined state and remains excluded.

Jobs expose total/discovered/completed/failed/skipped counts, bytes/items where safe, current phase, cursor/high-water mark, lease/retry, timestamps, redacted error class, and dependency blockage. Operations support pause, resume, retry, cancel-before-publish, and rollback to a complete retained compatible generation. Pause does not make stale data recallable.

### Mixed-version behavior

- Unknown payload/protocol/schema versions fail at intake before Projection. Raw quarantine may retain encrypted bytes and redacted provenance if policy permits.
- A stale or unknown Projection identity cannot feed new LCM or embedding work.
- LCM parents require every child to match explicitly accepted LCM schema and processing identity. Mixed or unknown children block parent construction and schedule child rebuild; no text-only fallback asserts compatibility.
- Vector distance is computed only inside an exact embedding compatibility partition. Incompatible vectors are never compared in one index query, score list, reranker batch, or fused result unless a future retrieval epoch defines validated calibration between named partitions.
- Query embedding must match selected document partition. Missing compatible partition yields explicit degraded/unavailable result, not lexical/vector substitution unless active retrieval epoch explicitly allows that fallback.
- Authorization, Team Membership, Workspace Access, Share Grants, lifecycle, entitlement, and replica readiness are enforced before ranking regardless of epoch.
- During rolling upgrade, canonical ingest may continue only if active source payload version is supported. A deployment serving Recall uses last complete compatible generation or reports processing/unavailable. It never serves partial new generation.

### Backup, rollback, interruption, and restore

Backup captures canonical rows, epoch definitions/active revisions, derived generation metadata, rebuild jobs/cursors, invalidation state, sync lineage/high-water marks, lifecycle/tombstone floors, and encryption metadata. Redis remains non-authoritative.

Before activation, Operator takes and verifies backup. Old complete derived generation remains rollback candidate until new generation validates. Database schema rollback is supported only where migration tooling declares it safe; otherwise rollback restores pre-cutover backup into clean database. Canonical writes made after activation cannot be discarded by restoring old backup without an explicit replay/reconciliation plan.

After restart or restore, services first reconcile database migration and cryptographic lifecycle high-water state, then active epoch set, canonical source closure, and job leases. Expired leases are reclaimed. Completion cursors never regress. Restored derived rows with old or unverifiable identity become stale; valid complete matching rows may be reused. Restored sync replicas remain non-recallable until source/target cursors, deletion floors, freshness, and active local derivations reconcile.

### Sync, sharing, and source lineage

- Directed Hosted Cross-Identity Sync and Personal Device Sync remain distinct protocols.
- Sync packages preserve their own payload/protocol version, origin/source identity, source-closure hash, sequence/cursor, consent, lifecycle, signature/checksum, and encryption/key metadata.
- PDS governance state proposed by KOE-348 / PR #319—Local Personal Identity bindings, group statements/head, membership certificates, Key Bundles, Personal Sync Policy, Remote Account Links, cryptographic `current_epoch`, freeze/quarantine state, and audit—becomes canonical security/lifecycle control only when that work merges. Cutover and restore preserve it and never rewrite its cryptographic epoch to match a Processing epoch.
- PDS V1 replicates origin-signed raw closed-Session closure and excludes derived data. Receiving device negotiates exact `koed/pds/v1`, validates lineage, then uses its local active epoch set. Processing identity need not equal sender because derivation is local; source payload support and closure semantics must be compatible.
- Directed Hosted Cross-Identity Sync V1 retains canonical event package semantics. Target advertises package support and active local processing readiness; target derivations are local and not copied back.
- Team sharing changes authorization only. Team-visible derived records must have compatible identity and complete source authorization closure. Relabeling personal derived rows is forbidden.
- Export/import preserves canonical lineage and payload schema. Derived exports, if diagnostic, carry compatibility identity and are never accepted as canonical upgrade shortcuts.
- API Tokens remain personal-memory credentials. Epoch negotiation grants no Team authority.

KOE-349 consumes this contract only after KOE-348 / PR #319 merges and this inventory is revalidated against resulting `main`: signed PDS source packages carry frozen protocol/payload/closure lineage; receivers fail closed on unsupported source contracts and rebuild derived data under local active epochs. Acceptance of this ADR removes KOE-344's architecture-design block, not implementation or merged-baseline gates, on KOE-349's package-contract merge. KOE-359 and KOE-363 still block end-to-end PDS materialization/launch, while KOE-361 and KOE-357 block making a materialized replica recallable. Package intake must remain quarantined/non-recallable until those gates report ready.

### Operator-visible behavior

`koed-server status --json`, `doctor --json`, authenticated operations status, and Desktop consume one redacted status contract containing active epoch-set revision, family state, stale/rebuild counts, progress, pause/failure/retry state, last successful checkpoint, rollback availability, and remote compatibility. Readiness distinguishes:

- core process/dependency readiness;
- canonical ingest availability;
- Recall availability for complete compatible generation;
- degraded rebuilding state;
- blocked incompatible state.

Status never includes Memory text, prompts containing Memory, vectors, raw source IDs, package bytes, credentials, or key material. Operator controls are authenticated, audited, idempotent, and scoped by deployment/family/owner where supported.

## Consequences

Benefits:

- Clean intentional V1 external names without preserving accidental alpha sequence.
- Deterministic stale detection and fail-closed mixed-version operation.
- Canonical source survives independent local rebuild and sync.
- Prompt/model/config changes become observable processing changes.
- Interrupted rebuild, restore, and rolling upgrade have explicit state.

Costs:

- Epoch registry, generation metadata, capability negotiation, rebuild workers, and Operator controls require several implementation seams.
- Rebuilds consume CPU, AI Client LCM capacity, storage, and time.
- Some internal alpha data is discarded; approved preservation needs one-time tooling.
- Exact artifact/tokenizer identity requires stronger build and model manifests.

## Alternatives considered

### Preserve alpha labels forever

Rejected. It avoids rename tooling but exposes implementation history and still lacks complete compatibility identity.

### Rename labels to V1 only

Rejected. Cosmetic names do not detect stale Projection, summaries, vectors, or ranking behavior.

### One global application/data version

Rejected. Independent payload, Projection, LCM, embedding, retrieval, cryptographic, and database changes have different compatibility and rollback boundaries.

### Use only PostgreSQL migrations

Rejected. A migration records storage shape, not model artifacts, prompts, tokenizers, policy, source composition, or retrieval semantics.

### Migrate every alpha-derived row in place

Rejected. Meaning cannot be proved from incomplete historical metadata. Rebuilding from canonical source is safer and cheaper pre-launch.

### Always discard all data

Rejected. Disposable alpha stores should be reset, but canonical source lineage, identity, authorization, lifecycle, encryption, and sync high-water records need an explicit preservation path for approved internal validation and future production upgrades.

### Replicate derived data to avoid rebuild

Rejected as default. It couples backends to sender processing and risks incompatible vectors/summaries. Explicit source-owned non-deterministic artifacts may be added only through versioned protocol decisions; PDS V1 excludes LCM Summaries.

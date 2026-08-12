# ADR 0026: Pre-launch schema reset and processing epochs

Status: Proposed.

Related decisions:

- [0001 Rely on AI clients for LLM synthesis](0001-ai-client-synthesis-only.md)
- [0003 Drizzle Schema And Hybrid DB Repositories](0003-drizzle-schema-and-hybrid-db-repositories.md)
- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](0004-team-memory-workspaces.md)
- [0012 Symmetric Replicated Personal Memory Across Devices](0012-symmetric-replicated-personal-memory.md)
- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](0013-team-collaboration-authority.md)
- [0020 Portable Personal Derived Artifact Replication](0020-portable-personal-derived-artifact-replication.md)
- [0021 Portable Semantic Work Ownership](0021-portable-semantic-work-ownership.md)
- [0023 Collaboration Receipts Use Versioned Audiences](0023-collaboration-receipts-use-versioned-audiences.md)
- [0023 Team Member Presence](0023-team-member-presence.md)
- [0024 Tiered Desktop Action Approval](0024-tiered-desktop-action-approval.md)
- [0025 MCP v2 and Local AI Runtime Ownership](0025-mcp-v2-local-ai-runtime-ownership.md)

Supporting plans:

- [Version and Processing Epoch Inventory](../version-and-processing-epoch-inventory.md)
- [Pre-launch Epoch Cutover and Validation Plan](../pre-launch-epoch-cutover-plan.md)

## Context

Koed is still pre-launch. Current internal and alpha data uses accidental labels such as `conversation-projection-v3`, `lcm-codex-summary-json-v3`, and model-key-as-version embeddings. Those labels record development sequence, not all meaning-affecting inputs.

Renaming those labels to clean release `v1` baselines is still the right contract choice for first external release, but naming alone does not solve upgrade safety. Koed also cannot require a maintenance window that blocks Recall while derived Memory is rebuilt. The smallest acceptable system therefore needs:

- clean release-V1 names for external payload and processing labels;
- canonical-versus-derived separation, with canonical source and lineage preserved;
- fail-closed compatibility identities rather than global app versions;
- a bounded zero-downtime generation model that keeps one complete published generation servable while a replacement is built.

The Postgres and LCM spikes show that this smaller model is feasible, but they also show concrete constraints the generalized ADR text did not capture precisely enough:

- current `memory_events_source_hash_unique` and `memory_nodes_source_hash_unique` constraints block parallel derived generations;
- fresh serving output during transition requires bounded coexistence of old and new processing implementations and assets;
- LCM summary persistence currently happens before node-embedding enqueue outside one durable transaction, so a failure can leave a completed-but-unembedded node absent from pending-summary discovery.

## Terminology

- **Database schema revision:** ordered Drizzle migration state describing relational shape and constraints.
- **Payload schema version:** version of one API, protocol, persisted JSON, log, manifest, or structured record shape.
- **Compatibility identity:** domain-separated SHA-256 of canonical JSON naming every meaning-affecting transformation input and its digest.
- **Generation set:** one coherent published-or-candidate set of derived Projection, LCM, embedding, and retrieval state associated with a generation-set revision.
- **Active generation:** the published generation set serving Recall now.
- **Candidate generation:** the replacement generation set being built and validated.
- **Previous generation:** the retained prior generation set that may become a rollback candidate only after preflight and catch-up.
- **Compatibility manifest:** the bounded per-family shape `{ current, servable[] }`, where `current` is the installed target identity and `servable` lists the exact published identities the release can still interpret during transition. Membership in `servable` does not publish an incomplete candidate.
- **Servable window:** the exact set of complete published generation identities a deployment may read during transition. Default steady state is one active identity per family.
- **Transition revision:** monotonically increasing generation-set control revision used for compare-and-set activation and rollback.
- **Derived-write fence:** a database-level transition fence that keeps canonical capture open while preventing incompatible derived publication during activation.
- **Source cohort:** Projection plus Memory Event embedding coverage through a fenced canonical high-water.
- **LCM cohort:** completed LCM Summary state plus Memory Node embedding coverage through the same fenced canonical high-water.
- **LCM Placeholder coverage:** internal candidate-build progress where required leaves have deterministic LCM Placeholders. It is pending state only and is never publishable Recall evidence.
- **`complete_summary_ready`:** the sole publishable V1 LCM cohort state, where every required leaf and parent has compatible completed LCM Summary coverage and exact Memory Node embeddings.

These terms are architecture mechanics, not new User-facing product language, so they remain outside `CONTEXT.md`.

## Decision

### Reset first-release names

Koed will still reset alpha-era externally consumed payload and user-memory processing labels to clean release-V1 baselines before first external release. This includes the active canonical conversation JSON envelope, public capability schema, Projection display label, LCM processing display label, embedding display label, and retrieval/reranking display label. Release capability V1 must carry forward all current capability-schema-6 collaboration, shared-memory, and realtime semantics; reset naming never drops a current capability gate or consumer.

Already coherent first-version contracts remain V1 and are not renumbered, including HTTP route namespace V1, `lcm-semantic-summary-v1`, Directed Hosted Cross-Identity Sync V1, frozen `koed/pds/v1`, source adapter V1 contracts, encryption envelope versions, package schemas, and log schemas.

Old alpha bytes do not become compatible merely because release naming reuses `v1`. Disposable stores are reset; approved canonical preservation validates and transforms canonical payloads with lineage and old/new hash recording.

### Use a bounded minimum zero-downtime generation model

Koed will use one bounded active/candidate/previous generation-set model rather than the more generalized independent family-transition system.

Normative rules:

- Canonical capture remains open during transition when the source payload contract remains supported.
- Recall serves only a complete published generation set inside the servable window.
- Bounded Recall freshness lag during the derived-write fence is explicit and acceptable if Recall remains available and catches up after activation.
- Every activation and rollback uses a compare-and-set transition revision on one authoritative database control row.
- The database control row records the active, candidate, and previous generation roles, the servable window, the fenced canonical high-water, and the generation-set revision.
- Each family compatibility manifest uses `{ current, servable[] }`. Candidate output remains non-servable until its cohort coverage and publication gate passes, even when its identity is `current`.
- A deployment retains and routes at most two distinct processing/asset versions: old and new. Active, candidate, and previous are lifecycle roles, not permission to introduce a third implementation version; starting a transition that would require one must first retire the older rollback candidate.
- Generation-aware Memory Event keys, Memory Node keys, source links, embedding partitions, invalidation paths, and read paths are required. Parallel generations are not possible with the current global `source_hash` uniqueness shape.
- Authorization, Share Grants, Team Membership, Workspace Access, lifecycle state, deletion floors, replica readiness, sync lineage, and accepted Curated Memory decisions/provenance remain authoritative canonical state and must propagate across every retained generation.
- Curated Memory evidence pointers to derived Memory Events or Memory Nodes must be rebound to exact candidate-generation replacements through stable source lineage before publication. Missing or ambiguous remapping blocks preservation/activation; it must not suppress an accepted assertion or simulate source deletion.
- Rollback is not an unconditional pointer flip. It requires coverage, lifecycle, asset, and catch-up preflight against the current canonical high-water.
- The single `koed-server`-supervised Local AI Runtime owns persistent AI-client-backed work, including candidate LCM Summary processing. Short-lived MCP adapters and Desktop/API processes do not own persistent synthesis queues. The Worker continues to own downstream Memory Event and Memory Node embedding work.
- Persisted Memory Questions are final `mcp_memory_answer` results created after Local AI Runtime processing. They are not pending jobs, leases, or worker claims, and a processing transition must not recreate the retired Explorer queue.

### Separate database, payload, processing, and cryptographic namespaces

Koed keeps separate ownership and upgrade rules for:

- database revisions;
- payload schemas;
- processing compatibility identities and generation sets;
- cryptographic epochs such as PDS `current_epoch`.

No global application version replaces those namespaces. PDS governance is separate canonical security, identity, consent, and lifecycle control, not processing state. Frozen `koed/pds/v1` source manifests and package bytes remain unchanged. Separately signed `koed/pds-artifact/v1` portable artifacts retain their artifact-specific compatibility contracts and hashes; they never alter source bytes. V1 uses its implemented fixed operational Authority/Relay host topology. The current database baseline is the complete Drizzle journal recorded by the inventory, not a single PDS migration. PDS cryptographic epochs such as `current_epoch` are not Processing epochs.

### Deterministic compatibility identities

Every immutable family definition stores:

- family;
- display name;
- canonical specification JSON;
- compatibility identity;
- creation and release provenance;
- lifecycle state.

Canonical JSON uses sorted keys, explicit nulls where meaningful, content digests instead of mutable paths, and family-specific domains such as `koed/compatibility/projection/v1`.

Minimum meaning-affecting inputs:

- **Projection:** source payload contract, adapter/parser contract, policy snapshot digest, ordering and sealing rules, semantic unit rules, token counter/model, source composition, split limits/overlap, and implementation digest.
- **LCM:** structured output schema; prompt bundle digests after override resolution; provider; requested model alias as provenance; resolved immutable model revision or provider-verifiable fingerprint; reasoning settings; tokenizer; prompt budget; placeholder, chunk/reduce, and compaction rules; redaction/source serialization; implementation digest.
- **Embedding:** exact model artifact digest; tokenizer/config digest; dimensions; output precision; document/query prefixes; source text composition; chunking/overlap; pooling; normalization; runtime behavior that changes vectors; implementation digest.
- **Retrieval/reranking:** query embedding identity, allowed document partitions, authorization and lifecycle filters, search-domain behavior, metric and score transforms, candidate stages, lexical configuration, fusion/fallback policy, reranker identity, and final evidence ordering.

LCM source closure and child dependency manifests are not part of the family compatibility identity. They remain per-output lineage and dependency fields so one active LCM identity can cover many outputs without making every summary its own epoch.

A mutable provider alias is provenance only and cannot be a publishable compatibility boundary. Before candidate LCM processing starts, Koed must resolve and persist an immutable provider revision or provider-verifiable model fingerprint in the compatibility specification. Every job and returned output must match that resolved identity. A changed or unverifiable identity contaminates the candidate: its LCM output is discarded or quarantined, a new compatibility identity is required, and the rebuild restarts. If the provider cannot expose a stable revision or fingerprint, LCM processing remains blocked and the cohort cannot publish; status reports `immutable_model_identity_unavailable`. Koed does not infer identity from alias equality and does not fall back to a backend LLM.

### Publish two dependency-ordered cohorts under one generation-set revision

Koed will publish two explicit activation cohorts inside one generation-set revision:

1. **Source cohort:** Projection + Memory Event embeddings.
2. **LCM cohort:** completed LCM Summaries + Memory Node embeddings, with LCM Placeholders retained only as internal candidate-build progress.

Rules:

- Source cohort publication must not be accidentally blocked on AI Client throughput.
- Both cohorts are recorded under the same generation-set control row and transition revision. Each dependency-ordered cohort publication is a compare-and-set update of that revision; there is no independently mutable per-family activation graph.
- Source cohort readiness requires complete candidate Projection coverage through the fence high-water and exact-compatible Memory Event embedding coverage or explicit policy exclusion.
- `complete_summary_ready` is the sole publishable V1 LCM cohort state.
- LCM Placeholder coverage remains internal candidate-build progress. Placeholder text and embeddings must not be published, ranked, or returned as Recall evidence.
- Parent rollups require compatible completed children. They must not be built as complete rollups from placeholder children.
- Publishing Source before LCM makes the new Source cohort available while candidate LCM remains unavailable and pending; Recall must not combine it with the old LCM cohort in one Evidence Bundle.
- If launch cannot safely expose source-ready plus LCM-unavailable behavior in query policy and status, external publication remains monolithic even though the internal implementation still tracks both cohorts separately.

### Repair the current LCM completion-to-embedding durability gap

The current production path persists an LCM Summary and then enqueues Memory Node embedding outside the same durable transaction. A failure after persistence but before enqueue can leave a completed node absent from pending-summary discovery and absent from node-embedding coverage.

The minimum accepted system therefore requires:

- a durable `summary_ready -> node_embedding_pending` outbox or equivalent transactional record;
- a reconciliation path that can discover and repair lost handoff after restart or outage;
- exact activation coverage checks that treat missing candidate node embeddings as not ready, even when summary persistence succeeded.

### Activation and read behavior

Each cohort activation uses one compare-and-set transaction against the shared transition revision that:

- locks the generation-set control row;
- records the fence high-water;
- verifies expected transition revision and retained manifests;
- verifies source and, where applicable, LCM cohort coverage through the fence high-water;
- publishes the dependency-eligible cohort, updates cohort state and the servable window, and switches generation roles when the accepted publication policy is complete;
- records the new revision and audit provenance.

Recall uses only one coherent published cohort selection at a time. It never mixes active and candidate Projection, LCM, or embeddings in one Evidence Bundle, and it never combines a newly published Source cohort with an old LCM cohort. Unknown or incompatible payloads, summaries, vectors, closures, or capability state fail closed.

### Rollback contract

`previous` is a retained rollback candidate, not a guaranteed rollback target.

Rollback requires:

- retained old prompt bundle, model/settings boundary, tokenizer, and implementation assets;
- source, lifecycle, and authorization coverage through a new rollback fence;
- exact Projection, LCM, and embedding catch-up for the retained generation;
- complete remapping of accepted Curated Memory evidence onto active-generation derived IDs or retained stable canonical anchors; an unmappable assertion blocks publication rather than being suppressed as deleted;
- compare-and-set publication of that now-complete retained generation.

Rollback must not regress canonical source, deletion floors, revocation state, sync cursors, or authorization closure.

### Remote compatibility and sync

- Directed Hosted Cross-Identity Sync and Personal Device Sync remain distinct protocols.
- Capability discovery publishes supported source/payload/protocol ranges and coarse derivation readiness.
- PDS peers do not need matching local processing identities to exchange frozen `koed/pds/v1` source packages; processing identities and readiness are never added to signed source-manifest bytes. A receiver reuses separately signed `koed/pds-artifact/v1` Memory Event, embedding, or LCM Node artifacts only after exact validation of that artifact's signed compatibility contract and source binding. Missing or incompatible artifacts are excluded and locally regenerated from canonical source. Capability discovery carries only coarse local readiness out of band.
- Team sharing changes authorization, not ownership. Any published generation must enforce authorization and lifecycle closure before ranking or expansion.

### Minimal Operator-visible behavior for V1

Launch scope is intentionally narrow. Operator surfaces must provide:

- read-only current/candidate/previous generation-set state;
- per-cohort coverage, lag, retry, blocked, and failure state;
- explicit pending-build progress and complete-summary LCM readiness;
- rollback preflight status;
- authenticated retry/resume controls where needed.

This ADR defers rich pause/cancel/Desktop transition controls, arbitrary per-family activation, calibrated multi-epoch fusion, generalized restoration of in-flight optimization, and arbitrary live overrides.

## Consequences

Benefits:

- clean intentional release-V1 names without preserving accidental alpha sequence;
- no maintenance-window Recall outage requirement for supported upgrades;
- explicit bounded freshness lag rather than silent mixed-generation serving;
- Source-cohort Recall can progress without waiting on AI Client-bound LCM throughput;
- rollback, authorization, and retained-asset expectations are explicit.

Costs:

- generation-aware schema and query changes are required across Memory Events, Memory Nodes, links, embeddings, invalidation, and reads;
- old and new processing implementations and assets must coexist through transition and rollback;
- LCM needs durable outbox/reconciliation work in addition to polling and retry;
- richer generalized orchestration is deferred rather than solved here.

## Deferred by this ADR

This ADR does not accept the following for V1:

- rich pause/cancel/Desktop transition controls;
- arbitrary per-family live activation;
- calibrated multi-epoch fusion across incompatible partitions;
- generalized restoration of every in-flight transition optimization after restore;
- arbitrary live prompt/model override activation;
- publication of LCM Placeholder text or embeddings as Recall evidence;
- placeholder-only parent hierarchies.

## Alternatives considered

### Keep the current versioning model

Rejected. It does not detect stale derived Memory deterministically and does not satisfy the no-maintenance-window Recall requirement.

### Cosmetic rename to V1 without generations

Rejected. Clean names alone do not prevent incompatible Projection, LCM, embedding, or retrieval state from being reused silently.

### Generalized independent family-transition system now

Deferred. It is broader than needed for the minimum no-outage contract and introduces more control-plane surface than the team has explicitly approved.

### Always discard all data

Rejected. Disposable alpha stores should reset, but canonical source, lineage, authorization, lifecycle, encryption, and sync state need an explicit preservation path.

### Replicate all derived data across backends

Rejected as default. It couples receivers to sender processing identities and conflicts with local derivation. PDS portable artifacts remain an explicit exception: only allowlisted, separately signed artifacts with exact source binding and compatibility contracts may be reused; incompatible or unavailable artifacts rebuild locally from canonical source.

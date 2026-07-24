# Findings — LCM Summary Service in the minimum generation system

**Status:** throwaway, focused production-path investigation. Run with `pnpm spike:lcm-generation-investigation`.

## Direct recommendation

Choose the **minimum active/candidate/previous design**, but do **not** make LCM a free rider on the Projection + Memory Event embedding activation. Launch with two explicit, dependency-ordered cohorts under one generation-set revision:

1. **Source cohort:** Projection + Memory Event embeddings, complete through the fenced canonical high-water.
2. **LCM cohort:** LCM Placeholders/closures plus Memory Node embeddings, published either as **degraded placeholder-ready** or **complete-summary-ready**. The normal final activation gate is complete-summary-ready.

The pointer CAS moves a coherent generation-set revision only after the cohort states it exposes are explicit. Recall can serve active complete output while candidate work is pending. It must never mix active and candidate rows.

A candidate may activate as **placeholder-ready only** when every required leaf has a compatible deterministic LCM Placeholder, a closed source closure, and a matching placeholder algorithm/prompt-input identity. This is degraded evidence, not LCM Summary evidence: Recall must label it pending/degraded and rank or expand it under an explicit policy. Do not claim that it is an LCM Summary.

**Do not create parent rollups from placeholder children for a complete LCM cohort.** The current compactor can build a rollup from placeholder text and the summary worker then blocks its submission until children are summarized. For the generation system, parent creation/submission must require child `summary_ready` with the same LCM compatibility identity (or a separately designed placeholder-only hierarchy whose Recall policy is explicitly degraded). The smaller and safer launch choice is: leaves may be placeholder-ready; rollups wait for completed compatible children.

## Evidence from the real code paths

### Discovery, compaction, submission, and retry

- `packages/db/src/repository.ts#createLcmNodes` creates deterministic leaf/rollup text before AI-client synthesis. It stores that text in `memory_nodes`, identifies it with a global `source_hash`, and can compact a rollup from child placeholder text.
- `listLcmNodesNeedingSummaries` lists rows where `summary_model is null`, ordered by depth, and blocks a parent when a live child has `summary_model is null`. It has no generation parameter, claim token, or durable LCM work record.
- `packages/mcp-server/src/lcm-summary-service.ts` is an in-process timer/single-run guard. It resolves one current persisted/settings-derived worker config and invokes title work then LCM work. It is not a durable scheduler.
- `packages/mcp-server/src/lcm-summary-worker.ts` takes a local filesystem lock, repeatedly asks the API for pending nodes, processes the lowest returned depth concurrently, retries an AI Client prompt in-process, and submits one result. A failed prompt or submit returns `submitted: false`; because no mutation occurred, the node is rediscovered later. There is no backend LLM fallback.
- `apps/api/src/memory/lcm-routes.ts` authorizes/list-pends by the API Token owner, updates the Memory Node summary, **then** calls `enqueueEmbedding`. That enqueue is outside the summary persistence transaction.
- `apps/worker/src/job-workflows.ts` enqueues Memory Node embeddings immediately after compaction (therefore while text is still a placeholder) and the API re-enqueues after summary submission. `apps/worker/src/embedding-workflow.ts` embeds any embeddable Memory Node; it has no `summary_model` / generation readiness gate.
- `local_work_queue` has durable claims/retries, but it is used for embedding/compaction jobs, not for LCM AI Client work. The LCM local lock is process-local and a restarted MCP Server simply polls again.

The spike imports the built production LCM worker and uses its actual prompt loader, lock, prompt/retry validation, and pending/submit contract against an isolated scratch Postgres cluster with real Koed migrations. It demonstrates:

- active completed LCM remains recallable while candidate prompt execution fails;
- a submission failure leaves a candidate node pending and a subsequent worker run persists it;
- candidate and active summaries remain isolated in the shim;
- parent selection is bottom-up;
- a failure after persistence but before embedding enqueue leaves a completed node absent from pending discovery, so the current LCM retry loop cannot repair the missing embedding handoff;
- the real `memory_nodes_source_hash_unique` is global and lacks a generation key, confirming the current schema cannot persist an equivalent active/candidate node pair.

## Required smallest two-version interface

The MCP Server must accept a **generation-bound LCM processing manifest** rather than reading one mutable setting/environment configuration for all work:

```ts
type LcmGenerationManifest = {
  generationId: string;
  lcmIdentity: string; // digest of worker implementation + prompt bundle + schema + compaction/tokenizer rules
  promptBundle: Readonly<
    Record<PromptId, { version: string; digest: string; path: string }>
  >;
  model: { display: string; immutableIdentity: string };
  reasoningEffort: string;
  tokenizerIdentity: string;
  maxPromptTokens: number;
};

type LcmCandidateApi = {
  listPending({
    generationId,
    lcmIdentity,
    cursor,
    limit
  }): Promise<ClaimedNode[]>;
  complete({ generationId, nodeId, claim, summary, manifest }): Promise<void>;
  reconcileEmbeddings({ generationId, lcmIdentity, limit }): Promise<void>;
};
```

This is deliberately bounded to active plus candidate plus retained previous manifests. Prompt _version strings_ currently persist, but prompt loading uses one `KOED_PROMPT_DIR`; model/settings are resolved once per service run; tokenizer behavior is selected from model name. Thus current code cannot safely route old/new assets concurrently. The production implementation must retain content-addressed prompt bundles and old model/tokenizer/worker behavior through candidate activation and retained-generation catch-up. Do not rely on a mutable override directory or model alias.

## Failure/restart contract

| Point                                               | Current behavior                                                      | Required generation behavior                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Before prompt / AI Client outage                    | Node remains listed pending; active Recall unaffected                 | Persist candidate pending/checkpoint state; retry through a connected AI Client only. No backend synthesis.                                |
| During prompt submission                            | In-process retries; if submit fails it remains pending                | Idempotent `complete` keyed by generation/node/source closure + manifest; retry safely after restart.                                      |
| After summary persistence, before embedding enqueue | **Gap found:** summary no longer pending, enqueue can be lost         | One durable DB transaction/outbox must record `summary_ready` and `node_embedding_pending`; reconciliation must enqueue/claim it.          |
| Before node embedding                               | Existing embedding queue retries if job exists; no summary-state gate | Candidate node embedding is pending/resumable, not publishable; worker must verify exact candidate source/summary identity before writing. |

The candidate state that must persist is generation manifest identity, node/source closure, placeholder/summary state, summary payload/provenance, dependency state, embedding state, high-water coverage, and durable outbox/checkpoint records. Local lock ownership, in-flight Codex thread details, timers, and in-process retry counters may restart. Persisting raw AI Client telemetry is useful audit data, but not a readiness substitute.

## Exact readiness and activation contract

At the fence high-water `H`, every row belongs to a generation and has immutable source-closure and family identity.

### Source cohort ready at `H`

- Projection coverage includes every eligible canonical source at or below `H`.
- Each Memory Event embedding is either present for the exact embedding identity or explicitly excluded by policy.
- authorization/lifecycle closure has been checked, and all rows are candidate-isolated.

### LCM placeholder-ready at `H` (optional degraded activation)

- every eligible leaf has a candidate node whose source closure is closed through `H` and whose deterministic placeholder was created by the candidate compaction/placeholder identity;
- no node is presented as a completed LCM Summary; `summary_model`/summary state remains pending;
- Memory Node embeddings, if published, are embeddings of the placeholder and carry a `placeholder` evidence-quality state; they cannot be silently mixed with complete-summary embeddings;
- no complete rollup is built from placeholder children.

### LCM complete-summary-ready at `H` (normal activation)

- every required leaf has a schema-valid LCM Summary with the candidate prompt/model/tokenizer/algorithm identity;
- source closure is still live/authorized and is exactly the closure summarized;
- each parent is created and summarized only after all children are compatible complete summaries; recursively, no incomplete child exists;
- the exact candidate Memory Node embeddings exist for completed node text, and placeholder embeddings have been invalidated/replaced rather than treated as equivalent;
- node embedding outbox and reconciliation report zero required pending/active/failed rows, or an explicit excluded policy is recorded.

The CAS locks the generation-set control row, rechecks these coverage predicates through `H`, checks the expected revision and manifests, atomically changes cohort publication/roles, and records the new revision. Canonical capture remains open; suffix work after the fence is bounded Recall lag and catches up in the newly active generation.

This is not a monolithic all-or-nothing work scheduler: it is a coherent **published set** with explicit quality. Source cohort publication may occur before LCM complete-summary-ready only if Recall's query policy is able to select the compatible source cohort and disclose that LCM evidence is unavailable/degraded. If launch cannot express that query policy safely, make the external activation monolithic while still tracking the two internal cohorts. Do not block all source/Memory Event upgrades on AI Client throughput by accident.

## Rollback

`previous` is a rollback **candidate**, not an immediately safe pointer target. It needs its old prompt bundle, model identity/settings, tokenizer and LCM algorithm implementation retained. After new canonical sources or lifecycle changes, it must reopen the same fence and catch up source, LCM, and node embedding coverage before CAS rollback. A stale previous generation cannot be reactivated merely because its old rows remain stored.

## Connected Codex smoke

**Attempted successfully** on the local connected Codex CLI (`codex-cli 0.132.0`, logged in using ChatGPT) against the scratch database only. `SPIKE_REAL_CODEX_SMOKE=1 pnpm spike:lcm-generation-investigation` sent one harmless synthetic leaf prompt through the production `runCodexAppServerLcmSummary` seam and received schema-valid JSON from `codex-app-server:gpt-5.4-mini:low`. It did not use a production Koed API/database and did not submit the result.

This confirms local app-server connectivity and the basic prompt execution seam, not production throughput, live prompt quality, multi-node AI Client interruption behavior, or candidate rebuild capacity. The deterministic fake remains the source for repeatable failure injection.

## Effort impact

Keep the **10–18 engineer-week** minimum-system estimate. The LCM result does not justify reducing it: it adds generation-aware node/source keys, a durable LCM completion-to-embedding outbox/reconciler, compatibility manifests and retained prompt/model/tokenizer assets, dependency/readiness queries, and interruption tests. It does support deferring the full epoch system: bounded two-version routing and two explicit cohorts are materially smaller than generalized epochs, but not cheap.

## What this proves vs. suggests

**Proves:** the existing worker can consume a generation-scoped API without backend LLM synthesis; pending polling survives prompt/submission failure; current bottom-up pending rule exists; the post-persistence embedding hole exists in the current split; current node uniqueness blocks parallel generations.

**Suggests:** the two-cohort contract is sufficient if Recall can carry evidence-quality state. It has not validated real AI Client throughput, production query/index performance, Team authorization, rolling binaries, real API HTTP routing, or a production generation-aware migration.

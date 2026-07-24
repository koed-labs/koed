# LCM generation investigation (throwaway prototype)

**Question.** Can the real LCM Summary Service participate in a minimum active/candidate/previous generation transition without stopping active Recall, and what must be true before activation?

This is a deliberately disposable, scratch-Postgres integration probe. It imports and runs the built production `lcm-summary-worker` prompt/retry/submission loop. Its API-shaped adapter persists an isolated candidate node/job projection only because the current production schema cannot store a second Memory Node for the same source closure. It does **not** add production migrations or claim that the adapter is production code.

## Run

```bash
pnpm spike:lcm-generation-investigation
```

The one command builds the needed production packages, starts an isolated temporary PostgreSQL cluster, applies the real Koed migrations, runs the scenarios, then destroys the cluster. The default AI Client seam is deterministic so failure points are repeatable. To repeat the isolated connected-Codex smoke (one harmless prompt; consumes an AI Client request), run `SPIKE_REAL_CODEX_SMOKE=1 pnpm spike:lcm-generation-investigation`.

## What it exercises

- the real LCM worker's prompt validation, retry loop, depth ordering, local lock, and `listPendingLcmSummaries` / `submitLcmSummary` contract;
- active completed LCM Recall while a candidate fails before prompt and during submission;
- retry after a candidate submission failure, with active and candidate persistence isolated;
- child-before-parent pending selection;
- interruption after summary persistence but before the API's embedding enqueue handoff;
- the current production `memory_nodes_source_hash_unique` shape, which blocks parallel generations.

## Interpretation boundary

The candidate tables are a minimum persistence shim, not a substitute for generation-aware Koed schema and repositories. The result proves an important seam behavior: the current LCM worker can be supplied with a generation-scoped pending/submission API, but the current database/API/embedding handoff does not provide that scope or durable embedding reconciliation. One isolated connected-Codex smoke succeeded with a harmless synthetic leaf prompt. It does not validate AI Client throughput, interruption/restart behavior, or candidate-rebuild capacity; those remain unmeasured. The result suggests the proposed cohort contract.

See [FINDINGS.md](FINDINGS.md) for the launch recommendation and exact readiness contract.

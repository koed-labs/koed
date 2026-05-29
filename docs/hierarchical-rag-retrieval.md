# Hierarchical RAG Retrieval for Memory Answers

This note is the KOE-136 research deliverable. It records the current behavior
on remote `main` after KOE-158, then proposes the implementation shape for
LCM-native hierarchical retrieval.

## Confirmed Current Behavior

Normal agent recall enters through the MCP `memory_answer` tool. The tool is
registered in `packages/mcp-server/src/cli.ts:243`, defaults to
`search_domain=project`, `response_detail=answer_only`, and `limit=10`, and
caps caller-provided limits at `50` in the MCP schema
(`packages/mcp-server/src/cli.ts:249`, `packages/mcp-server/src/cli.ts:270`).
The handler calls `/v1/memory/answer` first, then passes the returned evidence
bundle to `answerWithMemoryWorker` with the same retrieval client
(`packages/mcp-server/src/cli.ts:286`, `packages/mcp-server/src/cli.ts:292`).

Manual Explorer Questions use the same answer worker after a different entry
point. The browser first persists a pending row in `/v1/memory/questions`
(`apps/history-browser/koed-history-browser/apps/web/src/koed/KoedHistoryApp.tsx:350`),
then calls the local MCP answer bridge at `/v1/memory/answer-local`
(`apps/history-browser/koed-history-browser/apps/web/src/koed/api.ts:208`).
The bridge claims the question and calls the same `/v1/memory/answer` endpoint,
then calls `answerWithMemoryWorker` with the same retrieval client
(`packages/mcp-server/src/answer-bridge.ts:538`,
`packages/mcp-server/src/answer-bridge.ts:546`). Pending-question catch-up uses
the same `answerClaimedMemoryQuestion` path
(`packages/mcp-server/src/answer-bridge.ts:679`,
`packages/mcp-server/src/answer-bridge.ts:686`).

`/v1/memory/answer` and `/v1/memory/search` both use `searchMemorySchema`,
whose default limit is `10` and maximum is `50`
(`apps/api/src/memory/recall-schemas.ts:7`). The answer route calls
`answerMemory`, which performs one repository search and returns an evidence
bundle. It does not synthesize with an LLM in the backend
(`apps/api/src/memory/recall-routes.ts:57`,
`packages/core/src/index.ts:489`).

The repository search is currently a flat vector search over
`memory_embeddings`. Rows from `memory_node`, `memory_event`, and `message`
sources all compete in the same candidate pool
(`packages/db/src/index.ts:6311`, `packages/db/src/index.ts:6313`,
`packages/db/src/index.ts:6338`). Project and session filters include raw
events/messages directly and also include memory nodes when their source events
match the boundary (`packages/db/src/index.ts:6358`). The final result set is a
single merged list sorted by score and then recency
(`packages/db/src/index.ts:6507`, `packages/db/src/index.ts:6563`).

LCM rollups and leaves therefore participate in retrieval, but they are not the
top-level navigation primitive. The query does not first search only completed
rollups, then expand into leaves, then expand into raw source events. Instead,
rollups, leaves, semantic memory events, and messages can all appear in the
same vector candidate pass when embeddings exist for them.

When reranking is disabled, the vector query asks for
`max(requestedLimit, 20)` candidates (`packages/db/src/index.ts:6398`). When
reranking is enabled, the candidate count is
`max(requestedLimit, MEMORY_VECTOR_CANDIDATE_LIMIT)`, with a default env
fallback of `20` (`packages/db/src/index.ts:2501`,
`packages/db/src/index.ts:6398`). Results are sliced back to the requested
limit after merging (`packages/db/src/index.ts:6572`).

Reranking is enabled only when `process.env.RERANKER_KEY` resolves to a
supported model key (`packages/db/src/index.ts:2458`). Docker maps root
`EMBEDDING_RERANKER_KEY` into container `RERANKER_KEY` for the embedding
service, API, and worker (`docker-compose.yml:39`, `docker-compose.yml:74`,
`docker-compose.yml:124`). This means the default Docker setup is not
miswired, but there are two config surfaces: operators set
`EMBEDDING_RERANKER_KEY` in the root `.env`, while direct app processes read
`RERANKER_KEY`. The design should document that distinction and avoid adding a
third reranker key.

Current reranking is also narrow. Only rows with completed LCM summary text are
rerankable (`packages/db/src/index.ts:6321`, `packages/db/src/index.ts:6418`).
Raw memory-event/message hits without a linked completed LCM summary remain in
the vector order and are merged with reranked rows
(`packages/db/src/index.ts:6454`). If no completed summary rows are available,
retrieval reports reranking as unavailable rather than failing the query
(`packages/db/src/index.ts:6422`).

Planner expansion exists, but it is budgeted and manually selected by the local
answer planner. The answer worker can ask for `search`, `expand`, or `answer`
actions (`packages/mcp-server/src/answer-worker.ts:521`). Defaults are
`MEMORY_ANSWER_MAX_SEARCHES=3` and `MEMORY_ANSWER_MAX_EXPANSIONS=3`
(`packages/mcp-server/src/answer-worker.ts:222`). Search results are appended
to evidence; expansion results are stored in `state.expansions` and included in
the next planner prompt, but they are not promoted into the same first-class
evidence/citation array as search hits
(`packages/mcp-server/src/answer-worker.ts:741`,
`packages/mcp-server/src/answer-worker.ts:777`,
`packages/mcp-server/src/answer-worker.ts:831`). `expandMemoryNode` expands a
memory node into source items and source memory events
(`packages/db/src/index.ts:6940`).

The local answer worker stores useful diagnostics today: local worker status,
planning mode, search count, expansion count, memory status, token usage, and
Codex app-server thread/turn IDs
(`packages/mcp-server/src/answer-worker.ts:948`). Planned retrieval metadata is
persisted as `mode=planned_local_memory` with raw retrieval and expansion
payloads (`packages/mcp-server/src/answer-worker.ts:942`). It does not yet
store structured stage-level retrieval diagnostics such as "rollup search",
"leaf search", "source expansion", and "raw fallback" because those stages do
not exist yet.

## Retrieval Quality Risks

- Flat retrieval can return raw semantic events before a relevant rollup has a
  chance to guide the search. This can add noisy evidence and spend planner
  tokens on low-level text too early.
- Rollups and leaves are not treated as hierarchy. A relevant rollup can appear
  beside one of its child leaves or source events, causing duplication and
  making the answer planner decide the hierarchy implicitly from mixed rows.
- Expansion results are secondary planner state rather than first-class
  evidence/citations. This makes it harder for the final answer, UI, and debug
  surfaces to explain exactly which expansion supplied support.
- The single `MEMORY_VECTOR_CANDIDATE_LIMIT` budget cannot express different
  needs for rollup search, leaf search, source expansion, raw fallback, and
  reranking.
- Reranking currently depends on completed summary text, so it is weakest for
  fresh raw semantic events and pending LCM nodes.
- Diagnostics are good enough to say how many searches and expansions happened,
  but not good enough to audit the contribution and outcome of each retrieval
  stage.

## Proposed Architecture

Implement a shared retrieval engine used by both `/v1/memory/answer` and
`/v1/memory/search`. The MCP `memory_answer` flow and Explorer Questions should
continue to share the same backend evidence call and local answer worker.

The engine should retrieve hierarchically:

1. Search completed rollup nodes first within the requested search boundary.
2. Let a deterministic planner/ranker select rollups to inspect further. This
   can initially be score threshold plus candidate budget, before LLM-assisted
   planning is considered.
3. Search or rank leaf nodes inside selected rollups.
4. Expand selected leaves into source `memory_events` and `messages` only when
   the leaf is likely to support the answer.
5. Run direct leaf search when there are too few rollups, the graph is shallow,
   or the rollup stage has insufficient recall.
6. Use raw memory-event/message vector search as a fallback stage, not the
   default first-pass pool. Fresh tail data that has not reached LCM yet should
   be covered by this fallback or by a dedicated "fresh semantic events" stage.
7. Optionally rerank within each stage using the existing reranker key. Do not
   create another reranker env name.
8. Return a single final evidence list whose entries include their retrieval
   stage, parent rollup/leaf chain, source ids, and expansion provenance.

This can be implemented independently of KOE-144, but KOE-144 would make the
local planner side cleaner. KOE-136 is about the backend retrieval/evidence
architecture. KOE-144 is about running all planned-answer planner/search/final
turns inside one Codex app-server thread per answer job. The hierarchical
retrieval engine should work whether the local answer worker currently uses
multiple app-server calls or later switches to one thread per job.

## Proposed Config

Keep existing config where possible:

- `MEMORY_VECTOR_CANDIDATE_LIMIT`: keep as a compatibility/default candidate
  budget for flat or fallback vector search.
- `EMBEDDING_RERANKER_KEY`: keep as the root `.env` reranker setting that maps
  to app-local `RERANKER_KEY`.
- `EMBEDDING_RERANKER_BATCH_LIMIT`: keep for the embedding service reranker
  batch limit.

Add stage-specific retrieval config:

- `MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT`
- `MEMORY_RAG_ROLLUP_RESULT_LIMIT`
- `MEMORY_RAG_LEAF_CANDIDATE_LIMIT`
- `MEMORY_RAG_LEAF_RESULT_LIMIT`
- `MEMORY_RAG_SOURCE_EXPANSION_LIMIT`
- `MEMORY_RAG_FRESH_EVENT_CANDIDATE_LIMIT`
- `MEMORY_RAG_RAW_FALLBACK_ENABLED`
- `MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT`
- `MEMORY_RAG_RERANK_STAGES`

Defaults should be conservative and fast. The implementation issue should tune
these with tests and small local benchmarks rather than guessing final values
in this research note.

## Diagnostics and Telemetry

The retrieval response should include a structured diagnostics object:

```json
{
  "engine": "hierarchical_lcm_v1",
  "stages": [
    {
      "name": "rollup_search",
      "query": "user query or rewrite",
      "candidate_limit": 40,
      "result_count": 8,
      "selected_count": 3,
      "reranked": true,
      "duration_ms": 24
    },
    {
      "name": "leaf_search",
      "parent_rollup_ids": ["..."],
      "candidate_limit": 80,
      "result_count": 12,
      "selected_count": 6,
      "duration_ms": 31
    },
    {
      "name": "source_expansion",
      "parent_leaf_ids": ["..."],
      "source_count": 10,
      "duration_ms": 12
    }
  ],
  "raw_fallback_used": false,
  "evidence_count": 6
}
```

Each evidence item should include enough provenance to answer:

- Which stage found it.
- Which rollup and leaf led to it, if applicable.
- Whether it came from a completed summary, pending summary, fresh event, raw
  fallback, or expanded source.
- Which source ids should be cited.
- Which embedding model/version and projection version produced the hit.

This diagnostics shape should be stored for manual Questions in
`memory_questions.retrieval` and returned from MCP `memory_answer` according to
the existing `response_detail` policy.

## Migration and Backfill

No user-visible data migration is required for the research outcome. The
implementation may need indexes for stage-specific searches, especially rollup
and leaf-only vector searches scoped by owner, workspace/session, node kind,
and invalidation state.

Existing embeddings can be reused if their source type, model, dimensions,
embedding version, and projection version are compatible with the new retrieval
engine. If a future projection or embedding epoch changes semantics, that is
covered by the separate epoch/versioning research rather than by this issue.

Because this project is still PoC/MVP, a fresh reset remains acceptable during
implementation if schema changes are simpler than migrations. The design should
still avoid needless re-embedding when the existing embeddings are compatible.

## Test and Benchmark Plan

Implementation should add repository-level tests for:

- Rollup-first retrieval prefers matching rollups before raw events.
- Leaf expansion only searches leaves under selected rollups.
- Direct leaf fallback works when there are no rollups.
- Fresh semantic events are still reachable before they are summarized into
  LCM nodes.
- Raw fallback is not used when rollup/leaf evidence is sufficient.
- Reranking can be enabled without dropping non-rerankable fresh hits.
- Evidence entries preserve stage and source provenance.
- MCP `memory_answer` and Explorer Questions return the same retrieval
  diagnostics for the same query and scope.

Benchmarks should cover:

- Recall quality against known seeded memories.
- Number of vector searches per answer.
- Candidate counts and final evidence counts per stage.
- Prompt token impact in the local answer worker.
- Latency for project, session, and global searches.
- Behavior with pending LCM summaries and large source expansions.

## Open Questions

- Should the first implementation use deterministic score thresholds for
  rollup/leaf selection, or should the local answer planner choose expansions?
- Should direct leaf search always run in parallel with rollup search, or only
  when rollup results are weak?
- What exact defaults should be used for rollup, leaf, fresh-event, and raw
  fallback budgets?
- Should raw fallback include keyword/exact-match search immediately, or should
  hybrid retrieval be a separate follow-up?
- Should expanded source text become evidence by default, or should the answer
  worker cite the summary while keeping sources only as verification context?

## Follow-Up Implementation Issue

The follow-up implementation issue is KOE-161: Implement hierarchical
LCM-native retrieval for memory answers. It requires the shared hierarchical
retrieval engine, stage diagnostics, MCP and Explorer parity, tests, and local
smoke testing.

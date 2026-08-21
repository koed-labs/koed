# Agent-Directed Memory Answer Retrieval

Status: Accepted.

Related decisions:

- [0001 Rely on AI clients for LLM synthesis](./0001-ai-client-synthesis-only.md)
- [0004 Team Memory uses user-owned Share Grants and Workspaces](./0004-team-memory-workspaces.md)
- [0009 Commercial SaaS encryption and key management](./0009-commercial-saas-encryption-key-management.md)
- [0010 Managed SaaS queryable vectors](./0010-managed-saas-queryable-vectors.md)
- [0029 Selective PII Team representations](./0029-selective-pii-team-representations.md)

## Context

Memory Answer already uses the connected AI Client to synthesize a standalone
answer from authorized Koed evidence. Its local worker can search and expand
evidence, but beginning every request with an LLM-directed search adds latency,
and a fixed semantic-before-lexical rule prevents callers and the worker from
using useful exact identifiers naturally.

Koed must improve that flow without moving synthesis into the backend,
exposing low-level retrieval tools as the normal interface, weakening Team or
encrypted-field boundaries, or returning large Evidence Bundles by default.
Managed deployments also cannot rely on a global plaintext lexical index or a
bulk decrypted scan.

### Contract inventory

The end-state change extends these existing contracts rather than replacing
their product boundaries:

- The public MCP request selects `query`, Retrieval Scope, Search Domain,
  Project, Captured Session, optional Team Workspace, temporal bounds, result
  limit, and response detail. Personal Project lookup and explicit local-edge
  Team routing are resolved before the worker starts.
- `answer_only`, `with_citations`, and `with_evidence` are the response-detail
  contract. The first is the normal compact response; evidence is a deliberate
  debugging or inspection choice.
- The local MCP-side Memory Answer worker performs synthesis through the
  connected AI Client. The backend authenticates, retrieves, expands, stores,
  embeds, and ranks; it does not perform LLM synthesis.
- The Recall repository owns Search Domain, Retrieval Scope, visibility,
  lifecycle, temporal, and source-stage filtering. The MCP worker does not
  reproduce those policy decisions.
- Personal calls use an API Token. Explicit Team Workspace calls retain the
  scoped local-edge and upstream device-credential route and fail closed until
  the selected Team Shared Memory representation is queryable under the same
  authorization boundary.
- Completed Memory Answers persist query, answer, selected evidence,
  citations, retrieval metadata, worker diagnostics, and provider-reported
  token usage through the existing Memory Question history path. Commercial
  encrypted-field mode continues to protect human-readable persisted fields.

## Decision

`memory_answer` remains the supported recall entry point and returns a compact,
standalone answer by default. Citations and selected evidence remain explicit
response-detail options.

The calling AI Client may provide bounded retrieval hints: semantic concepts,
exact or lexical terms, entities, and temporal context. These hints are
untrusted retrieval suggestions. The existing Recall policy resolves and
freezes the effective User, Retrieval Scope, Search Domain, Project, Captured
Session, Team Workspace, Share Grant, lifecycle, retention, and source-fidelity
boundary before retrieval. Neither caller hints nor later worker searches may
broaden that boundary.

For Team recall, the API freezes the admitted Share Grant IDs plus the exact
Team, Workspace, Membership, Workspace Access, and User row versions at run
start. It returns an opaque signed boundary token bound to the requesting User
and Team Workspace. The MCP Server forwards that token on every worker search
and expansion; it is never exposed as a model-controlled argument. Grants
created after the run starts cannot enter the run, while revocation or any
authority-row replacement fails closed immediately and remains closed after a
regrant. The frozen set is capped at 128 Share Grants; larger runs must narrow
their scope rather than silently truncating authority.

Before starting the local Memory Answer worker, the MCP Server runs a bounded
scripted first pass through the existing authorized retrieval path. Independent
semantic queries run concurrently, share one budget, preserve individual
failures, and produce deterministic candidate ordering. The first-pass result
and a compact retrieval summary are supplied to the worker, which may answer
immediately, run more semantic searches, inspect exact terms within already
authorized candidates, or expand selected evidence.

Production candidate generation remains semantic. Koed does not add a BM25,
per-row keyword, keyed lexical, or other lexical database index, and Memory
Answer does not perform a global decrypted lexical scan. Exact and lexical
hints seed focused semantic queries and checks over the candidates already
admitted by authorized semantic retrieval.

LCM Leaf and Rollup summaries include a bounded set of `lexical_anchors`
selected by the synthesis worker. Every anchor must be an exact, contiguous,
case-sensitive substring of the source payload supplied to that worker. Koed
deduplicates anchors, enforces count and length limits, and permits one repair
attempt for rejected anchors. Unsupported anchors are then dropped without
discarding an otherwise valid summary. No regular expression or scripted
anchor extraction is introduced. Rollup source includes child summaries and
their validated anchors.

Validated anchors are encrypted with their LCM Summary and included in a
separate section of that node's embedding input. They improve semantic
retrieval of identifiers without becoming a standalone lexical index.

Personal anchors and evidence remain full fidelity and owner-only. Before Team
materialization, LCM titles, summary text, anchors, Memory Events, Curated
Memory fields, and expansion material are classified independently and replaced
according to the effective versioned eight-label content policy. Fully replaced
anchors are omitted from Team embedding composition. Team exact checks,
reranking, evidence, citations, and expansion use only the sanitized Team form;
they never fall back to a Personal anchor or Personal source item.

Internal candidates use chunk-aware identity and retain source lineage, node
ancestry, generation, time, visibility, and retrieval-stage provenance.
Candidates found by multiple searches are fused with reciprocal-rank fusion
using `k=60` and deduplicated. Parent summaries and expanded children are not
counted as independent corroboration. Only evidence selected by the worker may
leave the worker response.

Completed Memory Answers persist a bounded internal retrieval trace inside the
encrypted Memory Question retrieval payload. It includes caller hints,
effective-boundary metadata, searches, candidate and selection identities,
budgets, failures, timings, and model metadata. The trace is deterministically
truncated to at most 32,768 UTF-8 bytes. Ordinary logs and diagnostics retain
only redacted identifiers, counts, durations, statuses, and error classes.

The same controller and worker flow serves Personal and Team recall. Team
Membership, Workspace Access, Share Grants, the maximum-fidelity ceiling and
each current sanitized representation, lifecycle, retention, classifier and
content-policy bindings, and source-capture policy are enforced before
candidate admission, decryption, narrowed checks, reranking, expansion, or
synthesis input. `memory_events` authorizes complete Memory Events, leaves, and
rollups; `lcm_leaves` authorizes complete leaves and rollups; and `lcm_rollups`
authorizes rollups only. Conversation Source Access and consent-bound Curated
Memory remain separate. Live view permission does not imply durable Memory
recall permission.

## Evaluation

The existing eval package owns the Retrieval Arena. It compares production
behavior with fixed reference arms, including eval-only BM25 and fixed hybrid
baselines; those arms do not define production architecture. Reports separate
retrieval-only, fixed-reader, and product-controller quality. Deterministic
checks cover exact facts and schemas, while semantic answer quality requires an
LLM judge. Runs record dataset, model, prompt, retrieval, latency, token, cost,
and resource metadata needed for reproduction.

## Consequences

- Common requests avoid a separate LLM planning round while retaining
  iterative agent-directed retrieval for difficult questions.
- Calling agents can improve retrieval without acquiring authorization or
  changing the effective search boundary.
- Exact identifiers become more discoverable through grounded LCM anchors and
  semantic embeddings without creating a plaintext lexical search surface.
- `answer_only` remains context-efficient; citations and evidence are paid for
  only when requested.
- LCM Summary schema, prompt, embedding input, and generation compatibility
  change together as one alpha contract rather than through a compatibility
  mode.
- Retrieval quality and cost can be compared fairly without shipping benchmark
  baselines as production policy.

## Non-Goals

This decision does not:

- add server-side LLM synthesis;
- expose new normal-use low-level memory tools;
- permit caller or worker input to grant visibility;
- add a production lexical database index or global decrypted scan;
- make Team Chat, presence, or transient collaboration events durable Memory;
- preserve superseded alpha retrieval or LCM schema behavior.

# Curated Memory

Curated Memory is a source-linked intake layer for durable facts, preferences,
decisions, corrections, plans, and similar reusable context. It augments normal
Memory Event, embedding, and LCM retrieval; it does not replace transcript
capture or `memory_answer`.

## Flow

1. The API advertises `memory.curatedIntake` in capability schema v4 or later.
2. The MCP Server exposes `memory_intake_propose` only when that capability is
   `available`. Older or temporarily unreachable backends leave the tool hidden
   until the MCP Server reconnects.
3. The main AI Client may call that tool when the User provides durable
   information.
4. The tool submits a Curated Memory proposal to
   `POST /v1/memory/curated/proposals`. The supported MCP flow sends a concise
   candidate plus either the exact supporting User statement or a known Captured
   Session ID. The authenticated API requires one unambiguous current
   user-authored source and fails closed when the same quote appears in multiple
   sessions. Diagnostic API callers may instead supply explicit evidence IDs.
5. The API stores the proposal as durable pending work and returns immediately.
   The proposing agent does not wait for review and cannot write a canonical
   assertion.
6. The supervised Local AI Runtime leases pending work and hydrates every
   source item plus a bounded set of current assertion candidates. Missing,
   deleted, excluded, unauthorized, or undecryptable evidence fails closed
   before an agent call.
7. The selected AI Client receives the complete evidence bundle as untrusted
   data through its provider-specific local transport. It has no Koed tools,
   network tools, repository instructions, or ambient conversation context. It
   semantically accepts or rejects the proposal and, when accepting, writes a
   self-contained assertion and selects its supporting evidence. It may choose
   `store`, `merge`, `supersede`, or `conflict`; proposal operation and target
   fields are hints only. The Curated Memory Review assignment independently
   selects Codex app-server, Claude Agent SDK, or Pi RPC.
8. The API revalidates the lease, evidence identities and revisions, selected
   evidence, and current target before committing atomically. Changed evidence
   releases the proposal for a fresh review. A typed `expires_at` becomes the
   assertion expiry. Server policy prevents a reviewer from lowering sensitivity
   or removing or extending the proposed expiry. `review_required` proposals
   fail closed until a User review and decision surface exists.
9. A deterministic reconciliation path links assertions to derived Memory
   Events and LCM summaries after Projection and LCM catch up.

The proposal tool never writes canonical Curated Memory directly. It only
persists async local review work.

A proposal may contain at most 12 evidence sources in total. The proposal,
review lease, accepted result, and terminal rejection contracts share this
limit, so an oversized proposal cannot become permanently pending between
different service limits.

Proposal lifecycle is owned by implemented operations: `pending` transitions
atomically to `stored`, `merged`, `superseded`, `conflicted`, or `skipped`. An
exact duplicate merges its evidence into the existing assertion. Supersession
creates the replacement and retires the named current assertion in one
transaction. Conflicting evidence creates a linked non-current assertion while
leaving the named current assertion unchanged. Postgres owns leases and attempt
state. The local review service is nudged after a proposal and also scans for
pending or expired work. A proposal remains `pending` until its final database
transaction commits, so process shutdown and local-agent failures recover
without duplicate canonical writes.

## Source Links

Curated Memory assertions must link to source evidence. Supported source types:

- `conversation_item`: raw transcript item evidence.
- `memory_event`: projected semantic bundle evidence.
- `lcm_summary`: derived LCM summary evidence.

An assertion can initially link only to a `conversation_item`. When Projection
later creates Memory Events, `POST /v1/memory/curated/reconcile` or the
periodic backend reconciliation path can attach the derived `memory_event` and
`lcm_summary` links without AI involvement.

Only active direct evidence keeps an assertion recallable. Deleted, invalidated,
or memory-excluded sources cannot satisfy eligibility, Search Domain, temporal
filters, or evidence expansion. Derived Memory Event or LCM links cannot
preserve a fact after its final direct source is removed. Normal Recall and
expansion fail closed immediately, and supported source deletion paths suppress
the orphaned assertion in the same transaction. The deterministic reconciliation
pass also suppresses any orphan created outside a supported deletion path, while
retaining its provenance for diagnostics and export.

## Retrieval

Normal recall remains `memory_answer`. Curated Memory participates in the normal
search pipeline as `curated_memory_search` and returns
`sourceType: "curated_memory"` hits. The memory-answer worker may inspect this
stage when answering questions about durable facts, preferences, decisions,
plans, or corrections.

Current assertions are canonical embedding sources. The Embedding Service
composes the assertion, topic, and tags, writes revision-bound vectors, and
invalidates those vectors whenever that input changes. Normal Recall generates
Curated candidates only through this semantic index, under the same model and
dimension checks as other Personal Memory sources. It never performs a bulk or
global decrypted lexical scan. Exact hints are checked only against the bounded,
authorized semantic result set and its evidence anchors.

Session, Project, and time-bounded Recall all use the same active-source
relation as global eligibility. Protected Memory Event workspace metadata is
read from its authenticated encrypted scope. Time bounds use transcript event
time first, then observation or ingestion time only when no source event time
exists; LCM-backed evidence derives its time from active source Memory Events.

The database repository composes focused Curated Memory modules: one policy
module owns source authorization and lifecycle predicates, while record access,
proposal transitions, Recall adaptation, and deterministic source
reconciliation remain separate. Callers use the single repository contract and
cannot bypass the shared policy through a feature-specific query path.

Default Recall may include this semantic stage for every query; a durable-memory
intent signal can prioritize it. Diagnostic callers can request
`curated_memory_search` explicitly. Curated matches use weighted relevance
comparable with semantic leaf results; stage type is only a tie-breaker and does
not override a stronger semantic hit.

Direct Curated Memory search routes are diagnostic/API surfaces:

- `GET /v1/memory/curated/assertions`
- `POST /v1/memory/curated/search`
- `GET /v1/memory/curated/assertions/:assertionId`

## Protected Storage

In protected deployment profiles (`private_vps`, `team_self_hosted`, and
managed cloud), Curated Memory text and structured payloads use the same
application-layer envelope encryption boundary as other Memory data. Database
rows retain only operational identifiers, lifecycle state, and redacted
markers; proposals, assertions, topics, source details, and Worker results are
stored in encrypted companions.

Reads authorize the owner before decrypting. The background Embedding Service
decrypts one authorized assertion revision to produce its canonical vector, and
Recall decrypts only bounded vector-selected candidates during hydration. A
protected deployment without a working envelope-encryption provider fails
closed on Curated Memory writes, embedding, hydration, and expansion.

Personal Memory export includes Curated Memory topics, proposals, assertions,
source links, and lifecycle relationships, including suppressed, superseded,
conflicting, and expiring records. The internal export operation collects every
owned Curated Memory record without a silent row cap. Hosted export encrypts the
complete export package after owner-authorized hydration; Curated Memory is
never omitted from the encrypted portability payload.

## Benchmarking

The Curated Memory intake eval scores the path in five layers:

- The agent decides whether a durable memory should be proposed.
- The proposal calls `memory_intake_propose` with source-linked evidence.
- The isolated local review worker accepts or rejects and rewrites the proposal.
- Normal recall retrieves the stored Curated Memory through
  `curated_memory_search`.
- A separate local LLM judge assesses each accepted positive assertion for
  faithfulness, preserved qualifications, durability, specificity, and rewrite
  quality. It judges meaning rather than spelling or substring overlap.

The suite includes negative cases for ordinary conversation turns, operational
task requests, transient public-fact questions, ephemeral tool output, and
agent-originated claims. Those cases should not be proposed or stored as
Curated Memory. A false proposal or stored assertion on those cases adds a
`false_fact_penalty` of `-1`.

Run the deterministic suite or score captured runs with:

```bash
pnpm --filter @koed/evals eval:curated-memory-intake -- --self-test-scorer
pnpm --filter @koed/evals eval:curated-memory-intake:workflow -- --database-url postgresql://... --mode deterministic-workflow
pnpm --filter @koed/evals eval:curated-memory-intake:workflow -- --database-url postgresql://... --mode reviewer-adversarial
pnpm --filter @koed/evals eval:curated-memory-intake:workflow -- --database-url postgresql://... --mode live-ai-client --model gpt-5.4-mini
pnpm --filter @koed/evals eval:curated-memory-intake -- --score runs.json
```

The scorer self-test validates only benchmark fixtures and scoring. The
deterministic workflow runner creates an isolated database, supplies fixed
proposal fixtures, and exercises the real protected API, Postgres lease, selected
local AI Client reviewer, transactional completion, normal Recall path, and
independent semantic judge. `reviewer-adversarial` sends every case to the
reviewer so its negative-case decisions can be measured without depending on
proposer tool choice. Live benchmark mode currently uses its Codex-specific
harness; that harness does not describe a product-wide reviewer default.
Deterministic checks cover payload structure, source and assertion identity,
lifecycle, storage, and Recall. The independent
judge scores only accepted positive assertions; expected rejection plus absence
from storage and Recall is sufficient for negative cases. Proposer decisions,
reviewer outcomes, judge quality, false storage, latency, and measured token use
remain separate metrics. Use `--judge-model` and `--judge-reasoning-effort` to
configure the benchmark assessor independently from the Curated Memory
reviewer. Semantic assessment is a discrete pass or fail; the benchmark does
not present model-generated decimal scores as precise quality measurements.

## Boundaries

Curated Memory remains Personal by default. An Operator may offer
`curated_assertions` as an explicit Shared Memory representation, but the owner
must select it through the same preview, policy intersection, consent, Share
Grant, and materialization lifecycle as every other representation. Curated
assertions are never appended to transcript representations.

The representation includes only current, unexpired assertions for which every
active direct source role is wholly inside the exact granted Captured Session.
Conversation Items and Memory Events must belong directly to that session. An
LCM Summary is eligible only when its complete active descendant source set
exists and belongs to the session. Missing, deleted, excluded, invalidated,
suppressed, expired, or mixed-session evidence fails closed. Derived links do
not broaden this direct-source decision.

Personal Curated payloads are decrypted with the Personal/base provider. The
redacted artifact and preview use the owner-private replica provider, and the
Team representation uses the Team provider. Materialization rejects key
substitution across these three boundaries. Curated acceptance and
reconciliation rematerialize active continuous grants immediately. Assertion
or source lifecycle changes run database invalidation triggers in the same
transaction as the Personal mutation. Those triggers invalidate the affected
Team representation and delete its semantic routing/vector rows before either
side can commit; an invalidation error rolls the Personal mutation back.

Team semantic search and expansion expose only grant-scoped pseudonymous
lineage from the encrypted Team representation. Canonical Personal assertion
IDs, source IDs, and plaintext routing metadata are not Team search fields.

API Tokens remain personal-memory credentials. Curated Memory routes use the
same personal API-token boundary as the existing MCP and capture endpoints.

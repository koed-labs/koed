# Durable Memory Answer Execution

Personal and Team `memory_answer` calls use one durable execution path.
PostgreSQL stores acceptance, lease, cancellation, retry, result, and retention
state in `memory_answer_tasks`. For a Team Workspace request, the authoritative
Team backend holds that record. The `koed-server`-supervised Local AI Runtime
is the only task consumer and the only component allowed to invoke an AI Client
for Answer Synthesis. The MCP Server and the Pi extension own presentation only. Pi's
session-history receipts and the Codex Stop adapter's one-use receipts hold
delivery identity, never task results or a second execution queue.

Project-scoped Personal tasks resolve and pin repository context before acceptance.
The encrypted request retains the target root, selected identity, branch, and
resolution/provenance fields. Workers use that stored context across retries;
collection remains User-owned. Current assignment and source-access checks still
apply during recall. See [Personal repository recall](repository-recall.md).

Team Project tasks also pin resolved portable repository context before
acceptance. Unresolved and device-local targets fail with a Project-resolution
error. The stored context cannot change the selected Team Workspace or backend.
Team search and expansion match the Share Grant's repository snapshot, and
collection rechecks the original Workspace and Share Grant authority before
decrypting a completed answer. A revoked source therefore cannot remain
collectable merely because its answer finished earlier.

## Request Flow

1. An adapter forwards one validated `memory_answer` call and, when available,
   its host invocation identity to the loopback Local AI Runtime.
2. The runtime accepts an encrypted task through the authenticated API. For
   Personal Memory, this is the API of the User's backend. For a Team
   Workspace, this is the API of the authoritative Team backend. Admission
   locks the owner, enforces the configured durable backlog bound
   transactionally, and only then inserts the task. Repeating the same
   owner, origin, and invocation identity returns the existing task even when
   the queue is full.
3. The runtime scheduler claims due work with a lease and generation fence.
   Request decryption and validation complete in the claim transaction, so an
   unreadable request is never committed as running. Terminal transitions made
   while reconciling expired leases are returned to the runtime and published
   to attached waiters.
4. The selected Codex, Claude Code, or Pi driver performs synthesis. Provider
   stream activity and completed retrieval operations report progress; timer
   ticks and lease heartbeats do not.
5. Koed creates the final Memory Question with a task-derived idempotency key,
   then commits the encrypted terminal task result through the current fence.
6. An attached waiter receives the result immediately. A disconnected waiter
   can read current state and resubscribe without affecting execution.

The runtime's bounded database reconciliation is infrastructure work, not
model polling. Koed exposes no task status, wait, or queue tool to the model.

## Evidence Reference Lifetime

Within one Memory Answer execution, the helper can select evidence it was
shown earlier even after a later search replaces that candidate in the working
set. Prompt and tool observations carry request-local stable `evidence_index`
values. Indexes are not positions in the latest ranked list. Koed keeps the
bounded evidence snapshots and their complete observed references for final
selection, including references from earlier validation attempts.

The configured working-set candidate, item and token limits still apply. Only admitted
evidence is exposed as selectable tool results. The observation history is
bounded by one initial evidence budget plus one for each permitted search or
expansion: at most `(1 + maxSearches + maxExpansions)` times the configured
evidence item and token limits. Duplicate observations reuse their indexes.
Final selected support must still fit the normal answer item and evidence-token
limits; retaining history does not allow fabricated references or a different
visibility to pass validation. Retrieval authorization boundaries are unchanged.

This history is execution-local, not another durable evidence store or an access
grant. A separate Memory Answer starts a new helper task and retrieves evidence
again through the normal authorized pipeline. Existing durable source records
and final Memory Question persistence remain the source of later retrieval.

## Queue And Failure Ownership

BullMQ and the generic local work queue are intentionally not used. Their
backend workers cannot own AI Client synthesis under ADR 0001. A dedicated
task record is also separate from Memory Questions, which remain final
user-facing history rather than queue records.

Accepted work survives adapter disconnection and runtime restart. An expired
lease can be claimed with a new generation; the old generation cannot
heartbeat or commit. A stop between final-question persistence and task
completion may repeat synthesis, but the deterministic question idempotency
key prevents duplicate history. Terminal task records expire after 24 hours;
Memory Question retention is independent.

Task request, result, and failure detail are envelope encrypted. Ordinary task
logs contain identifiers, state, attempts, fences, and bounded error codes but
never queries, answers, evidence, caller paths, or provider payloads.

`KOED_LOCAL_AI_RUNTIME_MAX_ACTIVE_ANSWERS` is one shared execution limit across
durable Personal tasks, durable Team tasks, and blocking Desktop work. These
paths cannot each consume the full limit independently. `KOED_LOCAL_AI_RUNTIME_MAX_QUEUED_ANSWERS`
limits both the per-owner durable accepted backlog and the remaining bounded
in-process blocking queue. Durable lifecycle calls use the AI Client control
rate-limit policy rather than consuming the ordinary memory-write allowance.

## Cancellation And Time Limits

Closing an MCP or loopback request detaches only that waiter. Explicit task
cancellation records intent, aborts the exact in-process attempt, and fences a
late result.

- `MEMORY_ANSWER_NO_PROGRESS_TIMEOUT_MS` defaults to `300000`. Completed
  synthesis, search, and expand milestones reset this watchdog.
- `MEMORY_ANSWER_HARD_TIMEOUT_MS` defaults to `1800000` and bounds an attempt
  regardless of progress. The persisted `timeout_ms` AI Client assignment is
  the same hard provider-execution ceiling.
- The internal execution lease defaults to 60 seconds and is renewed every 15
  seconds. Heartbeats are serialized, and lease renewal is not progress.

The attempt controller records one first-wins termination reason for explicit
cancellation, shutdown, lease loss, no-progress expiry, hard timeout, or
execution failure. Personal eligibility is checked again immediately before
synthesis, so a routing change cannot execute a queued Personal task against a
Team Workspace.

The removed `MEMORY_ANSWER_TIMEOUT_MS` name has no compatibility alias.

## Evidence Selection And Budgets

### Complete Evidence Admission

The default evidence allowance is 24,000 tokens for the helper working set and,
independently, final selected support. The default cumulative prompt budget is
48,000 tokens. Both remain configurable; search, expansion and item-count limits
are unchanged. Existing explicit environment overrides retain their values.

The helper receives complete source text with the identity, actor, timing and
lineage needed to interpret and cite it. Repeated internal citation and
retrieval metadata stays in Koed's Evidence Bundle rather than consuming the
helper's evidence budget multiple times. Admission counts the serialized
helper-visible representation; it does not discount bytes that are still sent
to the AI Client. Provider-reported usage remains separate from this local
tokenizer-based budget.

An explicit expansion prioritizes its requested sources over earlier working-set
evidence. Earlier evidence already shown to the helper remains available for
final reference selection through its stable execution-local identity. Changing
working-set priority does not automatically select new evidence for the answer,
discard a selected parent summary or treat a parent and its children as
independent corroboration.

When a broad expansion omits sources and another expansion is available, prompt
packing reserves room for one independently fitting omitted source and its
navigation envelope. This prevents the broad response from consuming all space
needed for targeted recovery. A request that explicitly selects sources uses the
remaining budget normally. The reservation does not increase the configured
limit or guarantee that every source can fit.

Search and expansion disclose bounded navigation information for omitted sources,
including the applicable item or token limit. They also report configured and
remaining evidence and prompt budgets. Navigation information contains no
omitted source body and is not observed, selectable support. The helper can
narrow a later expansion to identifiers returned by that authorized node.
Every request still expands through the normal repository authorization path;
an unavailable selector fails closed rather than falling back to all sources.
Team selectors refer only to the returned shared representation, not Personal
source identifiers.

Complete sources and raw event-context windows are never shortened to make them
fit. Initial admission may omit oversized evidence while allowing the helper to
inspect the omission information and attempt a supported narrower retrieval.
If the relevant complete source still cannot fit, the answer must report
insufficient bounded evidence rather than imply that no matching Memory exists.
Final selected support remains subject to the same item and token limits.
Expansion diagnostics count sources actually delivered after prompt admission,
not the sources returned by the backend before packing.

Helper observation accounting does not reduce the final Evidence Bundle's
budget. Final selected support retains its full reference metadata and is
checked independently against the existing final item and token limits. A set
that the helper read across several operations may still be too large to return
as one selected Evidence Bundle.

### Event Context

Personal Memory synthesis requests canonical event context by default. Embedding
chunks locate matches; the local worker receives the complete matched Memory
Event plus its immediate preceding and following events in the same authorised
Conversation. Neighbours use the existing `captured_at,id` order. Deleted,
ineligible or inaccessible neighbours are gaps, not permission to substitute a
more distant event. Project, Session, time, PDS-readiness and encryption
boundaries still apply. Team recall retains its separately authorised shared
representations; this does not grant access to personal neighbouring events.

LCM leaf and rollup hits remain summary evidence. They are not replaced by all
of their underlying events or admitted as one large raw-event window. The worker
can request source expansion separately when it needs the underlying detail.

Each event keeps its own source identity, actor and citation. Overlapping windows
are deduplicated, and complete windows are admitted against existing evidence
and prompt-token budgets. Canonical event text is not shortened to a preview to
make it fit. If no complete window fits, the worker reports insufficient bounded
context rather than presenting a cut statement as complete evidence. Direct
diagnostic searches may opt in with `include_event_context: true`; ordinary
diagnostic search behaviour is unchanged.

Adjacency is determined before eligibility checks: a directly adjacent row that
is excluded or inaccessible creates a gap, even when a more distant eligible
event exists. This conservative boundary avoids joining non-adjacent statements.
The order matches existing LCM compaction (`captured_at,id`); it is not a new
source-sequence chronology policy. Capture timestamps can be supplied by the
source rather than set to ingestion time; equal timestamps still use the event
ID, not source sequence, as the tie-breaker. Time filters retain the source event
time fallback. Reordering historical Conversations or changing timestamp
tie-breaking requires a separate compaction and sync compatibility decision.

## AI Client Delivery

Every route below uses the same durable task and the explicit submit-and-collect
contract described in
[asynchronous Memory Answer collection](async-memory-answer.md). None of them
exposes native MCP Tasks to the model, and none pushes a later message into an
idle Conversation.

The public MCP request can select `delivery_mode=blocking` or
`delivery_mode=non_blocking` per call. Omitted, `auto` and `blocking` wait for
the completed answer. Explicit `non_blocking` returns a task receipt promptly;
the model collects it with `memory_answer_result` and can cancel it with
`memory_answer_cancel`. This preference belongs to presentation and is removed
before the canonical execution request reaches the Local AI Runtime. Requested
mode does not change execution priority, authority, synthesis assignment,
capacity or the `response_detail` and `include_evidence` options. See
[choosing a mode](async-memory-answer.md#choosing-a-mode) and
[submit, collect and cancel](async-memory-answer.md#submit-collect-and-cancel).

- **Codex:** uses the ordinary MCP tools. Setup installs approval rules for
  submission, collection and cancellation, and replaces older Memory Answer
  Stop-hook delivery. The legacy `--deferred-recall` and `--blocking-recall`
  setup flags are accepted but deprecated; see
  [Codex integration](codex-integration.md#memory-answer-setup).
- **Claude Code:** uses the same ordinary MCP tools. The separate opt-in
  `setup claude --background-recall` option sets Claude's host backgrounding
  threshold for blocking MCP calls. It applies to every MCP Server, not only
  Koed, and is independent of Koed's explicit non-blocking mode.
- **Pi:** the extension exposes the same submit-and-collect interaction in
  every session type. The former `KOED_PI_MEMORY_ANSWER_MODE` setting no longer
  selects automatic follow-up delivery; see [Pi integration](pi-integration.md#recall).
- **ACP:** no ACP runtime is added. A future adapter can map its native task
  behavior to the same start, state, cancel, and terminal-event semantics after
  conformance testing.

AI Client capability snapshots still report host task notification and model
continuation as `unsupported` for Claude Code and `requires_bridge` for Codex
and Pi. Explicit collection does not depend on either capability.

## Team Workspace Execution

Team Workspace Memory Answer uses the same task repository, scheduler, local
synthesis worker, and delivery lifecycle as Personal Memory. Blocking and
deferred delivery change only how the adapter presents the result, not how the
task runs. Koed never creates a local Personal task for Team work.

An executor is the Local AI Runtime that runs synthesis for a task. A Team
request runs only when all of these conditions are true:

- The authoritative Team backend advertises version 2 of `memory.answerTasks`
  with Team support.
- The executor has Team execution authority.
- The Team Workspace, from `team_workspace_id` or the Project link, appears in
  authorized Workspace discovery for the selected backend.

An enrolled executor gets Team execution authority from the `--memory-answers`
enrollment permission and the Team read permission. For the enrollment steps,
see [manual control-plane commands](running-koed.md#manual-control-plane-commands).
A delegated executor needs the local-execution scope and the Team-read scope.
Personal API Tokens stay Personal-only.

If one of these conditions is false, the runtime rejects the request before
acceptance. Koed does not use blocking recall, Personal Memory, or evidence in
the main agent context instead. If the running Local AI Runtime does not support
Team tasks, the MCP Server returns an instruction to restart the runtime.

At acceptance, the Team backend freezes the authorized Share Grant boundary for
the task. Before decryption, lease renewal, completion, and result delivery,
the Team backend makes sure that the current User, membership, Workspace access,
and original grants are valid. New grants cannot expand the access of an
accepted task.

An executor claims a task to run it. By default, a claim takes only Personal
work. A Team claim needs an explicit scope selector. A Team-only executor cannot
claim Personal work.

The Team backend saves the final Memory Question in the same transaction as the
final task state. As a result, an attempt with an old generation cannot leave a
completed history record. For the decision, see the Personal and Team Execution
amendment in [ADR 0043](adr/0043-durable-memory-answer-execution.md) and
[ADR 0056](adr/0056-delegated-remote-mcp-and-headless-local-execution.md).

## Runtime Contract

The owner-authenticated loopback runtime exposes start, get, cancel, and an SSE
stream for one task. Start validates the public Memory Answer request before
eligibility checks. Explicit Personal Project and Folder targets are bound to
the authenticated owner and normalized before acceptance. Their versioned
selection stays in the encrypted task request; workers use the pinned execution
input and never rediscover a target from their directory. Legacy requests retain
their existing defaults. If a Team Workspace request has no authorized Team
task route, start rejects it before acceptance. A stream resolves ownership and
retention before sending success headers. It emits current state first, then monotonic
task versions and keepalive comments, and honors `Last-Event-ID`. Every event
and keepalive is backed by a fresh authorized read; expiry or revoked access
ends the stream. These endpoints are harness/runtime plumbing,
not public model tools. The API exposes owner-authorized accept, read, claim,
heartbeat, cancellation, terminal transition, and terminal-expiry operations.

See [ADR 0043](adr/0043-durable-memory-answer-execution.md) for the decision and
trade-offs.

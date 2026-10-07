# Durable Memory Answer Execution

Personal `memory_answer` calls use one durable execution path. PostgreSQL
stores acceptance, lease, cancellation, retry, result, and retention state in
`memory_answer_tasks`. The `koed-server`-supervised Local AI Runtime is the only
task consumer and the only component allowed to invoke an AI Client for Answer
Synthesis. The MCP Server and the Pi extension own presentation only. Pi's
session-history receipts and the Codex Stop adapter's one-use receipts hold
delivery identity, never task results or a second execution queue.

## Request Flow

1. An adapter forwards one validated `memory_answer` call and, when available,
   its host invocation identity to the loopback Local AI Runtime.
2. The runtime accepts an encrypted Personal task through the authenticated
   API. Admission locks the owner, enforces the configured durable backlog
   bound transactionally, and only then inserts the task. Repeating the same
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
durable Personal tasks and blocking Team/Desktop work; those paths cannot each
consume the full limit independently. `KOED_LOCAL_AI_RUNTIME_MAX_QUEUED_ANSWERS`
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

## AI Client Delivery

Every route below uses the same durable task and the shared delivery lifecycle
described in [asynchronous Memory Answer delivery](async-memory-answer.md). None
of them exposes native MCP Tasks or a status tool to the model.

- **Codex:** recall is blocking by default. The opt-in
  `setup codex --deferred-recall` route installs native Codex hooks. The CLI,
  IDE extension and Desktop app were each tested separately; see
  [Codex integration](codex-integration.md#optional-deferred-recall-in-the-native-cli).
  A PreToolUse hook binds a one-use receipt to the exact
  session, turn and tool call. `memory_answer` then returns a pending receipt,
  and the Stop hook waits outside the model loop and supplies the result to
  that same turn. This keeps the original turn active; it does not wake an
  idle Conversation. Pending delivery after a backend loss, Local AI Runtime
  restart or session exit is unsupported. A known upstream race can admit a
  late hook prompt into an interrupted turn. Responses API asynchronous
  function calling still requires an upstream Codex bridge that keeps the
  original `call_id`.
- **Claude Code:** Koed returns the ordinary blocking MCP result. The opt-in
  `setup claude --background-recall` option sets Claude's host backgrounding
  threshold, so interactive Claude Code can release the main Conversation
  while the call is pending and deliver the result through a native
  notification. The threshold applies to every MCP Server, not only Koed.
- **Pi:** in a persistent Conversation, `memory_answer` returns an attributed
  receipt promptly. The extension observes the task and delivers the result as
  a follow-up message that starts a turn. Matching pending receipts recover
  when the same Conversation reopens. Ephemeral sessions, Team Workspace
  calls, clients without the required Pi APIs, and
  `KOED_PI_MEMORY_ANSWER_MODE=blocking` use blocking recall.
- **ACP:** no ACP runtime is added. A future adapter can map its native task
  behavior to the same start, state, cancel, and terminal-event semantics after
  conformance testing.

AI Client capability snapshots still report host task notification and model
continuation as `unsupported` for Claude Code and `requires_bridge` for Codex
and Pi. They do not yet reflect the opt-in Codex and Claude routes or Pi's
default deferred delivery.

Team Workspace Memory Answer remains on its existing blocking authority path.
It must not create a local Personal task; asynchronous Team execution requires
the upstream authority to own acceptance and terminal history atomically.

## Runtime Contract

The owner-authenticated loopback runtime exposes start, get, cancel, and an SSE
stream for one task. Start validates and applies the Memory Answer input schema
before eligibility checks; Team Workspace requests receive HTTP 409 with
`memory_answer_team_ineligible`. A stream resolves ownership and retention
before sending success headers. It emits current state first, then monotonic
task versions and keepalive comments, and honors `Last-Event-ID`. Every event
and keepalive is backed by a fresh authorized read; expiry or revoked access
ends the stream. These endpoints are harness/runtime plumbing,
not public model tools. The API exposes owner-authorized accept, read, claim,
heartbeat, cancellation, terminal transition, and terminal-expiry operations.

See [ADR 0043](adr/0043-durable-memory-answer-execution.md) for the decision and
trade-offs.

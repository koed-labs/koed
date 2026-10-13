# Durable Memory Answer Execution

Personal and Team `memory_answer` calls use one durable execution path.
PostgreSQL stores acceptance, lease, cancellation, retry, result, and retention
state in `memory_answer_tasks`. For a Team Workspace request, the authoritative
Team backend holds that record. The `koed-server`-supervised Local AI Runtime
is the only task consumer and the only component allowed to invoke an AI Client
for Answer Synthesis. The MCP Server and the Pi extension own presentation only. Pi's
session-history receipts and the Codex Stop adapter's one-use receipts hold
delivery identity, never task results or a second execution queue.

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

## AI Client Delivery

Every route below uses the same durable task and the shared delivery lifecycle
described in [asynchronous Memory Answer delivery](async-memory-answer.md). None
of them exposes native MCP Tasks or a status tool to the model.

The public MCP request can select `delivery_mode=blocking` or
`delivery_mode=non_blocking` per call. Omitted and `auto` retain configured
defaults. This preference belongs to presentation and is removed before the
canonical execution request reaches the Local AI Runtime. Blocking Personal
recall retains its runtime observer and the same durable task path; it creates
no deferred adapter receipt. Requested mode does not change execution priority,
authority, synthesis assignment, or capacity. See
[per-call delivery selection](async-memory-answer.md#per-call-delivery-selection).

- **Codex:** recall is deferred by default, except on Windows. Setup installs
  native Codex hooks; `setup codex --blocking-recall` opts out. The CLI, IDE extension and
  Desktop app were each tested separately; see
  [Codex integration](codex-integration.md#deferred-recall-in-the-native-cli).
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
  when the same Conversation reopens. Ephemeral sessions, single-shot print
  and JSON runs, Koed Desktop-managed Pi Conversations, clients without the
  required Pi APIs, and
  `KOED_PI_MEMORY_ANSWER_MODE=blocking` use blocking recall. A completion that
  arrives during `/tree` navigation can be saved on the destination branch; see
  [asynchronous Memory Answer delivery](async-memory-answer.md#recovery-and-limits).
- **ACP:** no ACP runtime is added. A future adapter can map its native task
  behavior to the same start, state, cancel, and terminal-event semantics after
  conformance testing.

AI Client capability snapshots still report host task notification and model
continuation as `unsupported` for Claude Code and `requires_bridge` for Codex
and Pi. They do not yet reflect the opt-in Claude route or the default
deferred delivery for Codex and Pi.

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
stream for one task. Start validates and applies the Memory Answer input schema
before eligibility checks. If a Team Workspace request has no authorized Team
task route, start rejects it before acceptance. A stream resolves ownership and
retention before sending success headers. It emits current state first, then monotonic
task versions and keepalive comments, and honors `Last-Event-ID`. Every event
and keepalive is backed by a fresh authorized read; expiry or revoked access
ends the stream. These endpoints are harness/runtime plumbing,
not public model tools. The API exposes owner-authorized accept, read, claim,
heartbeat, cancellation, terminal transition, and terminal-expiry operations.

See [ADR 0043](adr/0043-durable-memory-answer-execution.md) for the decision and
trade-offs.

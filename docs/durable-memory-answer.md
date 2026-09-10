# Durable Memory Answer Execution

Personal `memory_answer` calls use one durable execution path. The MCP adapter
and Pi extension remain stateless forwarders; PostgreSQL stores acceptance,
lease, cancellation, retry, result, and retention state in
`memory_answer_tasks`. The `koed-server`-supervised Local AI Runtime is the only
task consumer and the only component allowed to invoke an AI Client for Answer
Synthesis.

## Request Flow

1. An adapter forwards one validated `memory_answer` call and, when available,
   its host invocation identity to the loopback Local AI Runtime.
2. The runtime accepts an encrypted Personal task through the authenticated
   API. Repeating the same owner, origin, and invocation identity returns the
   existing task.
3. The runtime scheduler claims due work with a lease and generation fence.
4. The selected Codex, Claude Code, or Pi driver performs synthesis. Completed
   retrieval operations report progress; timer ticks and lease heartbeats do
   not.
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
  seconds. Lease renewal is not progress.

The removed `MEMORY_ANSWER_TIMEOUT_MS` name has no compatibility alias.

## AI Client Delivery

- **Codex:** current supported Codex receives the terminal result through its
  blocking MCP call. Responses API asynchronous function calling cannot be
  enabled only in Koed: Codex must retain the original Responses `call_id`,
  accept a pushed terminal result, recover that mapping after restart, and
  submit exactly one `function_call_output`. Until a released Codex and model
  pass that trace, host notification and model continuation are
  `requires_bridge`.
- **Claude Code:** the Agent SDK requires the matching tool result before model
  continuation. Claude waits on the same durable task; host notification and
  continuation are `unsupported`, not simulated with a receipt.
- **Pi:** the Koed extension forwards Pi's session/tool-call identity and waits
  for the terminal runtime body. Detached `sendMessage` injection remains
  disabled because the supported contract does not prove ordering,
  attribution, restart recovery, and exact-once delivery. Those capabilities
  remain `requires_bridge`.
- **ACP:** no ACP runtime is added. A future adapter can map its native task
  behavior to the same start, state, cancel, and terminal-event semantics after
  conformance testing.

Team Workspace Memory Answer remains on its existing blocking authority path.
It must not create a local Personal task; asynchronous Team execution requires
the upstream authority to own acceptance and terminal history atomically.

## Runtime Contract

The owner-authenticated loopback runtime exposes start, get, cancel, and an SSE
stream for one task. Streams emit current state first, then monotonic task
versions and keepalive comments. These endpoints are harness/runtime plumbing,
not public model tools. The API exposes owner-authorized accept, read, claim,
heartbeat, cancellation, terminal transition, and terminal-expiry operations.

See [ADR 0043](adr/0043-durable-memory-answer-execution.md) for the decision and
trade-offs.

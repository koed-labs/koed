# ADR 0043: Durable Memory Answer Execution

- Status: Accepted
- Date: 2026-09-10

Related decisions:

- [0001 AI Client Synthesis Only](./0001-ai-client-synthesis-only.md)
- [0025 MCP V2 Local AI Runtime Ownership](./0025-mcp-v2-local-ai-runtime-ownership.md)
- [0026 Pre-Launch Schema Reset And Processing Epochs](./0026-pre-launch-schema-reset-and-processing-epochs.md)
- [0032 AI Client Instance, Capability, And Permission Contracts](./0032-ai-client-instance-capability-and-permission-contracts.md)

## Context

A Memory Answer commonly takes 30-60 seconds and can legitimately take longer.
The current tool request owns an in-memory admission slot and a provider
wall-clock timeout. Closing that request cancels work, and a Local AI Runtime
restart loses queued work. Asking a model to poll a status tool would waste
turns and tokens and would not give the model a reliable concept of elapsed
time.

MCP has a draft Tasks extension for protocol revision `2026-07-28`, but the
pinned TypeScript MCP v2 server deliberately does not implement that extension
runtime. Current supported Codex and Claude hosts also do not provide a proven
deferred MCP tool-result contract. Pi has an owned extension seam, but deferred
result injection still requires provenance, ordering, and recovery evidence.

Koed has no customer migration requirement. It should not retain duplicate
execution paths or obsolete configuration solely for compatibility. It must,
however, satisfy the actual blocking tool-result contract of a currently
supported AI Client until that client proves a deferred contract.

## Decision

All Personal Memory Answer execution uses one durable task path. PostgreSQL is
authoritative for acceptance, status, retry timing, cancellation intent,
execution lease, fence generation, terminal result, and retention. A
purpose-built `memory_answer_tasks` record owns that execution state. It is not
a generic job framework.

The `koed-server`-supervised Local AI Runtime remains the only component that
may run Answer Synthesis. It claims tasks through authenticated API operations,
heartbeats the current fenced generation, and commits terminal state. The
backend Worker, BullMQ workers, and the generic local work queue never execute
Memory Answers.

Memory Questions remain completed user-facing records as required by ADR 0026.
They do not become pending jobs or leases. A successful or application-error
result creates the final Personal Memory Question with a deterministic,
task-derived idempotency key, then a fenced task transition links the result.
If the runtime stops between those writes, recovery may repeat synthesis but
reuses the same Memory Question and a stale attempt cannot commit. This avoids
duplicating encrypted Memory Question persistence inside the task repository.
Cancellation before a result creates no Memory Question.

An accepted task survives MCP adapter and loopback request disconnects.
Transport closure detaches a waiter; it is no longer cancellation authority.
Cancellation requires an explicit authorized request or a Local AI Runtime
policy event such as a no-progress watchdog or hard execution ceiling. This
narrows ADR 0025's earlier statement that shared-channel stdio closure cancels
the underlying Memory Answer.

The Local AI Runtime may keep bounded in-process listeners to push state to
attached hosts. Those listeners are delivery only. A reconnect first reads the
owned PostgreSQL state, compares its monotonic version, and then subscribes
again. No durable event outbox is added while one Local AI Runtime owns local
synthesis per `KOED_HOME`.

MCP and Claude adapters wait outside the model loop for the durable task and
return the existing tool result. This is one execution path with a blocking
presentation contract, not a compatibility executor. Koed does not expose
task-status or wait tools to the model.

Native MCP Tasks will be adopted only through a maintained SDK extension after
both server and host support pass conformance tests. Koed will not hand-roll a
parallel MCP dispatcher. Codex Responses async function calling requires an
upstream Codex bridge that retains the original `call_id`; Koed reports that
capability as `requires_bridge` until a released version passes end-to-end
tests. Pi follows the same rule for deferred session-message injection. ACP is
deferred to a separate decision.

One fixed provider wall-clock timeout is replaced by an execution lease, a
no-progress watchdog reset by classified provider events, and a hard execution
ceiling. Timer ticks and lease heartbeats are not progress. Obsolete timeout
configuration is replaced directly rather than retained behind aliases.

Team Workspace Memory Answer remains blocking until its upstream authority can
atomically own task acceptance and terminal history. Koed does not create a
local Personal task that misrepresents Team execution authority.

## Consequences

- A model invokes `memory_answer` once and never polls a Koed status tool.
- Accepted Personal work can outlive an adapter connection and can be recovered
  after a Local AI Runtime restart.
- Blocking AI Clients do not gain model continuation, and Koed does not claim
  that they do.
- A separate task record is necessary because accepted ADRs keep Memory
  Questions as completed domain records and keep generic Worker queues outside
  local synthesis ownership.
- No generic async-task framework, task outbox, BullMQ consumer, queue
  dashboard, MCP protocol fork, deprecated timeout alias, or ACP runtime is
  introduced.
- If Local AI Runtime ownership becomes distributed, durable event fanout must
  be reconsidered explicitly.

## Required Evidence

- encrypted task payloads contain no plaintext query, answer, caller path, or
  provider payload in task rows or logs;
- owner isolation applies to accept, read, cancel, claim, heartbeat, and
  terminal writes;
- stale lease generations cannot report progress or commit;
- adapter disconnect, runtime restart, and cancellation races do not duplicate
  terminal Memory Questions;
- productive long work survives the old timeout while silent work and every
  runaway attempt remain bounded;
- Codex, Claude, and Pi capability snapshots describe host wait, host push, and
  model continuation independently;
- existing result-detail modes, Evidence Bundles, capture, Projection,
  ownership, and Team authorization remain unchanged.

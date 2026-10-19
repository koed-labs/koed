# Scheduled Jobs design reference (HQ-600)

**Status:** Design comparison only. No Scheduled Jobs runtime feature is
implemented or validated by this note. HQ-601 remains gated on this note being
merged and reviewed by a human.

## Decision

Do not integrate or vendor OpenDots, copy its code, or add its packages. Rebuild
the useful interaction ideas against Koed's own data and authorization
contracts. Scheduled work remains owned by the user's Local AI Runtime and
executes through the user's selected AI Client, consistent with [ADR 0001](./adr/0001-ai-client-synthesis-only.md)
and [ADR 0043](./adr/0043-durable-memory-answer-execution.md). No server-side
worker may call an LLM for a scheduled run. Memory remains user-owned and each
run uses only the authority already available to that User and Conversation.

## Reference examined

This comparison is pinned to OpenDots commit
[`ab39f2508f3fd23a949837622456f3d61a108e9a`](https://github.com/CopilotKit/OpenDots/commit/ab39f2508f3fd23a949837622456f3d61a108e9a)
(15 October 2026). Its [LICENSE at that commit](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/LICENSE)
is MIT, copyright Atai Barkai.
No source code was adapted or copied.

The [README](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/README.md)
describes scheduled server-side turns in their original conversation, with
pause and retry controls. It also says schedules are recurring instructions,
not a complete goal or event-trigger system. The implementation stores task
and run records in a local SQLite database; its server constructs a runner
callback ([`index.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/index.ts#L74-L88))
and starts it from the serve path
([`index.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/index.ts#L115-L118),
[`store.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/store.ts#L23-L37)).

In that implementation, a task stores an interval and a `nextRunAt`; a
successful run schedules the next interval from its completion time. The
runner polls once per second
([`runner.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/runner.ts#L20-L24)),
runs at most one task at a time in that server process under an active-run
guard ([`runner.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/runner.ts#L55-L63)),
and claims a task under a lease. Expired leases become Interrupted.
Retry queues the task again; a later claim creates a new run record. The
README asks the owner to review completed effects before retrying because an
interrupted run may already have changed external state
([README](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/README.md#L181),
[`runner.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/runner.ts#L55-L63),
[`store.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/store.ts#L150-L164),
[`store.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/store.ts#L187-L243)).
The task-to-thread binding is separate from the task row, and the runner sends
each run through that thread
([`workspace.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/workspace.ts#L21-L26),
[`workspace.ts`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/src/server/workspace.ts#L268-L309)).

OpenDots approval cards pause Ask-first tool calls until the owner approves.
For scheduled runs and Slack, its connection documentation directs the owner
to continue in the web app. Its Slack channel and voice compute agent are
separate adapters, not schedule triggers
([`CONNECTIONS.md`](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/docs/CONNECTIONS.md#L17),
[README](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/README.md#L79-L107)).
The README distinguishes local fixture checks from connected-service
verification and says cloud schedules still need connected-service
verification ([README](https://github.com/CopilotKit/OpenDots/blob/ab39f2508f3fd23a949837622456f3d61a108e9a/README.md#L182-L184)).
This was a source review only: OpenDots was not installed or executed, and no
Koed scheduler runtime validation is claimed.

## Borrow, adapt, and skip

| OpenDots idea or behavior                                                 | Koed disposition                                                 | Reason and boundary                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named Dots with a role, instructions, and allowed tools                   | **Borrow the interaction; map to Agent.**                        | A Scheduled Job names a Koed Agent and uses its configured instructions and capabilities. The run stays under the owning User's Local AI Runtime and AI Client.                                                                                                                                                                                                                         |
| A task is bound to a durable conversation; scheduled work continues in it | **Adapt; map task thread to the Job's Conversation.**            | Every Koed run is a new turn in the same `conversation_session_id`, as section 6.8 specifies. The optional Project supplies local context. A Project Thread is not a job Conversation or agent input; Team messages stay outside Memory and Agent input under D2.                                                                                                                       |
| Space or task context                                                     | **Use as a conceptual mapping to a User-owned Project/context.** | This maps the user-facing role of optional context only. It does not assert how OpenDots stores a Space, or equate a Koed Project with a Team Workspace Project.                                                                                                                                                                                                                        |
| Recurring interval tasks                                                  | **Skip OpenDots' interval model.**                               | Koed uses the calendar schedule syntax and timezone rules below. OpenDots schedules the next interval after a successful run; it does not define Koed's daily, weekday, weekly, monthly, DST, or device-ownership behavior.                                                                                                                                                             |
| Polling runner, task/run history, and leases                              | **Adapt only durable execution principles.**                     | Use Koed's own run records and the fenced lease/attempt approach in [ADR 0043](./adr/0043-durable-memory-answer-execution.md). Do not use OpenDots' server-side runner or SQLite schema. Koed's existing `memory_answer_tasks` lease owner is a runtime-process token, not a device identity, and that table has no `runner_device_id`; the scheduled-job device gate must be explicit. |
| Interrupted runs wait for owner review before retry                       | **Borrow the recovery interaction; use Koed's run identity.**    | Surface interrupted work in Needs you with Retry and Skip. A retry increments `attempt` on the same scheduled run row; it is not a new scheduled run. Review completed effects before retry because a crashed AI Client may have performed external actions without returning a final result.                                                                                           |
| Ask-first tools pause for “Approve & run”                                 | **Adapt to Koed's existing permission and approval flows.**      | An approval-waiting run stays `waiting_approval` and prevents overlap. Use the existing Ask first path for ordinary tool approval. Full access does not waive a separate Native review or Step-up requirement under [ADR 0024](./adr/0024-tiered-desktop-action-approval.md), and it never bypasses D7's merge approval.                                                                |
| Slack and realtime voice adapters                                         | **Skip as scheduler ownership or trigger mechanisms.**           | They may inform later presentation work, but they do not decide when a Koed Scheduled Job runs or which device owns it. A scheduled turn still targets its bound Koed Conversation and Local AI Runtime.                                                                                                                                                                                |
| OpenDots memory store and provider/runtime wiring                         | **Skip.**                                                        | Koed Memory remains user-owned and uses Koed's existing authorized retrieval and AI Client execution path. Do not add server-side LLM calls or copy OpenDots' memory, thread, task, or tool infrastructure.                                                                                                                                                                             |

## Koed schedule and run contract

This note confirms the scheduled-job rules in the integration plan without
amending them.

### Job and schedule

A job records its owner, optional Project, Agent, Conversation, title,
instruction, schedule, paused state, assigned `runner_device_id`, creation
time, and version. The initial runner device is the device that creates the
job; Settings can change that assignment. The schedule is:

```text
{ kind: daily | weekdays | weekly | monthly,
  at: "HH:MM",
  dow?: [1..7],
  dom?: 1..31,
  tz: IANA }
```

`dom` values beyond a month's length run on that month's last day. Times are
wall-clock times in the stored IANA timezone. A time in a spring-forward gap
runs at the first valid minute after the gap. A time in a fall-back repeated
hour runs once, at its first occurrence.

### Run lifecycle

Each `scheduled_job_runs` row is unique for `(job_id, scheduled_for)` and
records its ID, job ID, scheduled time, `scheduled` or `manual` trigger,
attempt, status, skip reason, start and finish times, execution ID, and error.
The normal lifecycle is:

```text
scheduled → running → [waiting_approval] → ok | failed | interrupted
```

`waiting_approval` is optional; a run can terminate directly from `running`.

Runs that never start become `missed` when the assigned device is asleep or
offline past the 15-minute grace period. A run becomes `skipped` when it is
paused, overlaps another active run, or the User selects Skip. Only one run
may be active per job. If the previous run remains `running` or
`waiting_approval` at the next due time, record the new occurrence as
`skipped` with reason `overlap`.

An interrupted run waits in Needs you for Retry or Skip. Retry is another
attempt on that same run row. “Run now” creates a `manual` run for the current
time. Each run is a new turn in the job's bound Conversation. Only
the Local AI Runtime on the job's assigned `runner_device_id` may claim that
job; another online device must never run it. The device assignment can be
changed in Settings.

## Koed implementation anchors

Koed already supervises a Local AI Runtime process and shares its capacity
budget between blocking answers and durable tasks. The runtime uses a
reconciliation loop and fenced lease generations for `memory_answer_tasks`;
the database claim path serializes claims and rejects stale heartbeats and
terminal writes. These are useful implementation anchors, not a generic job
framework and not proof of Scheduled Jobs support:

- [ADR 0043](./adr/0043-durable-memory-answer-execution.md) and
  [Durable Memory Answer Execution](./durable-memory-answer.md) define current
  runtime ownership and task recovery.
- `packages/koed-server/src/start.ts` supervises the Local AI Runtime.
- `packages/mcp-server/src/local-runtime-server.ts` constructs the current
  task scheduler and shares execution capacity.
- `packages/mcp-server/src/memory-answer-task-scheduler.ts` owns a
  per-process lease-owner token, retry timing, heartbeat, and fence handling.
- `packages/db/src/schema.ts` defines `memory_answer_tasks`; it has attempt,
  lease, and fence fields, but no device-assignment field.
- `packages/db/src/memory-answer-task-repository.ts` claims owner-scoped work
  with `FOR UPDATE SKIP LOCKED` and checks the exact lease owner and fence for
  heartbeats and completion.

The repository also has device-bound leases for Managed Conversation
executions in `packages/db/src/schema.ts` and
`packages/db/src/managed-conversation-repository.ts`. That is a separate
contract; do not treat either a memory-task process lease or a Managed
Conversation execution lease as Scheduled Job device assignment without
explicit binding and validation.

## Implementation questions for HQ-601 and HQ-602

These are implementation details to resolve while preserving the contract
above, not open product decisions:

- Store and validate the IANA timezone and schedule shape at the API boundary;
  use one deterministic occurrence calculation for display and dispatch.
- Materialize each due occurrence idempotently under the
  `(job_id, scheduled_for)` uniqueness rule, including after restart and
  concurrent scheduler ticks. Keep manual runs distinct from scheduled
  occurrences.
- Bind claims, renewals, retries, and terminal writes to the current job
  version, assigned device, execution generation, and lease fence. A settings
  change or stale runtime must not execute or commit an old assignment.
- Test the DST gap/repeat rules, month-end clamp, 15-minute missed boundary,
  overlap while `waiting_approval`, same-row retry attempts, Run now, process
  restart, stale-fence rejection, and competing assigned/unassigned devices.

The acceptance boundary remains the Koed contract in this note and its
owning implementation tests. No OpenDots runtime result substitutes for
Koed tests or human review.

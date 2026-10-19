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
{ kind: "daily", at: "HH:MM", tz: "IANA" }
{ kind: "weekdays", at: "HH:MM", tz: "IANA" }
{ kind: "weekly", at: "HH:MM", dow: [1..7, ...], tz: "IANA" }
{ kind: "monthly", at: "HH:MM", dom: 1..31, tz: "IANA" }
```

These are strict variants selected by `kind`. `at` must be a valid 24-hour
`HH:MM` time and `tz` must name a supported IANA time zone. `weekdays` means
ISO Monday through Friday (1–5). `daily` and `weekdays` prohibit `dow` and
`dom`; `weekly` requires a nonempty array of unique integer ISO weekdays in
the range 1–7 and prohibits `dom`; `monthly` requires an integer `dom` in the
range 1–31 and prohibits `dow`. Reject unknown fields and combinations that do
not match their variant. ISO weekdays are numbered 1 for Monday through 7 for
Sunday.

`dom` values beyond a month's length run on that month's last day. Times are
wall-clock times in the stored IANA timezone. A time in a spring-forward gap
runs at the first valid minute after the gap. A time in a fall-back repeated
hour runs once, at its first occurrence.

### Run lifecycle

Each `scheduled_job_runs` row is unique for `(job_id, scheduled_for)` and
records its ID, job ID, scheduled time, `scheduled` or `manual` trigger,
attempt, status, skip reason, start and finish times, execution ID, and error.
That row is the stable occurrence identity. A retry increments its attempt on
the same row and appends lifecycle events for a distinct immutable
attempt/execution identity and lease/fence generation. Persist the attempt-start
event before launching the turn; append later state, terminal, or uncertainty
events with finish time, outcome, and error as they become known. Never
overwrite an earlier event or its identity, fence, or timestamps. The
events use existing run statuses; uncertainty describes incomplete knowledge
of client effects and is not a new run status. The
occurrence row may summarize the latest state but is not the only history. A
stale attempt or approval callback cannot resume execution, launch another
turn, invoke another Koed-mediated operation, or write a terminal result after
a newer attempt or fence takes ownership.
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

### Project and Conversation lifecycle authority

This is a target authorization contract, not an implementation claim. A job
runs through its owner's Local AI Runtime and validates the current owner,
bound Conversation lifecycle, job version, assigned device, and execution
fence. If it has a Personal Project link, validate that link's current identity
and version and the Project's current lifecycle version; validate the bound
Conversation's current identity and lifecycle version. Preserve an explicit
unscoped state when it has no Project.
A job using a shared Project must also validate the owner's exact Team
Workspace Project association, current Workspace Access, and authoritative
Workspace Project lifecycle version. Keep the private Personal Project ID
local; Team authority is the member-to-Workspace-Project association and does
not depend on a Personal Project ID stored by Team.

Recheck those bindings before claiming or renewing a lease, accepting a retry,
resuming from an approval callback, launching a turn, performing a
Koed-mediated operation, and committing a terminal result. Bind each attempt
and callback to the versions and fence it reviewed; reject stale callbacks or
worker writes after any bound value changes. Lifecycle invalidation denies
later Koed launches and resumptions, requests cancellation of in-flight AI
Client work where supported, and rejects stale Koed writes. It cannot promise
to stop or roll back unrelated tool effects an AI Client has already
performed. Keep the append-only attempt record so the User can review effects
that completed or remain uncertain when the fence changed.

The Team Backend is authoritative for a shared Workspace Project tombstone,
link, access, and lifecycle version. If that authority is unavailable or
cannot confirm current state, a shared-Project job must not claim or renew,
resume after approval, launch a scheduled turn, perform a Koed-mediated
operation, or commit completion using cached state. It fails closed until
authority can be confirmed. This gate must work
while an owner's Desktop is offline; no Team operation may rely on a write to
that Desktop's Personal database. A Personal-only job does not depend on a
Team Backend when it has no shared Project binding.

Apply [Project-sharing lifecycle](./project-sharing-lifecycle.md) when a
Conversation or Project is deleted or forgotten: deleting a Conversation
pauses a job whose own chat it is; forgetting a Conversation deletes its
Scheduled Job; deleting a Personal Project pauses its jobs before batch
success, and restoring the Project does not resume them. A Team Project
tombstone or member-access removal denies that member's Project-job dispatch
immediately in Team authority, even while the member's Desktop is offline; the
Desktop pauses its local job when it later reconciles. A stale approval,
queued invocation, lease renewal, or completion callback cannot bypass these
changes.

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
  use the strict `kind`-discriminated variants above and one deterministic
  occurrence calculation for display and dispatch. Reject extra or conflicting
  `dow`/`dom` fields, empty or duplicate weekly weekdays, invalid `HH:MM`, and
  unsupported IANA time zones before persistence or occurrence materialization.
- Materialize each due occurrence idempotently under the
  `(job_id, scheduled_for)` uniqueness rule, including after restart and
  concurrent scheduler ticks. Keep manual runs distinct from scheduled
  occurrences.
- Bind claims, renewals, retries, approval resumes, turn launches, and terminal
  writes to the current job version, assigned device, execution generation,
  and lease fence. Validate the Personal Project link and lifecycle when
  present, and preserve explicit absence for an unscoped job. For a shared
  Project, also validate the owner's exact Team Workspace Project association,
  Workspace Access, and authoritative lifecycle version; keep private Personal
  Project IDs local. Fail closed when Team authority cannot confirm them.
  Lifecycle invalidation denies later Koed launches/resumptions, requests
  cancellation of in-flight AI Client work where supported, and rejects stale
  Koed writes. Do not claim control over or rollback of unrelated tool effects
  already performed inside an AI Client; retain uncertain or completed effects
  in attempt history for User review.
- Keep one stable occurrence row while appending per-attempt lifecycle events.
  Persist attempt-start before turn dispatch; append later state, terminal, or
  uncertainty events without overwriting prior identity, execution ID, fence,
  timestamps, error, or outcome. Test that retry preserves the interrupted
  attempt history while the newer attempt gets a distinct identity.
- Test the DST gap/repeat rules, month-end clamp, 15-minute missed boundary,
  overlap while `waiting_approval`, same-row retry attempts, Run now, process
  restart, stale-fence rejection, and competing assigned/unassigned devices.
- Test Project deletion, Conversation deletion/forget, Project-link changes,
  Team lifecycle unavailability, stale approval callbacks, and lifecycle
  changes between turn launch and terminal write. No stale Koed attempt may
  launch/resume or commit a terminal result; cancellation of in-flight
  AI Client work is requested where supported, while uncertain/completed tool
  effects remain visible in appended attempt events.

The acceptance boundary remains the Koed contract in this note and its
owning implementation tests. No OpenDots runtime result substitutes for
Koed tests or human review.

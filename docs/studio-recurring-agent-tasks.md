# Recurring Agent tasks — Ticket 29

Recurring tasks belong to an Agent's owner. Each occurrence starts a new private
Personal conversation through the existing native Codex or Claude execution path.
It uses the same permissions, supported Memory flow, capture, progress and Agent
history as an ordinary chat. The schedule does not create another Agent Job
executor or a separate Memory store.

## Scheduling rules

The User approved these boundaries on 2026-10-15:

- If the selected computer is offline, run the latest missed occurrence once when
  it returns. Do not replay the backlog.
- Only the Agent's owner manages schedules. Runs and results remain private;
  sharing with a Team requires the existing explicit sharing workflow.
- Uncertain earlier effects require review before further scheduled work.

| Rule                       | First version                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Interval                   | Every 5 minutes or more, measured from a fixed UTC anchor. Completion time does not move the cadence.                           |
| Calendar                   | Daily or selected ISO weekdays at a wall-clock time in an explicit IANA time zone.                                              |
| Daylight-saving gap        | Skip a date if its chosen local time does not exist.                                                                            |
| Daylight-saving repetition | Use the first occurrence of the repeated local time, once.                                                                      |
| Missed work                | Reserve only the latest due slot and advance the next slot atomically. Calendar calculations inspect a bounded number of dates. |
| Overlap                    | At most one active occurrence per task, including manual runs and earlier task revisions.                                       |
| Run now                    | A separate idempotent request; it does not move the schedule.                                                                   |
| Create or edit             | Save paused. Activation requires explicit owner consent. Editing increments the revision.                                       |
| Pause or archive           | Prevent future starts. Already accepted native work retains its existing stop and approval controls.                            |
| Resume                     | Compute the next future slot; do not replay the paused period. Review states require acknowledgement.                           |

Times are stored as UTC instants. Calendar rules retain their time zone, so travel
or a change to the computer's zone does not silently move the schedule. Luxon
resolves calendar offsets; Koed explicitly rejects shifted gap times and selects
the earlier repeated offset. See the [Luxon API](https://moment.github.io/luxon/api-docs/index.html).

## Execution and recovery

The task binds an explicit AI Client, model, reasoning setting, permission mode,
Personal Device and optional Project. The server derives the deployment and
canonical Client binding from verified launch options. The public Client selection
and canonical binding remain distinct for hosted devices. There is no fallback to
another account, device, Client, model or backend.

An occurrence freezes the task revision and Agent version. Its persisted UUID is
also its native conversation and submission request identity. The existing native
submission transaction creates the conversation, message and delivery; a retry
uses that same identity. Each occurrence has fresh bounded conversation context
rather than accumulating an unlimited scheduled chat.

Activation waits while a pre-dispatch reservation is pending. This prevents a
revision change from stranding an explicit Run now request. Concurrent retries
of the same Run now request return the same occurrence.

The selected runner checks for work with a bounded, single-flight poll. It renews
its claim while submission is pending. Lease tokens fence stale claim holders.
Pre-dispatch reservations may be recovered under the same occurrence identity.
After dispatch might have happened, recovery observes the existing native delivery
and command rather than creating another run. An uncertain result stops the task
for owner review. Native tool approval remains pending until the owner answers it;
scheduling never grants automatic approval.

Owner, Agent activity, device credentials and deployment authority must remain
valid at dispatch and reconciliation. Retirement prevents future starts; restoring
an Agent does not reactivate its schedules. A paused schedule does not stop work
already accepted by the native runtime.

## Storage and service boundaries

Shared contracts define strict schedule, task and occurrence payloads. PostgreSQL
stores task revisions, encrypted task content and launch snapshots, occurrence
identity, claim fences and native delivery references. Reads and writes are
owner-scoped. Uniqueness and transactional claims protect against multiple windows
or runner processes racing for the same occurrence.

Owner API routes are:

- `GET` / `POST /v1/personal-agents/:agentId/recurring-tasks`
- `GET` / `PATCH /v1/recurring-agent-tasks/:taskId`
- `POST /v1/recurring-agent-tasks/:taskId/control`
- `POST /v1/recurring-agent-tasks/:taskId/run-now`
- `GET /v1/recurring-agent-tasks/:taskId/occurrences`

The runner uses `POST /v1/managed-conversation-runner/recurring-agent-tasks/claim`.
Runner identity comes from authenticated device/deployment authority, not body
fields. Local-edge forwarding uses the selected managed-execution authority and a
strict route/query allowlist. Task and occurrence lists are bounded. Opening the
Agent detail view does not start a second browser scheduler.

Agent detail supplies task editing, activation, pause, Run now, archive and recent
occurrence links. Team availability does not publish schedule prompts, private
Memory, execution settings or results. Shared Team schedule control is outside
the approved first version.

Studio reads ten task definitions per page and bounds background refresh work.
Loading older pages or editing a task pauses automatic refresh; manual refresh
returns to the newest page. Occurrences are paginated separately, and a
conversation link appears only after native submission is confirmed.

## Reference and validation boundaries

[OpenDots](https://github.com/CopilotKit/OpenDots) supplies reference concepts:
durable schedules, leased claims, explicit interruption and an executor separated
from scheduling. This implementation does not adopt its runtime, credentials,
Intelligence dependency or chat adapter. Koed's native Codex and Claude adapters
remain the execution authority. User-approved anchored cadence and latest-only
recovery take precedence over reference behavior.

Focused tests cover schedule calculations, authorization, idempotency, claims,
recovery, native submission and Studio controls. Record their results in the
integration plan when the implementation checks finish. Live Codex/Claude runs,
offline restart on supported devices, hosted two-device use, packaging and
migration deployment remain separate acceptance work. Never apply branch
migrations to the configured Personal database for these tests; use disposable
databases.

Live acceptance must cover these cases separately:

1. Create a task with a verified Client, device and Project. Confirm it stays
   paused and starts no conversation until activation or an explicit Run now.
2. Run it once with Codex and once with Claude. Confirm each creates one private
   conversation, appears in Agent history, and retains normal tool approval and
   Memory behavior. Confirm the occurrence link opens that conversation.
3. Leave the selected device offline across several due slots. Reconnect it and
   confirm one latest occurrence runs, with no backlog replay or Client fallback.
4. Pause, edit, archive and retire while work is queued or running. Confirm future
   starts stop, accepted native work retains its ordinary controls, and restoring
   the Agent does not activate the schedule.
5. Interrupt submission and execution at separate stages. Confirm the same
   request is recovered when known, uncertain effects require review, and
   acknowledging review does not replay the interrupted prompt.
6. Repeat owner, outsider and revoked-device checks on a hosted two-device setup.
   Confirm Team availability exposes no task definition or private result; test
   explicit sharing through the existing destination workflow independently.

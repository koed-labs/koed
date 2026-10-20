# Scheduled Jobs storage and API (HQ-601)

A Scheduled Job belongs to one Personal owner, Agent, and Conversation. Its
Project link is optional. The first runner device comes from a verified local
Desktop deployment or an enrolled Personal Device credential. A session alone
cannot choose that first device. Settings can reassign the Job to another
enrolled device belonging to the same owner. The runner device is separate
from a process lease or an Agent execution ID.

The API accepts only the daily, weekdays, weekly, and monthly calendar forms
in [the approved design](./scheduled-jobs-design.md). It rejects unknown fields,
invalid 24-hour times, unsupported IANA zones, empty or duplicate weekly days,
and wrong weekday or month-day fields. The shared calendar helper resolves a
spring gap at its first valid minute, uses only the first repeated fall minute,
and clamps a month day to the last day of a shorter month.

`GET /v1/scheduled-jobs` and `GET /v1/scheduled-jobs/:id` read the owner's Jobs.
`POST /v1/scheduled-jobs` creates one, `PATCH /v1/scheduled-jobs/:id` edits it,
and the `pause` and `reassign` endpoints require its current version. `run-now`
queues a manual occurrence. `retry` queues another attempt on the _same_ run
row; `skip` records the owner's decision. The `runs` and `attempts` endpoints
read durable history. A Personal `scheduled_job_changed` event tells clients
to refresh a Job without sending its instruction over realtime.
Create and Run now each carry a client-generated `requestId` so a lost response
can be retried without creating a second Job or manual occurrence.

The `(job_id, scheduled_for)` key identifies one stable occurrence. A run row
summarizes its current state. Each start inserts a new attempt identity and
an append-only start event in one transaction _before_ any turn could launch.
Later status events keep their own timestamps and outcomes. Retry never
replaces an earlier attempt's execution ID, fence, outcome, or error. HQ-601
stores intents and history; HQ-602 will claim work in the owner's Local AI
Runtime and launch a new turn in the bound Conversation. No API route calls a
server-side LLM.

The Scheduled Job attempt's `executionId` is a unique attempt fence identity,
not a Managed Conversation Execution ID. A Conversation keeps its existing
Managed Execution across scheduled turns. HQ-602 must create a fresh private
prompt command for each attempt and insert the immutable
`scheduled_job_attempt_dispatch_bindings` row in the _same transaction_ as the
queued command, before either becomes visible to a runner. The row records
the exact attempt, existing Managed Execution, execution generation, and new
command. It never exposes another member's chat or creates a second Conversation.

Deleting a Conversation pauses its Job in the same transaction. Forgetting
that Conversation removes its Job and cascading run history. Deleting a Personal
Project pauses its Jobs before the deletion completes, and restore leaves them
paused. Shared Project Jobs require the enrolled Team principal, current Team
Project and member versions, and write access at creation, Run now, retry,
attempt start, and state change. An offline cached Project state cannot
authorize a run. A verified HQ-712 Personal copy-back or invalidation receipt
pauses linked-Project Jobs in the same transaction before the Personal link is
cleared. HQ-602 must recheck Project, Conversation, Team, device,
and attempt fences before every launch, lease renewal, approval resume,
Koed-mediated operation, and terminal write.

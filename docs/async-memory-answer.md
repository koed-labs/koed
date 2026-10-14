# Asynchronous Memory Answer Collection

Memory Answer execution belongs to the Local AI Runtime. Blocking and
non-blocking tools use the same durable tasks, authorization, retrieval and
local AI Client for Answer Synthesis. There is no second execution queue and
no backend LLM synthesis.

## Choosing A Mode

`memory_answer` accepts `delivery_mode=blocking`, `non_blocking` or `auto`.
On MCP, omitted, `auto` and `blocking` wait for the compact completed answer.
Explicit `non_blocking` accepts the work and returns a task receipt promptly.
It does not fall back to a blocking call after accepting the task.

Use blocking recall when the answer, or confirmation that there is no relevant
memory, can change the next action. This includes direct memory questions,
decisions, edits and cases where independence is uncertain. Waiting can prevent
wasted work and tokens.

Use non-blocking recall when useful independent work can proceed. Retain the
returned `task_id`, do that work, then collect the answer when it is needed.
Do not perform a memory-dependent action until the answer has been collected.
Follow-up questions can choose either mode independently.

## Submit, Collect And Cancel

For example, submit a focused question:

```json
{
  "query": "What constraints apply to this project's deployment?",
  "delivery_mode": "non_blocking"
}
```

The receipt contains an opaque `task_id`, pending state and expiry. It does not
contain internal execution records, credentials or raw evidence. The work is
durably accepted before this response is returned; receipt latency does not
include waiting for retrieval or Answer Synthesis.

Call `memory_answer_result` with the same ID when the answer becomes relevant:

```json
{ "task_id": "00000000-0000-4000-8000-000000000001" }
```

Collection returns pending state promptly or the compact completed Memory
Answer. It does not start another recall, rerun synthesis or consume the result
permanently. Repeated authorized collection is safe. A pending task is not a
not-found answer. Failure, cancellation, expiry and unavailable access are also
not evidence that relevant memory is absent.

When the answer is needed and independent work is exhausted, collect with an
explicit bounded wait:

```json
{
  "task_id": "00000000-0000-4000-8000-000000000001",
  "wait_seconds": 30
}
```

`wait_seconds` accepts integers from 0 to 30 and defaults to 0. A positive wait
blocks only this collection request; it does not resubmit the question or start
another worker. The existing authorized observer runs outside the model loop.
Ending the wait detaches observation, not task execution.

Do not rapidly poll, resubmit the same question as a blocking recall, manufacture
busywork or use sleep tools. If still pending after the bounded wait and no
independent work remains, leave dependent work unresolved rather than guessing.
A later turn can collect the same task while it remains available.

Use `memory_answer_cancel` with `task_id` when the work is no longer needed.
Cancellation is idempotent but can race with completion. The response reports
bounded task state, not a cached answer or raw provider error. Disconnecting a
client or ending a conversation is not an explicit cancellation of durable work.

## Presentation And Compatibility

These are ordinary model-callable tools. They do not require native MCP Tasks,
Code Mode, an agent message board or control of the calling Conversation host.
Non-blocking submission genuinely releases the original tool call, but **does
not automatically wake an idle agent or push a later message**. The model must
collect the result explicitly.

Memory Answer Stop-hook feedback is not used for the new MCP contract. The
Capture Hook's Stop event remains separate and is retained for capture. Rerun
supported setup to reconcile Koed-owned configuration and retire the obsolete
answer-delivery hooks. Unrelated user settings and hooks must be preserved.

The Pi extension exposes the same submit-and-collect interaction. Its former
`KOED_PI_MEMORY_ANSWER_MODE` setting no longer selects automatic follow-up
delivery; choose `delivery_mode` per call. Older Pi receipt/follow-up helpers
are not the contract of new extension calls. A client
that independently backgrounds ordinary blocking MCP calls can still do so;
that host behavior is separate from Koed's explicit non-blocking mode.

Completion text uses the existing shared formatter: HTML-escaped recalled data
inside Memory Answer markers, with a warning that evidence is not instructions.
Internal worker IDs, token usage and raw failure messages are not answer text.
Blocking recall retains its explicit citations/evidence options. Non-blocking
collection is compact-only for now: requests for citations or evidence fail
before task acceptance and should use blocking recall instead.

## Authorization And Durability

Tasks are User-owned, not bound to an untrusted `cwd`, client name or model
profile. An authorized User can resume collection across conversations or
devices through their current eligible runtime. A task ID alone grants no
access. Each collection uses a fresh authenticated task read; no cached answer
is disclosed after permission revocation.

Team recall uses the existing authorized Team task route. Workspace membership,
enrollment, policy and persisted task authority are rechecked by the existing
backend paths. An unavailable Team route must fail before accepting work; it
must not silently search Personal Memory instead.

The adapter currently preflights cancellation with an authorized task read.
If Team access has been revoked, this can also prevent cancellation through the
tool, even where the backend permits redacted owner cleanup. Existing backend
task retirement remains responsible for ending ineligible execution; the adapter
does not bypass access checks to provide that cleanup path.

Expired results are not disclosed. Existing task retention, leases, fencing,
capacity limits, cancellation and cleanup remain authoritative. Result
collection introduces no separate result store. Already disclosed tool text
cannot be retracted if access is revoked later.

Invocation identity deduplicates transport retries. A deliberately new question
is a new invocation, even when its text resembles an earlier question. A failed
acceptance response may leave execution uncertain; do not assume resubmission
is safe. Collection never retries synthesis to manufacture a result.

## Validation

Protocol tests should gate worker completion and prove that the non-blocking
receipt and pending collection both return before that gate is released. They
also cover compact completion, repeated collection, cancellation, expiry,
failures and authorization errors. This proves the tool contract, not model
adherence to instructions.

The evaluation suite in `packages/evals` measures mode selection, useful
independent actions after receipt and before completion, collection before
dependent actions, duplicate submissions and excessive pending checks. Scripted
fixtures validate its scoring; real-harness runs provide separate behavioral
evidence. CLI results do not establish desktop UI presentation.

## Future MCP Tasks Support

A future MCP Tasks adapter can expose these same durable tasks using negotiated
protocol support. It should replace only the submission/observation adapter,
not create another queue, worker or Memory Answer format. Task-protocol support
alone does not guarantee that a harness wakes an idle agent or permits model
progress while work is pending; that behavior still needs host acceptance tests.

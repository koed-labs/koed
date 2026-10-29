# Asynchronous Memory Answer Collection

Memory Answer execution belongs to the Local AI Runtime. Blocking and
non-blocking tools use the same durable tasks, authorization, retrieval and
local AI Client for Answer Synthesis. There is no second execution queue and
no backend LLM synthesis.

## Choosing A Mode

`memory_answer` accepts `delivery_mode=blocking`, `non_blocking` or `auto`.
On MCP, omitted, `auto` and `blocking` wait for the completed answer.
Explicit `non_blocking` accepts the work and returns a task receipt promptly.
It does not fall back to a blocking call after accepting the task.

Delivery mode and answer detail are independent. Both modes accept the same
`response_detail` and `include_evidence` options. Compact answers remain the
default; asking for citations or evidence does not require blocking delivery.

The tool instructions prefer non-blocking by default. Blocking is an option
only when no work can begin until relevant memory has been checked. This is
model-facing guidance, not a change to the omitted/`auto` execution default.

For non-blocking recall, retain the returned `task_id`, do independent work,
then collect the answer when it is needed.
Do not perform a memory-dependent action until the answer has been collected.
Follow-up questions can choose either mode independently.

### Chief of Staff direct recall

The Chief of Staff is itself an AI Client that writes its own reply, so its
managed MCP Server does not ask a second AI Client run to write a Memory
Answer. It submits the question as a blocking durable task marked
`direct_recall` across all of the owner's Personal Memory. The Local AI Runtime
runs the same scripted first-pass search a Memory Answer starts with and
returns the matching memories, numbered in citation order, as the recalled
text. The question, evidence and citations are recorded as for any Memory
Answer, so citation chips still work. Because no AI Client writes an answer,
the call completes in about the time of one search, whatever delivery mode was
requested. If direct recall fails, the MCP Server runs the full Memory Answer
instead. `direct_recall` is set only by the managed MCP adapter; it never
widens what can be recalled.

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

Collection returns pending state promptly or the completed Memory Answer with
the detail requested at submission. It does not start another recall, rerun
synthesis or consume the result permanently. Repeated authorized collection is
safe. A pending task is not a not-found answer. Failure, cancellation, expiry
and unavailable access are also
not evidence that relevant memory is absent.

When the answer is needed and independent work is exhausted, collect with an
explicit wait for the existing task:

```json
{
  "task_id": "00000000-0000-4000-8000-000000000001",
  "wait": true
}
```

`wait` defaults to `false`, which returns the current state promptly. `true`
blocks only this collection request until the task settles or existing expiry,
cancellation, observation or harness timeouts end the wait. There is no separate
30-second collection cap. The existing authorized observer runs outside the
model loop; it does not resubmit the question or start another worker.

If the harness times out or disconnects, the call ends rather than promising a
late automatic message. The durable task can continue; retain its ID and collect
again when needed. Expired, failed or cancelled tasks return their terminal
outcome or an appropriate error, not a fabricated answer. Ending observation
does not explicitly cancel task execution. The harness's own tool timeout must
allow enough time for the wait; changing it is an Operator/client configuration
decision, not a permission or execution-priority override.

Do not rapidly poll, resubmit the same question as a blocking recall, manufacture
busywork or use sleep tools. If collection is unavailable and no independent
work remains, leave dependent work unresolved rather than guessing. A later
turn can collect the same task while it remains available.

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
Both blocking recall and non-blocking submission accept `response_detail`:
`answer_only` (the default), `with_citations` (source metadata), or
`with_evidence` (evidence and citations). `include_evidence=true` requests full
evidence regardless of `response_detail`, matching the existing blocking
behavior. The execution layer stores the requested result detail; collection
uses the same formatter to return it after a reconnect or repeated read. It
does not require connection-local request state. Details remain recalled data,
not instructions, and do not expose internal execution or task records.

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
is a new invocation, even when its text resembles an earlier question. A
timeout, transport failure or server error during acceptance may leave
execution uncertain; do not assume resubmission is safe. A definitive client
rejection, such as a full queue, creates no task: the response says so and, when
available, includes `retryAfterMs` before a later retry. Collection never
retries synthesis to manufacture a result.

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

# Asynchronous Memory Answer delivery

Personal Memory Answer execution belongs to the Local AI Runtime. It accepts
durable work through the existing task API, retrieves authorized memory, asks
the assigned AI Client to synthesize the answer, and saves the completed Memory
Question. Presentation adapters observe that work and deliver it to the calling
Conversation.

## Shared lifecycle

`@koed/mcp-server/memory-answer-delivery` exports `MemoryAnswerDelivery` and its
execution-port types. A port supplies authorized `start`, `get`, and `cancel`
operations. The lifecycle validates task identity, invocation identity, version
and expiry. It polls outside the model loop, reads the terminal task again, and
checks the destination immediately before presentation.

Observation starts with a one-second polling interval and increases the interval
to five seconds while the task is unchanged. HTTP 429 responses delay another
read of the same task, using a validated retry delay or bounded backoff. The
original observation deadline, task expiry, cancellation signal and destination
checks still apply. Throttling during the final authorized read cannot authorize
delivery of the earlier result. Pi keeps its observer pending during throttling.

Detached execution is available only for eligible Personal Memory requests.
The runtime returns the stable `memory_answer_team_ineligible` code with HTTP
409 before accepting an ineligible Team Memory request. Codex's automatic mode
uses that code to select blocking recall with the original caller and input.
Other conflicts or runtime failures do not trigger another recall.

The Codex Stop adapter checks receipt ownership before acquiring its lock, then
checks ownership again under the lock before claiming the result. An unrelated
receipt's unavailable lock cannot suppress the current Conversation's receipt.
A matching receipt whose lock is unavailable remains protected from claiming.

Durable acceptance validates and applies the supported Memory Answer input
schema before eligibility and scheduling. Its
defaults bind Project search consistently to the calling context; a raw query
cannot become a task whose later worker assumes a different scope. Invalid
input fails with status 400 before task acceptance. Presentation adapters can
use the same schema rather than duplicate these defaults.

Answer Synthesis can cite evidence by its source identity or by a candidate
index. When an answer supplies a source identity, evidence selection must honor
that identity, including its chunk and any supplied node or visibility
constraints. An outdated index must not substitute a different source. Answers
that supply only an index retain index selection. Unresolvable or conflicting
references cannot produce unrelated supporting evidence; worker validation
handles the failure before a successful answer is saved or delivered.

Blocking recall uses this same lifecycle. Aborting observation detaches the
waiter. Explicit authorized cancellation remains a separate operation. Neither
an MCP adapter nor a presentation adapter owns a second execution queue or result
store. Backend LLM synthesis remains prohibited.

The portable module is distributed with the standalone Pi package and exported
from the MCP Server package. It has no Pi dependency. Future client adapters can
reuse it or bind the same execution port to a maintained MCP Tasks extension.
This lifecycle does not expose native MCP Tasks. Claude Code's host backgrounding
uses the ordinary blocking MCP result path described below. Codex defaults to
blocking recall. Its opt-in native CLI Stop adapter instead binds a protected
one-use request to the original turn and supplies its result at that turn's
stop boundary. See [Codex setup](codex-integration.md#optional-deferred-recall-in-the-native-cli).

An isolated native Codex CLI 0.159.3 test with gpt-5.6-luna returned a pending
receipt in 72 ms. The agent read and summarised a generated package file before
real recall completed, then automatically consumed the answer and original
source citation in the same turn. This qualifies the normal CLI path. Separate
isolated scheduler-failure and durable-cancellation CLI cases passed their
bounded checks; the cancellation case used a managed backend at 0.160.0.
The earlier server-write timeout case remains inconclusive under its delayed-read
criterion. A fresh CLI 0.160.1 client-port timeout case passes: an authorized
running snapshot drains unchanged after observation ends, one real task completes,
and no late answer reaches the original Conversation.
One pending-exit run failed: after User-reported CLI disconnection, the original
turn received a completed-result HookPrompt and produced a model answer before
SessionEnd retired the receipt. A separate controlled-timing fork test showed
the interrupted parent's result did not reach a child Conversation; it does
not establish natural-latency fork speed. A controlled `/new` test likewise
kept the completed result out of a distinct package-only Conversation after
parent interruption, with no later parent model answer. Active foreground
switching remains unverified. Separate isolated revocation and
expiry cases confirmed that a fresh task read prevents cached
answer delivery. Ordinary task GETs can return HTTP 200 with expired retention;
the shared delivery lifecycle rejects that snapshot before presentation.

Fresh CLI 0.160.1 exit checks distinguish intentional disconnection from explicit
interruption. After bare `/quit`, one original backend turn completed and its
answer was visible on reconnect to that exact completed history. A separate
Interrupt retired the original receipt under its exclusive lock before frontend
exit; backend completion produced no later native answer. Independent review
accepts these bounded cases. Automatic pending-result delivery after runtime
restart, exited-session replay and idle wake remain unsupported.

External native queue presentation remains unsupported. Loaded-thread metadata
does not establish the current interactive receiver. The Stop route avoids that
receiver choice by retaining the original active turn. A separate native VS
Code extension 26.5930.51102/backend 0.160.0 positive test demonstrated useful
package work before recall and automatic same-turn answer/citation delivery,
without added delay, polling or retry. Its scoped cleanup passed. A separate
controlled IDE pending window-close showed native backend exit and binding
absence before completion, with no late model answer or result context.
Genuine SessionEnd confirmed the empty binding state; first-removal attribution
was not directly captured. A separate IDE durable-cancellation case confirmed
one protected cancel, actual cancelled execution and a native no-answer notice
without another recall; its scoped cleanup passed. A separate IDE execution-failure
case also confirmed useful queued work before claim, real execution and a
genuine scheduler failure followed by one native no-answer notice. Its scoped
cleanup passed. An IDE observation-timeout case also confirmed an actual late
read drained unchanged, real task completion without cancellation and no late
answer, with scoped cleanup. This used client-port latency after a successful
HTTP read; the earlier CLI server-side timeout attempt remains inconclusive.
Controlled IDE fork isolation also passed: actual parent interruption and child
lineage preceded child package work and durable completion, with no result in
the child or later parent model answer. Scoped cleanup passed. A separate active foreground switch also passed: the new
Conversation finished package work before completion and received no original
answer; the continuing original owner alone received it. Scoped cleanup passed.
Real core credential provisioning/reuse and native missing-prehook blocking
fallback also passed, with configuration repair/check and scoped cleanup.
Simulated orphan-lock state removal after task completion passed without replay
or late answer; in-flight removal and crash recovery are not claimed. Independent
review accepts this bounded IDE active-Stop route. A separate Desktop positive
on app26.930.61225/bundled0.160.1 also passed natural useful work11.6seconds
before completion, one automatic owned answer/source and scoped cleanup. Bounded
independent review passed. Controlled active Desktop switching also passed: the
new non-fork owner received no original result, while the continuing original owner
alone received it. Close Window followed by private Dock Quit passed bounded exit
safety; window-close alone and first-removal attribution remain unverified. Other
Desktop interrupted-parent fork also passed controlled child work before completion,
no child result or later parent answer, cleanup and bounded independent review.
Subsequent-turn Desktop durable port cancellation also passed one protected
running-task cancel, no saved answer/Question, one native cancellation notice,
cleanup and independent review. Earlier fallback/wrong-project attempts remain
inconclusive; this does not add first-turn or native UI cancellation evidence.
Desktop genuine scheduler/executor failure also passed one real hard-timeout
attempt and native no-answer notice with cleanup and independent review. Worker
entry/returned boundary are retained separately; full inference is not claimed.
Corrected Desktop client-port observation timeout also passed unchanged late-read
drain under the exact six-second native watchdog, backend completion without
cancellation, no late answer and cleanup/independent review. The prior 305-second
fixture remains behavior-only. Desktop real core provisioning/reuse, supported
repair/config selection/removal and missing-prehook blocking fallback also pass
with cleanup and bounded independent review. The earlier full bootstrap remained
deferred; newer contributor bootstrap evidence appears below. Desktop post-completion simulated orphan-state cleanup also
passes unchanged task/Question and no replay/late answer with cleanup/independent
review. In-flight and crash/restart recovery remain outside the approved Codex
delivery scope. The Stop
route does not prove idle wake-up. The accepted upstream cancellation race can
record a late hook prompt in an interrupted turn. It does not permit a model
answer after confirmed interruption. Historical exit verdicts remain unchanged.

The User-driven managed contributor bootstrap passes first and repeat with one
credential and unchanged configuration, guidance and client registration.
Independent result review and scoped cleanup pass. This test uses existing
dependencies with an approved private verification-disable setting and pinned
pnpm adapter. It does not qualify default dependency verification, fresh
installation or the managed path's skipped capture and doctor checks. Normal
configuration retains its existing defaults.

## Claude Code host backgrounding

Independently started interactive Claude Code can background an ordinary pending
MCP call and provide its result through a native notification. Koed continues
the same durable task and blocking lifecycle while Claude releases the main
Conversation. No model polling or Koed-managed Conversation is required for
this host behavior.

The explicit `--background-recall` setup option configures a 500 ms host threshold
when existing settings allow it. The threshold affects all ordinary MCP calls,
including other MCP Servers. It is not an environment setting on Koed's MCP
child. See [Claude Code integration](claude-code-integration.md) for setup,
preservation and removal behavior.

This is a host-specific presentation mechanism, not native MCP Tasks. Automatic
backgrounding in subagents, IDE calls and noninteractive execution must be
assessed separately. Exiting the host can stop pending calls; Pi's receipt-based
recovery guarantees do not apply to Claude's native background notifications.
Stopping a host task or its pending MCP call is distinct from explicitly
cancelling the durable Koed task. Aborting the blocking observer detaches that
wait; the Local AI Runtime can continue execution.
The earlier interactive host experiment establishes native continuation. A
User-run test with Claude Code 2.1.267 on 2026-10-01 also demonstrated real
Personal Memory recall, independent work before completion, and automatic
consumption of the answer with its original evidence. The stored transcript
confirms that completion came from a native task notification without model
polling or another User prompt. That test used explicit global search; an earlier
query-only call used the Project default and returned no evidence.

Isolated tests with Claude Code 2.1.267 also passed for idle delivery, completion
during a foreground tool, timeout, selected host stop, pending exit, revocation
and expiry. The tests used real Koed retrieval and AI Client synthesis.
Revocation and expiry tests changed generated records after completion, before
the final access read. Both suppressed the answer and produced an automatic
failure in the original Conversation. These controlled tests do not measure
natural expiry timing. Repeated calls in one Conversation and delivery after
reopening remain untested.

A later manual test observed native completion enqueue during an outstanding
independent lint call, followed by automatic consumption when that call yielded
to the background. This establishes delivery at a tool boundary, not interruption
of the running tool or model generation. A long foreground tool can keep the
completed answer queued until that boundary.

## Pi delivery

With a persistent Pi Conversation and the required session-history and message
APIs, `memory_answer` returns an attributed receipt promptly. The agent can do
independent work while the extension observes the task. The extension delivers
completion as a Pi follow-up message and triggers a turn automatically. A
memory-dependent decision must wait for that completion.

The receipt records the task, query, invocation, Conversation, session file,
delivery generation and `KOED_HOME`. Delivery requires a matching receipt on
the current branch and a fresh authorized task read. Each HTTP request rereads
the protected Local AI Runtime registration; credentials and results are not
cached for delivery.

`KOED_PI_MEMORY_ANSWER_MODE=blocking` retains blocking recall. Ephemeral sessions,
clients without the required Pi APIs, and Team Workspace calls also use the
blocking route. The runtime remains authoritative about task eligibility.
At most 128 pending receipts are observed by one adapter.

## Recovery and limits

Reopening the same persistent Conversation resumes observation of its matching,
unexpired pending receipts. Runtime outages can be retried through the current
registration. A successful switch, fork or move of the session tree detaches
and invalidates current pending delivery. A cancelled transition leaves recall
active in the unchanged Conversation. Shutdown detaches observation and leaves
durable execution running; reopening the same Conversation can recover it.
Already enqueued completions are suppressed on recovery.

Pi does not provide an atomic transaction covering receipt persistence and
message enqueue. These limits apply:

- Before its first assistant message, Pi can buffer session entries in memory.
  A crash before persistence can lose the receipt.
- A crash after runtime acceptance and before appending the receipt can leave
  a durable task without recoverable presentation history.
- The extension records an enqueue attempt before calling Pi's message API.
  A crash or queue failure between those steps can lose delivery. That marker
  prevents duplicate enqueue attempts after reopening.

Recovery therefore provides at-most-once enqueue attempts, rather than exactly
once delivery. Expiry or a permanent authorization failure can prevent
presentation and require a fresh authorized recall. The completed Memory
Question remains available through Koed's normal history. Retrying recall
creates a new invocation.

## Authorization and diagnostics

Task event streams resolve ownership before writing success headers. Scheduler
notifications only wake an observer; each event and keepalive uses another
authorized read. Expiry ends observation, resumed versions do not regress, and
revoked authority never supplies a cached result. HTTP failures preserve their
status through the Local AI Runtime and client.

Runtime error responses use static messages. MCP diagnostics omit raw exception
messages, stacks, causes and payloads and bound retained metadata. This does not
replace task-result authorization or Capture Policy.

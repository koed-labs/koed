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
to five seconds while the task is unchanged. A port can also supply an optional
`subscribe` wakeup that ends the current wait early. The Local AI Runtime's
blocking route uses it with in-process scheduler events, so blocking recall
does not wait for the next poll. A wakeup never supplies task state; the next
state and the final authorized result always come from a fresh `get`. The Pi
and Codex adapters use HTTP ports without wakeups. HTTP 429 responses delay
another read of the same task, using a validated retry delay or bounded backoff. The
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
blocking recall. Its opt-in native Stop adapter instead binds a protected
one-use request to the original turn and supplies its result at that turn's
stop boundary. See [Codex setup](codex-integration.md#optional-deferred-recall-in-the-native-cli).

The Stop adapter keeps the original turn active until the result arrives.
Delivery after a backend loss, Local AI Runtime restart or session exit, and
idle wake-up, are unsupported. External native queue presentation is also
unsupported, because loaded-thread metadata does not identify the current
interactive receiver. See
[Codex deferred recall behavior and limits](codex-integration.md#deferred-recall-behavior-and-limits).

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

Claude queues a completed result while a foreground tool runs and delivers
it when that tool returns; the notification does not interrupt the tool, so a
long foreground call delays use of the answer. Revocation and expiry suppress
the answer and produce an automatic failure in the original Conversation.
Repeated calls in one Conversation and delivery after reopening are untested.

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
revoked authority never supplies a cached result. Task routes preserve the
Memory API's denial, not-found and expiry statuses through the Local AI Runtime
and client, so delivery adapters can stop observing.

Runtime error responses use static messages. On tool and Desktop Ask routes, a
Memory API failure is reported as an upstream failure: HTTP 503 when the API is
unreachable, 429 when it is rate limited, and 502 otherwise, with separate text
for a rejected API Token. A failed blocking recall reports static text for its
recorded reason, such as a time limit or cancellation; the raw failure message
is never returned.

MCP diagnostics omit raw exception messages, stacks, causes and payloads and
bound retained metadata. They keep error class names, numeric status fields and
allowlisted system codes such as `ECONNREFUSED`, including one level of cause.
This does not replace task-result authorization or Capture Policy.

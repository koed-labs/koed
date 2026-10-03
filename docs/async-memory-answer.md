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
source citation in the same turn. This qualifies the normal CLI path. Failure,
explicit task cancellation, observer timeout, pending exit and fork ownership
remain unverified. Separate isolated
revocation and expiry cases confirmed that a fresh task read prevents cached
answer delivery. Ordinary task GETs can return HTTP 200 with expired retention;
the shared delivery lifecycle rejects that snapshot before presentation.

External native queue presentation remains unsupported. Loaded-thread metadata
does not establish the current interactive receiver. The Stop route avoids that
receiver choice by retaining the original active turn. It does not prove idle
wake-up, IDE, or Desktop delivery. The accepted upstream cancellation race can
record a late hook prompt in an interrupted turn. Interrupt cleanup is advisory.

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

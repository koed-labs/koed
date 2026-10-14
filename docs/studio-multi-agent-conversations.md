> Current implementation and validation: [UI integration plan](studio-ui-integration-plan.md). The validation counts below describe the original multi-Agent checkpoint; current simplification evidence is in that plan.

# Multiple Agents in one Personal conversation

## Product contract

A Personal conversation can include several Agents using the same AI Client,
different AI Clients, the same model, or different models. An Agent's presentation identity
is separate from its execution engine. Changing respondents
does not create another conversation in navigation.

A conversation can retain up to 16 named Agents.

Explicit `@Agent` mentions select the recipients of a submitted message. Multiple
recipients run in mention order, once each. A message without mentions uses the
current respondent; selecting an Agent is optional for an ordinary chat. Agent
replies and quoted mentions never cause automatic delegation.

Each Agent retains its own model and reasoning settings. Replies identify the
Agent that produced them. Progress, approvals, file changes, failures and
cancellation belong to that Agent's execution, while the human request appears
only once in the conversation.

## Conversation and execution identities

The conversation provides the stable navigation identity, title, Project,
participant list and public message order. Provider executions are attached to
it, with a separate native session for each Agent even when two Agents use the
same AI Client. An existing managed execution can be adopted without rewriting
its native transcript or changing its conversation link.

Executions preserve their own provider, instance, generation, source-journal
identity, lease, settings and command recovery boundaries. A shared visible
conversation is not a merged native transcript. Context copied between Agents
is explicitly supplied context, not another provider's original source records.
Capture and Projection continue to use each provider's verified source.

## Sequential work and recovery

A durable submission contains one human message and an ordered list of Agent
deliveries. Dispatch persists the command identity before advancing and remains
idempotent across retries and runner restarts. Only one delivery may operate on
the conversation's shared verified checkout at a time. Later recipients receive
the public results and file state available after earlier deliveries finish.

An uncertain prompt outcome is not proof of completion. It must stop further
workspace execution until reconciled; reconnect never silently resends the
prompt. A confirmed failure is shown with its Agent attribution and does not
erase replies already received. Continuing past an eligible confirmed failure
requires an explicit recorded User action; an uncertain delivery cannot be
skipped this way. Stop cancels the pending batch before stopping its current
provider turn, so cancellation cannot accidentally launch the next Agent.
Permissions remain specific to the execution adapter and do not expand because
an Agent was mentioned.

## Bounded context

Cross-Agent context contains authorized public human messages and Agent replies.
Public replies from an ordinary unnamed AI Client are also eligible when an
existing conversation is adopted.
Private reasoning, raw tool payloads and unshared memory are not transferred as
conversation history. Presentation identity is supplied for the recipient; recall
uses the common supported memory_answer path.

The transfer budget is at most 24 public exchanges and 24 KiB of UTF-8
context. The most recent exchanges take priority when the budget is exceeded.
A fresh native session receives an explicitly bounded bootstrap, including its
own prior public replies, rather than assuming it still has the previous
session history.

Each participant tracks the conversation sequence processed by its last
confirmed delivery. Later turns transfer new context within a fixed budget,
rather than resending the entire conversation. This cursor is a processing
watermark, not a read receipt: omitted or clipped context is explicitly labelled
`not_provided`, with omission counts and sequence ranges. A deliberately omitted
older window does not cause already-transferred recent messages to be sent
repeatedly. Failed, uncertain and pending deliveries do not advance the cursor.
No backend LLM synthesis is introduced to compress history.

## Other chat surfaces

The shared composer and presentation retain the same Agent interaction contract.
PR chats and shared Team channels also require their own authorized execution
adapters. Personal participation does not grant Team visibility, transfer
Personal Memory, or relax a PR's checkout and publication restrictions.

## Acceptance

- Two distinct Agents using one AI Client retain separate native sessions and
  appear in one conversation.
- Agents using different AI Clients can respond to the same human message in
  order, and returning to an earlier Agent preserves that Agent's session.
- Later Agents see earlier public replies and use the same verified files.
- Refresh, reopen and restart retain participants, settings, message order and
  queued deliveries without duplicated human messages or provider submissions.
- Deleted, quoted, unknown and retired mentions cannot accidentally invoke an
  Agent; same-name identities require a resolved stable ID.
- Context limits and incremental cursors are tested with long and non-ASCII
  messages, gaps and failed or uncertain deliveries.
- Cross-owner reads and writes, unavailable providers and stale identity
  versions are rejected without substituting a different respondent.
- Existing generic and single-Agent chats continue to work and keep one sidebar
  entry, including inside a Project.

## Implementation and validation

Implemented for local and hosted Personal conversations. The runner uses the
existing Codex and Claude Code execution adapters. Personal roots have one
sidebar/Project entry, ordered attributed replies, persisted participant
settings, and per-delivery retained activity and diffs. The shared composer
resolves explicit mentions before sending; removing a draft mention does not
leave it as a hidden recipient.

Automated validation covers 16 isolated PostgreSQL scenarios, including
same-provider and cross-provider sequencing, native command preparation and
retry identity, source adoption, bounded recent history, unchanged-session
cursors, model-change bootstrap, identity rename continuity, cancellation, explicit recovery,
and reconciliation after a lost settlement. The 15 migration acceptance
scenarios pass through migration 0078. API conversation/runner tests (116),
Worker tests (459, three skipped), focused Studio tests (30), gateway/recovery
tests (38), and context/contract tests (19) pass. Typechecks and the production
Studio build pass.

The broad API suite has 16 existing failures; the same failures were reproduced
from an unchanged baseline archive. Database unit tests without DATABASE_URL
pass 156 tests and skip integration cases; the journal-projection suite requires
a configured disposable database. These are not claimed as clean full-suite
runs. The new PostgreSQL smoke uses disposable databases and simulated native
outputs; live multi-provider SDK responses still require manual acceptance.

The updated desktop app was reopened successfully. A draft with two existing
Agents showed their execution order and distinct reasoning defaults; removing
the mentions cleared the recipient list. The original Project chat was reopened
with its prior messages intact. A subsequent live retry of the user’s existing
`@Alice  hi Alice!` draft succeeded through Codex with gpt-5.6-luna and low
reasoning, retained the Project history, and displayed Alice’s attributed reply.
The local launch-options parser now preserves the single authenticated runner’s
device binding while keeping ambiguous runners unresolved. Conversation
navigation waits for send admission and saved-draft cleanup; 20 focused parser
and submission tests cover these regressions. Live cross-provider SDK responses
still require manual acceptance.

Team channels and PR execution adapters remain outside this Personal v1.

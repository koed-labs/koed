# Native Agent execution from Team channels

Ticket 13 replaces the retired Agent Job handoff with ordinary native commands.
The human messaging backend, request consent flow and private Agent conversation remain the shared foundation.
The native replacement is implemented and has passed the focused automated checks below. Live provider and deployed Team acceptance remain open.

## Request and execution boundaries

An explicit Team Agent selection creates a channel request using the existing stable owner and Agent identities.
A colleague proposal does not authorize that owner's computer. The owner reviews the request privately and accepts or declines it.
An owner can refine the bounded, visible channel excerpt before acceptance. Private refinement does not accept the channel request.

Acceptance queues the saved private goal in the already-bound private native conversation.
The request update, command creation and native binding use one database transaction.
A retry of the same accepted decision returns the same binding rather than dispatching again.
Requester withdrawal, offer withdrawal and acceptance retain their existing current-access and version checks.

The private review supplies the verified Agent, local Project and selected computer/provider settings.
A Team Project ID is not a local path or permission to use another computer.
The native command preserves its conversation generation, runner identity and normal execution permissions.
No new Job, assignment classifier, soul instruction or model phase-reporting protocol is introduced.
Recall uses the supported memory_answer flow and existing scope authorization.

The channel request receives an execution status rather than private conversation text.
Accepted and Running are separate facts. A queued command or unavailable runner must not appear as running.
An uncertain or stale execution cannot appear successfully completed.
Existing Job-backed requests remain readable. Native commands are not presented as fabricated Job IDs.

## Storage and dispatch

Migration 0079 adds owner-scoped native execution/command links while retaining legacy Job links.
A database constraint permits one valid accepted linkage shape. It does not accept an unbound Accepted request.
Foreign keys bind the command, execution and owner together. A unique command link prevents reuse across requests.
A status function reads the accepted command and its own pending runtime items. Later private commands do not redefine that request's result.
Owner departure freezes the permitted channel status without exposing continued private activity.

An indexed private-review binding lets API and worker dispatch distinguish request-bound reviews from ordinary Personal chats.
Unanswered requests use read-only planning controls. Withdrawn, declined or unavailable request bindings cannot become unrestricted Personal commands.
The dispatch check consults persisted binding authority before relying on Agent context supplied in a command.
Accepted work uses the owner's verified execution settings through the existing provider adapter.

Older encrypted review bindings need a bounded lookup migration. Each lookup processes at most 100 unchecked owner records.
If more unchecked records remain, the lookup commits that bounded page and returns a retryable unavailable result rather than assuming a Personal chat.
New reviews save the indexed binding atomically. Routine lookups use that index after the older rows are processed.
The API performs this check before enqueue so an incomplete lookup can be retried without dispatching provider work.
For an already queued prompt, the worker requeues the same command under its lease only for the specific backfill-pending error, before provider dispatch and without a pending checkpoint. Other failures retain the existing uncertain-outcome protections.

## Questions, answers and result sharing

Only the owner can control the private execution or prepare a question for the originating channel.
An explicit post shares the reviewed question through existing encrypted channel messaging and its original message thread.
A teammate's reply remains a human message until the owner explicitly forwards that selected answer into the private chat.
No mention, reaction, reply or request grants a colleague execution control.

After the accepted work finishes, the owner can request a private summary draft.
The summary source is the accepted command's retained output, not a later private discussion or another request.
The draft source is bounded to 6,000 characters and retains a truncation marker.
The owner reviews and edits the draft before a separate explicit post to the originating channel.
Neither successful command completion nor draft generation publishes private replies or Memory evidence automatically.

Legacy Job summaries use their original owner-authorized source. Native summaries use the exact accepted command binding.
Summary generation remains a normal private Agent turn. It does not add backend LLM synthesis.

## Authorization and recovery requirements

Acceptance must recheck current owner/requester membership, channel and Team Project access, Agent availability and the bound execution.
A stale offer or private review cannot authorize a different Agent, Project, conversation or runner.
A request accepted before offer withdrawal retains the existing execution rules. Disabling future requests is not cancellation.
A former Team member cannot use retained IDs to recover private content or continue Team reads.

The native command keeps existing execution lease, generation, cancellation and uncertain-outcome protections.
Reload and reconnect recover the durable request and conversation. They must not replay the acceptance prompt.
Ordinary Personal chats continue through their existing native path.

## Scope

Ticket 13 restores the existing channel request workflow for supported native AI Clients.
It does not add a multi-owner execution coordinator. Ticket 27 extends the same
request lifecycle to private/group Collaboration chats under the User-approved
participant-only contract. Eligible Agent owners must be current participants;
review and execution stay owner-private, and explicit question/result sharing
targets the stored originating thread. The required shared Project context does
not widen that thread's audience. See the
[Collaboration chat assessment](studio-collaboration-chat-assessment.md).
Public Square and For you native activity projection remain Tickets 12 and 20.
This request's broad status and owner request inbox remain Ticket 13 responsibilities.

## Validation record

Automated validation on 2026-10-14:

- Real disposable PostgreSQL Team request suite: 5 tests pass, including native atomic acceptance, exact retry, public/private boundaries, owner departure, explicit result posting, duplicate binding rejection and bounded legacy backfill.
- Worker managed-conversation suite: 114 tests pass, including persisted owner-review authority, planning/work classification and narrowly fenced backfill requeue.
- API collaboration, managed-conversation and summary-source suites: 114 tests pass. The 22 summary tests cover exact accepted-command sourcing, owner binding, terminal states and bounded content.
- Studio Team request/progress suite: 7 tests pass; Team request/mention/sharing helpers: 19 tests pass.
- Existing hosted Team browser suite: 8 scenarios pass, covering human messaging, shared composer, reload, retry and access revocation with synthetic service responses.
- Migration acceptance matrix: all 15 scenarios pass through migration 0079. Personal multi-Agent regression: all 16 disposable database scenarios pass.
- Studio production build and API, worker, DB and Studio typechecks pass. Shared request contract tests, migration metadata checks and release consistency checks pass.

A broader API test run also reported 16 failures outside these focused flows; a clean-revision baseline was not established. This checkpoint is not a passing whole-repository test gate. Changed-file backend lint also reports six findings in unchanged portions of the worker service; this is not a passing whole-repository lint gate.

Live acceptance still required:

- Atomic acceptance, exact retry, request withdrawal races and no new Job writes.
- Owner/requester/outsider isolation, current offers, Project/device authority and access loss.
- Native queued, active, waiting, terminal and uncertain states, plus legacy request reads.
- Same private conversation after acceptance, reconnect and follow-up without duplicate sends.
- Exact-command summary sourcing, bounded text and explicit channel publication.
- Native and hosted UI request status, owner controls and ordinary human messaging regression.

Use disposable branch databases. Do not apply branch migrations to the User's current Personal database.
A focused or synthetic test is not evidence that live Codex/Claude, two-computer or deployed Team acceptance passed.

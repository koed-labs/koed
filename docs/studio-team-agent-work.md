# Studio Team Agent work

## Ticket 13 implementation contract

This document records the approved behavior. Validation results are tracked separately in the integration review ledger.

## Chat and assigned work

A User discusses and assigns work in their private Agent Conversation. Selecting an Agent or asking about an approach does not create an assigned Job or publish Team activity. Clear instructions to execute work create a Job; ambiguous instructions are clarified in that Conversation. Assignment recognition uses a bounded structured signal in the connected AI Client’s existing turn. Koed does not make a separate classification or synthesis model call.

The Job-start marker identifies the Agent, Project and concise goal. Further instructions while the Job is active belong to that same Job. After completion, questions about its result remain discussion; additional assigned work creates a new Job in the same Conversation. A successful AI provider turn does not by itself complete the Job. A bounded native outcome signal distinguishes completed work from a question awaiting the owner. Without that signal, an assigned Job waits for the owner; failures and interruption retain their actual outcome. Completed Job history remains intact. Model and effort are runtime choices separate from the goal.

## Team entry points

An owner’s channel mention can open a private Agent Conversation with the selected Agent and Project. The transferred channel excerpt is bounded, visible and editable. Treat that excerpt as quoted discussion, not execution authority. Opening a planning Conversation does not publish a Job.

Owners explicitly make an Agent available for requests in each Team. Other members see only its name, owner and a short owner-approved description. Instructions and private history remain owner-scoped. Same-name Agents are distinguished by owner; IDs, rather than display names, identify the selected Agent.

A colleague’s proposal is a durable request linked to its Team Chat Message. The owner sees it in Team → For you and may review/refine it privately before accepting. It remains Awaiting owner during refinement. Acceptance assigns the agreed work. Accepted does not mean Running when the runner is offline or execution is Pending. Mentioning an Agent never grants another User control of its runner.

## Request authority and lifecycle

The owner alone accepts or declines; the requester may withdraw an unanswered request. Resolve concurrent acceptance and withdrawal in one authoritative transaction and use durable command identities to prevent duplicate execution. Acceptance rechecks Team membership, Agent availability, Project sharing and owner execution authority.

Disabling availability closes unanswered requests as No longer available and prevents new proposals. Loss of requester/owner Team membership or Project sharing also closes unanswered requests. Original channel history remains available only under current access rules. Already accepted Jobs retain the existing execution and Public Square publication rules; availability withdrawal does not stop them.

Public request data contains only permitted attribution, request lifecycle and actual linked Job state. Private refinements, Conversation history, Memory evidence, local paths and runtime credentials are excluded. Team A’s request/result is not exposed to Team B merely because both share the same Project.

## Team input and results

The owner may review and explicitly share a selected Agent question into the originating channel, then explicitly choose an answer to forward into the same private Conversation/Job. Ordinary channel replies do not automatically steer the Agent.

Request status reflects the Job’s actual outcome automatically. Result content requires explicit publication. Share summary asks the connected Agent for a concise draft, which the owner reviews and edits before posting to the originating channel. Generating a draft is not publication or a new assigned Job. No transcript, output or Memory evidence is automatically published.

## Transport and deferred work

Reuse encrypted Team messaging, durable collaboration invalidation/replay and owner-scoped managed execution. Native Team operations pass through the enrolled local edge; browser requests use the authenticated hosted authority. Reads and writes apply current permissions, including after reconnect. A Team-chat-only credential does not acquire managed execution authority.

Ticket 13 includes minimal availability opt-in and its incoming-request producer in For you. Broader availability management and catch-up are Ticket 20. Channel threads are Ticket 14. Popup/system notifications and PR assignment UI remain later work.

## Persistence and provider integration

Migration `0060_team_agent_requests` adds Team-scoped Agent availability, durable proposals, encrypted owner refinement and execution/Job links. Migration `0061_personal_agent_attempt_command_binding` preserves the command identity for Job attempts. A Job can contain several provider attempts. Each command retains one attempt identity, and each attempt retains its own encrypted output. Retrying a command reuses that attempt rather than adding another Job or overwriting an earlier reply. Existing encrypted Conversation and Team-message storage is reused. Public request records do not contain the private brief or transcript.

Codex, Claude and Pi use bounded intent and outcome tools in their existing provider turns. Koed validates the active command, execution generation, provider turn and runner lease before changing Job state. Provider tools cannot accept a colleague’s proposal on behalf of the owner. Owner acceptance is a separate authoritative action.

The intent/outcome instruction is 1,011 UTF-8 bytes (159 whitespace-delimited words). Its actual provider token count has not been measured. There is no extra per-message classification request.

## Ticket 13 validation — 2026-09-30

A disposable signed-in Desktop owner and browser colleague completed a real Codex request: private planning, explicit acceptance, waiting Job, reviewed channel question, selected reply forwarding into the same Job, actual completion, private Agent summary drafting and owner-reviewed publication. The original Team alone received the result; the colleague could not read the private Conversation. Summary drafting added no Job. Own-Agent mention handoffs passed in Desktop and browser with bounded editable quoted context and no automatic execution. Desktop restart retained one Job marker, eight message identities and the original completed command without replay.

Studio tests passed 273/273; final source-only personal-Agent contract, repository and worker tests passed 104/104. The fresh PostgreSQL regression covers distinct same-Job attempt outputs, command replay, output replay and rejection of cross-attempt event reuse. Request permission/lifecycle PostgreSQL tests, broker/gateway checks, provider adapter tests, typechecks and assembled builds passed. Independent request, command and output authority reviews found no remaining concrete issue.

The live changed flow used Codex. Claude/Pi signaling was checked with focused adapter tests; unchanged provider and physical two-device evidence was reused from earlier tickets. Actual added provider token usage remains unmeasured. Broader notifications/availability management, threads and PR assignment remain in their later tickets. The release entry is deferred to combined epic review.

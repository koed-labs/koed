# Ticket 27: Collaboration chat assessment

Assessed on 2026-10-15 against `5145ff64bef7b981f6def537bda10bba6a40010e`, using three Luna Extra High reviews. Koed recall reached its resource limit and did not return a reliable answer. The findings below use the recorded decisions and current source; they do not assume missing prior approval.

## Accepted boundaries

Human messaging and Agent execution are different capabilities. Ticket 07 provides Team channels and shared-Project channels with current membership checks. Ticket 08 provides participant-only private and group human chats, including history and realtime delivery. Neither feature grants another participant access to an Agent owner's private execution or Personal Memory.

Ticket 13 provides the existing channel Agent workflow. A colleague proposes work, the Agent owner reviews it privately, and acceptance starts the saved goal in a bound native conversation. Private refinement alone does not accept the request. Questions, selected answers and reviewed result summaries cross the boundary only through explicit owner actions. Completion does not publish the private conversation or Memory evidence. See [native channel execution](studio-team-agent-native-execution.md).

Memory uses the supported `memory_answer` flow with existing authorization. One common tool does not make every audience equivalent: Personal recall does not grant permission to publish its evidence or response to a Team. Team recall requires the selected Team's current Shared Memory grants. API Tokens do not authorize Team reads. See [Team workspace and Project mapping](team-workspace-project-mapping.md).

## Baseline surface map

| Surface                         | Baseline wiring                                                                                                                                                                                                                                                                                               | Remaining work                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Native and hosted Team channels | `TeamChannelWorkspace` and `HostedTeamChannels` use `ChatComposer`, durable human messages and native Team Agent requests. A colleague Agent creates a request. Selecting an owned Agent first posts the typed text to the Team channel, then opens a private planning draft with a bounded editable excerpt. | Preserve the existing distinction between proposing, planning, accepting, executing and sharing. Complete live acceptance under 13. |
| Shared-Project channels         | The same controllers bind the request to the channel's Team Project. An ordinary channel instead requires selection of a shared Project.                                                                                                                                                                      | Preserve Team/Project authorization separately from the owner's local folder and runner choice.                                     |
| Private and group chats         | The same controllers send durable human messages with scoped recovery. They intentionally omit Agent options and execution controls.                                                                                                                                                                          | The User approved the participant-only extension below; its native and hosted adapters retain this audience boundary.               |
| Personal chats                  | Home handoff and local/hosted conversation controllers use shared recipient validation and Personal submission. Sequential same/cross-provider support is implemented.                                                                                                                                        | Retain provider, restart and hosted/device acceptance separately; this is not evidence that Team invocation works.                  |
| Browser previews                | `CollabWorkspace`, `PersonalPreviewWorkspace` and `PRChatPanel` identify local or synthetic behavior.                                                                                                                                                                                                         | Do not count sample messages as backend support. Real PR execution remains under 16.                                                |

The reusable boundary is composer presentation plus destination-specific authority adapters. Human Team sends remain `collaboration.send_message` on Desktop and `client.sendMessage` when hosted. Agent request creation must retain Team, Project, channel and optional root identity. Personal submission remains private. A generic send function that drops these distinctions would remove required checks rather than standardize them.

## Channel status gap and correction

The Team request panel reloads its requests after a `team_agent_request_invalidated` event. Its displayed native execution status is calculated from the bound managed command and execution. The original request invalidation trigger covers request-row changes, but native command progress does not itself change that request row. A fresh read can therefore show a completed execution while an already-open panel retains an earlier status.

This belongs to the existing channel contract and is corrected independently of the private/group audience extension. The backend fix must emit only for the linked request, retain current read authorization and frozen owner-departure behavior, and carry no private execution content. The current UI uses a Team-wide refresh revision on receiving a request invalidation; an exact request event therefore still reloads mounted request panels for that Team. Database/realtime regression coverage is required; the initial API and browser baseline alone does not exercise this transition.

## Approved extension — 2026-10-15

Ticket 13 explicitly leaves private/group AI audiences to Ticket 27. The historical Ticket 08 approval covers human participants, not Agent invocation. The [integration plan](studio-ui-integration-plan.md) keeps these destinations open until the approved adapters and enforcement are implemented and verified.

The User approved reusing the channel request workflow for private/group chats, restricted to Agents whose owners are current chat participants. The owner reviews and starts work privately, then explicitly shares a reviewed result to the originating chat. Personal Memory and private execution stay private. The approved wiring and focused permission/recovery checks are implemented; live acceptance remains required.

Any implementation must define the exact origin conversation and reply thread, selected Agent and owner, current participant authority, permitted context excerpt, result audience, Memory authorization and recovery behavior. A private/group chat is not automatically an owner-private AI conversation. Shared-Project channels retain their existing Team and Project checks rather than treating a Team Project ID as a local folder or execution permission.

The approved implementation keeps the existing request payload: `channelId` identifies the originating Collaboration thread, including a private/group thread, and `teamProjectId` remains required. A selected shared Project supplies existing work-context authorization; it does not expand the private chat's audience. No new messaging service, Agent Job engine or parallel Memory search is needed.

Acceptance must cover current owner/requester participation at creation, private review, acceptance and explicit publication; exact-origin reply and outcome binding; stale or foreign Agent IDs; owner-only execution controls; participant loss and reconnect; and retained human messaging. Plain text, human mentions, replies and reactions must not start Agent work.

Private/group participant sets remain immutable under the existing messaging
contract. Changing the participant set opens a separate chat; this ticket does
not add room-member removal. Current participation also requires enabled Team
Membership and an available account. Revocation tests use those supported
membership boundaries, and existing owner-departure status freezing is reused.

Existing owner-consented Public Square status remains a separate contract.
An active Project connection may publish the Agent, owner, shared Project and
coarse work status. It must not expose the private room or request identity,
goal, prompt, private execution locator or raw output to teammates. A shared
brief requires a separate owner publication. The new room workflow does not
revoke that prior status consent or turn it into consent to share chat content.

## Assessment validation

Current baseline checks passed: 41 Studio human-message, mention, request, sharing and shared-presentation helper tests; seven Team request/progress component tests; and 95 API Collaboration route, schema and realtime tests. All ten hosted Team browser scenarios passed, covering drafts, retry, human mentions, composer controls, Team activity and access loss. The existing five-test Team request repository suite also passed against a fresh disposable PostgreSQL database. These are automated and synthetic checks, not live provider, deployed database or multi-account acceptance.

No live database was migrated, no provider execution was started, and no application configuration was changed. Ticket 27 remains open for live provider, multi-account and deployment acceptance. The supported destination contracts, backend enforcement, shared UI adapters and focused permission/recovery coverage are implemented as recorded below; shared mention presentation alone was not treated as completion.

The User approved omitting a separate changeset for this assessment and including the channel status correction in the existing minor changeset.

## Implementation and validation

The implementation reuses the shared composer, Team Agent request records,
owner-private native conversations and supported Memory path. The request
schema remains compatible. Participant checks apply to private-room request
creation, owner review, native acceptance, explicit outcome publication,
request reads and realtime materialization. The owner-only Home and For you
projections recognize the same origins without exposing them to other Users.

Migration 0084 emits content-free invalidations for the exact accepted request
when bound command, execution or approval status changes. It retains request
consent versions, suppresses unrelated private activity and stops after the
owner's status is frozen. Runtime-item batches produce one status transition
per request; ordinary streamed text and healthy lease renewals do not generate refresh
traffic. Clock passage alone cannot emit a database event; reconciliation or a
relevant state mutation refreshes expired work, including unknown-to-unknown
reconciliation.

Current focused checks pass: 96 API tests, 42 Studio helper tests, 15 Studio
component tests, seven real PostgreSQL Team request tests, six Team overview
source tests, one Home authority integration test and 21 migration metadata
tests. All 15 migration acceptance scenarios pass through 0084. Database build,
API typechecks and scoped backend lint pass. All 18 hosted Team and responsive browser scenarios pass, including current
participant selection, human mentions and delayed-send navigation. Studio lint
and typechecking pass. Hosted and native Studio production builds pass; this is
not live release acceptance.

Remaining live checks: two-account owner/requester flows plus a nonparticipant;
Codex and Claude starts/continuation on the selected computer; unavailable
runners and reconnect/reload without duplicate work; membership/account
revocation; explicit questions, selected answers and outcome sharing to the
original private/group chat. Deploy migration 0084 only to a compatible Team
database through the normal deployment process. The User's configured Personal
database was not migrated.

# UI integration: agreed simplification

Updated 2026-10-14 from the User’s explicit decisions. This revision overrides conflicting soul/profile, role-template, Job-protocol and parallel-recall requirements in the historical ticket bodies and plans. It does not approve wholesale removal of reviewed features. Original tickets 01–23 remain as dated implementation evidence, not current release acceptance.

## Product contract

Agents retain stable identity, name, optional free-text job title and Pixelkin appearance. A title is display metadata, never instructions or authority. Execution model, reasoning, permissions and device selection belong to the chat or explicit task. Keep sequential multi-Agent conversations across the same or different providers with bounded public context.

Remove instruction generation/storage from new Agent writes and the role-template lookup/association. Preserve existing encrypted records and authorship/history; do not delete applied migrations or rewrite native source history. New progress and history derive from real execution records. Memory uses the existing supported memory_answer route, with no Agent-dependent parallel retrieval or backend LLM synthesis.

## Status and counting rules

This plan separates implemented behavior, required rewiring, and remaining testing. “Implemented” describes the recorded scope, not current release acceptance.
A historical test pass does not prove that the simplified execution path still works on every surface.
The source review below identifies dependencies. It does not replace live tests.

The earlier five-ticket count was incomplete. It hid affected features inside Ticket 27 and the final validation ticket.
Keep those features under their original ticket IDs so that each has an explicit completion gate.
These are local Markdown tickets, not Linear or GitHub issues.
No new ticket IDs or implementation authorization result from this reconciliation.

## Personal status

Shared tickets also appear in the shared table. Count each ticket ID once.

| Feature and tickets                                | Implemented                                                                                                                                                                     | Required rewiring or scope assessment                                                                                                                                                  | Remaining testing                                                                                                                                    | Current status                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Existing Projects and chats, 01                    | Project/sidebar discovery and retained conversation navigation.                                                                                                                 | No new gap identified in this review.                                                                                                                                                  | Reopen and navigation regression under 30.                                                                                                           | Implemented; regression testing open.                              |
| Standalone and Project chats, 04–05                | Home handoff, optional Agent selection, folder selection, remembered model/reasoning, native execution and continuation.                                                        | Reconcile the older complete-Project-catalogue and Project-instruction follow-ups with current provider behavior. Prove coverage before adding code. Keep 04 open for this assessment. | Current Codex/Claude starts, Project context, reload/recovery and deferred Move rows. Respect earlier explicit deferrals.                            | 04 open for assessment; 05 implemented for accepted scope.         |
| Recall and feedback, 06 and Personal portion of 15 | Recall evidence and Personal feedback were implemented. Agent chats now use the common memory_answer path.                                                                      | No separate Personal feedback rewrite identified. Collaboration portion of 15 remains open.                                                                                            | Real recall, source access loss, feedback persistence and current native execution under 30.                                                         | Personal implemented; testing open.                                |
| Agent identity and native work, 10–11 and 24–26    | Name, optional free-text title, Pixelkin, native history and execution, common Memory. Sequential same/cross-provider conversations with bounded context pass automated checks. | No additional Personal Job engine. Historical soul/template requirements are superseded.                                                                                               | Live Codex and Claude, unavailable devices, offline/restart and existing history under 30.                                                           | Personal implementation complete; live acceptance open.            |
| Pull Requests, unified 16 including former 17–18   | GitHub connection, browsing, isolated review execution, retained review data and publication controls were implemented.                                                         | Native command completion and bounded discovery replace the retired Job dependency. Preserve exact revision, account, checkout and publication authority.                              | Real review/fix paths, recovery, exact-content publication and access/revision changes. External writes retain their existing approval requirements. | Native implementation complete; live acceptance open.              |
| Home, 19                                           | Refresh, sections, chips, draft handoff and native execution reads are implemented.                                                                                             | Agent labels, Job outcomes and seen/revision logic still read legacy Jobs. Add coverage for new native Agent work without losing legacy history or duplicating child executions.       | Needs you, Ongoing work and Cleared with new Agent deliveries, failures, stale data and bounded refresh.                                             | Reopen 19 for rewiring.                                            |
| Simple/Advanced progress, 21 and 28                | Native Personal command activity, public summaries, retained details and diffs are implemented.                                                                                 | Collaboration progress belongs to 12–13 and 27. Do not treat Personal progress as proof of Team wiring.                                                                                | Compact/expanded views, history, diffs, restart and active recipient changes under 30.                                                               | Personal implemented; 21 superseded by 28 and acceptance under 30. |

## Collaboration status

Human messaging remains a separate capability from AI Agent invocation.
The removal of the Job protocol does not remove the requirement to support the Collaboration features below.

| Feature and tickets                                               | Implemented                                                                                                                            | Required rewiring or scope assessment                                                                                                                                                                                                      | Remaining testing                                                                                                   | Current status                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Team channels and shared Projects, 07                             | Durable human messages, channel creation, Project sharing and membership boundaries were implemented.                                  | No new human-messaging gap identified. Agent invocation is tracked separately in 13 and 27.                                                                                                                                                | Membership loss, Project unshare, reconnect and cross-member navigation under 30.                                   | Human messaging implemented; regression testing open.               |
| Private teammate chats, 08                                        | Private human messages, encrypted receipts and reload/restart recovery were implemented.                                               | Human-to-Agent transitions and private/group AI audience rules remain under 27.                                                                                                                                                            | Cross-account isolation, failed-send recovery and restart under 30.                                                 | Human messaging implemented; AI participation incomplete.           |
| Shared Memory, 09                                                 | Explicit sharing, retention, Team recall and admin removal were implemented for the accepted scope.                                    | Reconcile invocation through the common Memory path under 27. Team feedback remains under 15. Never substitute Personal scope for Team scope.                                                                                              | Grants, revocation, source removal, authorized Team recall and private-source isolation under 30.                   | Sharing implemented; new execution integration requires acceptance. |
| Public Square, 12                                                 | Native command publication, Team Agent offers, per-Team briefs, visibility and frozen history are implemented.                         | Native command publication, exact-turn state, real dispatch time, Team-scoped Idle, per-Team brief controls and realtime/status refresh are implemented. Legacy history remains readable; native entries do not fabricate Checking phases. | Working/waiting/completed/stale/Idle, membership loss, private-work isolation and legacy/new coexistence.           | Implemented; focused automated checks pass; live acceptance open.   |
| Channel Agent requests, 13                                        | Native request execution, owner consent, private review, status and explicit sharing are implemented; legacy requests remain readable. | Native execution replaces the retired Job acceptance handoff. Owner consent, private planning, durable command binding and explicit sharing are implemented. Ordinary channel messages stay human-only until explicit Agent selection.     | Request, acceptance, sequential same/cross-provider execution, progress, reply delivery, cancellation and recovery. | Implemented; focused automated checks pass; live acceptance open.   |
| Replies, edits and reactions, 14 including 14a–14c                | Human thread replies, edit history and reactions were implemented.                                                                     | No new human-messaging gap identified. AI reply integration belongs to 13 and 27.                                                                                                                                                          | Unread state, retries, edit history, reactions and authorization under 30.                                          | Implemented; regression testing open.                               |
| Team Memory feedback, Team portion of 15                          | Personal feedback and the separate QA storage foundation exist.                                                                        | Complete authorized Team-answer/source binding and settle the remaining Team feedback scope. Preserve memories without modification.                                                                                                       | Team-admin visibility, inaccessible sources, comment protection and reload.                                         | Partially implemented; open.                                        |
| For you, 20                                                       | Team filters, human unread/mention counts, navigation and Clear/Restore were implemented.                                              | Agent blockers/outcomes and producer revisions still use Job publications. Extend them to native Team executions and deliveries without exposing Personal work or duplicating outcomes.                                                    | Counts, grouping, clear/restore revisions, revocation, stale reads and new/legacy coexistence.                      | Reopen 20 for rewiring.                                             |
| AI participation across private/group/room surfaces, remaining 27 | Shared composer and mention UI exist. Personal recipient validation is shared between local and hosted chat.                           | Define and wire the supported AI audience and identity authority for each Collaboration destination. Channels use 13. PRs use 16. Sharing a composer does not establish invocation support.                                                | Each supported surface needs recipient, attribution, Memory scope, permission and recovery tests.                   | Partial UI; invocation contract and integration remain open.        |

## Collaboration backend and database scope

The Collaboration tickets cover Studio, API, PostgreSQL, migrations, authorization and realtime delivery where needed.
They are not UI-only tickets. Existing human messaging already has database tables, repository methods, authenticated routes and replay/reconnect infrastructure.
Reuse that backend rather than create a second messaging service.

Ticket 07's accepted scope explicitly included PostgreSQL models/migrations, API/contracts, membership checks, encrypted storage and real database tests.
Tickets 08 and 14 extended private chats and message interactions.
Tickets 15, 20 and 27 still require backend/storage work for their native Agent or feedback behavior.
Tickets 12 and 13 now use native command publication and execution while preserving durable Team visibility/request relationships; live acceptance remains open.
Migration files in source do not prove deployment into a live Team database.

See the [Orys study and backend source map](studio-orys-implementation-study.md) for the concrete existing tables and service files.

## Shared infrastructure and release status

| Tickets                     | Implemented                                                                                  | Remaining work                                                                                                                                                                                                                               | Current status                                           |
| --------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 02                          | Browser-local connection and existing local execution boundary.                              | Browser regression under 30.                                                                                                                                                                                                                 | Implemented for accepted scope.                          |
| 03                          | Hosted sign-in, backend selection and local runner integration were assembled.               | Complete the recorded two-identity/two-device acceptance: backend switching, membership/revocation, runner availability and disconnect. Own these rows in 03, referenced by 30.                                                              | Testing/acceptance open; no new code gap confirmed here. |
| 22                          | Existing Koed GitHub integration.                                                            | Discover and reuse Plugins and Skills from the actual Codex/Claude instance, computer and Project. Settle capability and isolated-runner configuration details.                                                                              | Feature integration open.                                |
| 29                          | Reference research and initial recurring-task direction.                                     | Settle schedule, time-zone, missed-run, overlap and restart semantics. Implement through native Codex/Claude execution, common Memory and history. Team availability/audience must be explicit before Team use.                              | Planned; scheduler not implemented or enabled.           |
| 30, incorporating former 23 | Focused automated checks and Studio production build pass for the simplification checkpoint. | Release regression on both sides, provider execution, deployment/migrations, packaging and supported platforms. Reference 03's acceptance results rather than counting those tests twice. Retain previous explicit deferrals until resolved. | Testing/release open.                                    |

## Remaining ticket count

There are 12 distinct open tickets: six require feature work or rewiring, one needs a scope assessment, and five cover testing/release acceptance.
The number counts tickets, not estimated effort. A ticket with both code and tests counts once.
A surface can remain untested without creating another implementation ticket.

| Owning area       | Open tickets                                   | Count |
| ----------------- | ---------------------------------------------- | ----- |
| Personal          | 04, 16, 19                                     | 3     |
| Collaboration     | 12, 13, 15, 20, 27                             | 5     |
| Shared            | 03, 22, 29, 30                                 | 4     |
| Total, unique IDs | 03, 04, 12, 13, 15, 16, 19, 20, 22, 27, 29, 30 | 12    |

The seven feature/rewiring/assessment tickets are 04, 15, 19, 20, 22, 27 and 29.
Ticket 04 needs an assessment before claiming a new implementation gap. Tickets 15, 22, 27 and 29 retain unresolved scope details.
The five testing/release tickets are 03, 12, 13, 16 and 30. Acceptance can reveal further implementation defects.

Tickets 17–18 are consolidated into 16, 21 into 28, and 23 into 30. Subtasks 14a–14c remain within 14.
Historical local Codex acceptance and explicit deferrals in 04–05 remain recorded. Reopening 04 for assessment does not revoke those accepted results.
Tickets 24–26 and the native Personal portion of 28 are implemented. Team progress dependencies remain explicit in 12–13 and 27.
No Collaboration feature is considered complete solely because its old Job-based path passed tests.

## Pull Request reference requirements

Ticket 16 also includes the [Orys implementation study](studio-orys-implementation-study.md), reviewed at `bb94822abf0c989a1840a028666ccb5652efea5d`.
The initial inspection found bounded inbox reads without a five-minute discovery scheduler. Ticket 16 adds this scheduler through the existing operation queue.
Add lightweight discovery at startup and every five minutes, with manual, supported wake and reconnect triggers through the existing authorized runner.
Coalesce triggers across windows and cap work per refresh. Fetch diffs and repositories separately when needed.
Retain authorized last known data on transient failure and reject stale account/connection results.
Preserve changed-commit history, explicit review starts and exact publication confirmation.
The active-review progress timer is separate from GitHub discovery.
This scope remains under Ticket 16. No additional execution lifecycle is introduced.

## Recommended sequence

Next implementation: Ticket 19, Home activity from native Agent commands and deliveries. Tickets 12, 13 and 16 remain open for live acceptance. Their native replacements are implemented. Retain the scope assessments and destination decisions below before extending those surfaces.

1. Assess 04 and settle the destination-specific scope in 27 and 15.
2. Restore channel Agent execution under 13 and complete other supported destinations under 27.
3. Rewire Public Square 12, PRs 16, Home 19 and For you 20 against native execution.
4. Complete 15 and the approved scope of Plugins/Skills 22 and recurring tasks 29.
5. Complete 03 and 30 acceptance with separate Personal and Collaboration results.

Run focused tests during each implementation ticket. Final release testing does not replace those completion gates.

## Evidence and limits

Reconciled on 2026-10-14 against branch commit 9ed5d9b1, the local ticket index and original ticket records.
Source dependencies that justify reopening tickets include:

| Ticket | Source evidence at reconciliation                                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 04     | The Project catalogue/context follow-ups in studio-personal-agents-plan.md and the accepted/deferred rows in the original Ticket 04 manual script need reconciliation. Native providers can load folder instructions themselves. This review does not establish that all Project instructions fail. |
| 12     | public-square-repository.ts joins personal_agent_team_job_publications, personal_agent_execution_jobs and personal_agent_execution_attempts.                                                                                                                                                        |
| 13     | At reconciliation, createManagedConversationAcceptedAgentAssignmentWithClient returned 410 after the Job protocol retirement. The Ticket 13 checkpoint below replaces this path with native execution.                                                                                              |
| 16     | At reconciliation, pull-request-repository.ts required a succeeded personal_agent_execution_jobs row for retained review output. The Ticket 16 checkpoint replaces that dependency with native command provenance.                                                                                  |
| 19     | home-repository.ts still obtains Agent labels, outcomes and seen revisions from personal_agent_execution_jobs, alongside existing native execution reads.                                                                                                                                           |
| 20     | team-overview-sources.ts joins Job publications and Jobs for Agent blockers/outcomes and producer revisions. Human-message sources are separate.                                                                                                                                                    |
| 27     | The historical chat-surface matrix distinguishes Personal execution from Collaboration audience/identity/Memory authorization. Current shared presentation alone does not prove those adapters.                                                                                                     |

The complete original ticket records remain in the local prototype checkout under .scratch/koed-frontend-integration.
This versioned plan carries the current reconciliation so that the status is available in the repository.
Koed recall returned an unverifiable answer during this reconciliation. No recalled statement was used as evidence.
The initial reconciliation added no implementation or live acceptance result. The later Ticket 13 checkpoint below records the native replacement and its validation separately.

## Recurring-task reference

Inspected CopilotKit/OpenDots main at `625452e06cde74cb25b0ce319e2c1be0488f5a5f` on 2026-10-14. Reference: https://github.com/CopilotKit/OpenDots. Its `src/server/store.ts` persists interval/next-run state, claims runs with leases, schedules repeats after success and retains interrupted/failed runs for explicit review. `src/server/runner.ts` separates scheduling from an injected executor. Its default chat adapter uses an OpenAI-compatible API (`src/server/dot-agent.ts`), not Codex app-server. Claude support is not established by that adapter.

Reuse concepts only initially: schedule separate from execution, durable occurrence identity, explicit pause/resume/Run now, next-run visibility and honest interruption. Adapt execution through Koed’s existing Codex and Claude native adapters. Decide interval versus calendar/time-zone semantics, missed-run behavior, concurrency and restart handling before implementation. An unavailable provider/device must not trigger another account/provider or silently replay uncertain effects. Scheduled runs use the same Memory and progress path and appear in Agent/conversation history. No OpenDots runtime, credential model, Intelligence dependency or separate Memory store is adopted.

## Validation and data boundaries

Use disposable branch test databases: the currently configured Personal database belongs to a newer main-line runtime and is not compatible with the old packaged Studio test app. Keep Memory service restoration separate from running branch migrations. Preserve all previous staged multi-Agent changes and history. Do not claim that a focused test, a plan status or an old review certifies live Codex/Claude, hosted, Team, PR or Windows/Linux behavior. Record each tested surface and remaining acceptance gap.

## Implementation checkpoint — 2026-10-14

Tickets 24–26 and the native-chat portion of 28 are implemented. Agent metadata writes no longer store soul instructions or profile model defaults. Retained legacy versions remain readable. Native deliveries and executions supply history, actual activity and launch settings without fabricated attempts. The Agent-specific assignment/phase-reporting tools and eager Memory retrieval are removed.

Ticket 27 shares Personal recipient validation between local and hosted chat and retains sequential same/cross-provider execution. Hosted regression checks cover bootstrap, acceptance before navigation, preservation of later draft edits, and access revocation. Team request acceptance that depended on the retired Job protocol now returns an explicit unsupported response rather than writing more Jobs. Replacing that Team workflow and verifying PR-specific adapters remain open acceptance work; this is not an entire-UI completion claim.

Validation: Studio production build, API, worker and Studio typechecks, focused Agent API/editor/launch/activity tests, two existing browser scenarios, and disposable PostgreSQL history/authority checks pass. Release metadata is synchronized. All sixteen disposable multi-Agent execution scenarios pass, including same/cross-provider ordering, idempotent retries, uncertain outcomes, bounded context and identity rename continuity. Live provider execution, hosted two-device use, Team/PR flows, and Windows/Linux release checks remain open. The installed Memory runtime is healthy; this branch has not been deployed into the current Personal database or packaged app.

Backend validation also passes: worker service/dispatcher 109 tests, API context/routes/runner/local-edge 144 tests, DB repository 26 tests, and shared contracts 21 tests. These focused counts overlap some earlier checks; they are not a full-repository test total.

## Push-check limitations from the implementation checkpoint

Whole-tree formatting/lint scans traversed generated build output and were stopped.
Root ESLint 10 cannot load the installed React plugin. The changed-file ESLint 9 scan also reports broader configuration and existing typed-lint findings.
Refactor leftovers were corrected. Package-scoped checks passed where recorded. This is not a passing whole-repository lint gate.

## Ticket 13 implementation checkpoint, 2026-10-14

The User authorized the next ticket with GPT-6 Luna Extra High subagents.
DB/shared, API/worker and Studio slices replace the retired acceptance handoff with native execution.
Owner consent, private refinement, bounded editable context and explicit channel publication remain required.
A broad status update never authorizes publication of private response text or Memory.
The new request status uses native commands while historical Job requests remain readable.
Public Square and For you projection rewiring remain Tickets 12 and 20.
The existing minor changeset includes this work with the User's approval.
The [native channel execution record](studio-team-agent-native-execution.md) records implementation and focused validation.
The database suite (5), worker suite (114), API route/summary suites (114), Studio UI tests (7), helper tests (19) and hosted browser scenarios (8) pass. Migration acceptance passes all 15 scenarios; Personal multi-Agent regression passes all 16 scenarios. Production Studio build and relevant package typechecks pass.
Ticket 13 stays open for live provider, native owner/hosted colleague, reconnect and deployment acceptance. Migration 0079 has only been tested in disposable databases; the current Personal database was not migrated. A broader API run has failures outside the focused flows with baseline unconfirmed.
The open count remains 12: eight feature/rewiring tickets, one scope assessment and three acceptance tickets (03, 13 and 30).

## Ticket 12 implementation checkpoint, 2026-10-14

The User authorized native Public Square rewiring with GPT-6 Luna Extra High subagents and inclusion in the existing minor changeset.
Native command activity replaces new Job publications. Preserve historical Job-backed cards, independent owner-reviewed Team briefs, owner-only private conversation navigation, Project publication boundaries and frozen former-owner history.
Native Working, Waiting, Offline, terminal and uncertain states must use trusted execution evidence. Do not restore Agent phase tools or infer Checking from message text. Idle means no active work published in this Team, including work outside the current history page.
Validation must distinguish focused database/API/Studio/browser evidence from live deployed acceptance. The current Personal database must not receive branch migrations.
Implemented native command publication with immutable Agent/original-Project context and no new Job writes. The approved minor changeset includes this work.

Validation:

- Disposable PostgreSQL suites: 24 tests pass across native Public Square (5), retained legacy Public Square (14) and channel request regression (5). Native cases cover private identifiers, exact-turn waiting, offline and generation uncertainty, independently encrypted Team briefs, owner-only drafts, withdrawal/CAS, departure/admin removal/rejoin, Project unshare, first-share/move boundaries, current-first pagination and Idle beyond the visible page.
- Migration acceptance: all 15 scenarios pass through migration 0080, including clean upgrade, backup/restore and idempotent rerun.
- Personal multi-Agent regression: all 16 disposable database scenarios pass, including same/cross-provider execution, restart/reconciliation and retained history.
- Managed command producer tests: 32 pass. Shared publication contract tests: 5 pass. API collaboration/routing tests: 65 pass.
- Studio presenter/client helpers: 22 pass. Status refresh/helper tests: 9 pass, including visible/online gating, bounded cadence, no catalogue reload, authoritative removal and stopping when the pane is closed.
- Existing responsive browser suite: 9 scenarios pass across mobile/tablet/desktop; screenshots at 320px and 1440px inspected. These use synthetic API data, not live provider execution.
- Studio production build and DB/shared/API/worker/Studio typechecks pass. Changed-file formatting/lint and release consistency pass.

Broader gates are not claimed green: an exploratory DB package run requires an unset DATABASE_URL for another integration suite, and a shared package run reported four receipt-equality failures in an unchanged test area; no clean-revision baseline was established. Earlier broad API/lint limitations remain recorded above.
Migration 0080 was tested only in disposable databases. The configured Personal database was not migrated. Live native/hosted owner-and-colleague acceptance, runner disconnect/reconnect and real Codex/Claude publication remain open under Ticket 12, referenced by 03/30.
The open count remains 12: seven feature/rewiring tickets, one scope assessment and four acceptance tickets (03, 12, 13 and 30).

## Ticket 16 implementation checkpoint (2026-10-14)

Native review prompts now retain server-authorized review markers and exact revisions.
Initial reviews and explicit Review latest commands can create editable drafts through native command completion.
Ordinary discussion does not replace a draft. Invalid review output fails explicitly and preserves the retained provider reply.
Temporary draft-storage failures retry the saved checkpoint instead of requesting another provider turn.

The runner owns five-minute inbox discovery. Startup, reconnect and supported wake triggers reuse the existing durable operation queue.
A database constraint coalesces active global inbox work for the same owner, runner, account and connection generation.
Studio observes saved snapshots and exposes manual refresh, partial coverage and the last successful update.
Repository browsing and Load more remain explicit metadata reads. Discovery does not clone code, start reviews or publish to GitHub.
See [native review and discovery wiring](studio-pr-orys-port-plan.md) for storage and authority boundaries.

Confirmed core checks: 118 API tests, 34 managed-conversation repository tests, the real PostgreSQL PR authority scenario, all 15 migration acceptance scenarios, and all 16 multi-Agent database scenarios.
The 146 focused worker tests, nine shared contract/driver tests, 47 Studio client/proxy tests and four inbox helper tests pass.
All three existing PR browser scenarios pass, including manual refresh, saved repository pagination and reopening a saved review.
The Studio production build and relevant package typechecks pass.

Live Codex and Claude reviews, a full worker-process restart during PR draft capture, hosted device interruption and exact-content GitHub publication remain acceptance work.
The recovery unit tests cover command proof reuse and failure disposition. They do not prove provider dispatch behavior across a full service restart.
The configured Personal database was not migrated. PostgreSQL validation used disposable databases.

Scoped lint still reports existing errors in managed-conversation-service.ts, pull-request-repository.ts and github-delegated.ts.
The same rules fail on the branch HEAD versions. These are outside the new behavior and do not establish that repository-wide CI passes.

# UI integration: agreed simplification

Updated 2026-10-15 from the User’s explicit decisions. This revision overrides conflicting soul/profile, role-template, Job-protocol and parallel-recall requirements in the historical ticket bodies and plans. It does not approve wholesale removal of reviewed features. Original tickets 01–23 remain as dated implementation evidence, not current release acceptance.

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

| Feature and tickets                                | Implemented                                                                                                                                                                     | Required rewiring or scope assessment                                                                                                                                                                                                                                                                                                                                                                                                       | Remaining testing                                                                                                                                                       | Current status                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Existing Projects and chats, 01                    | Project/sidebar discovery and retained conversation navigation.                                                                                                                 | No new gap identified in this review.                                                                                                                                                                                                                                                                                                                                                                                                       | Reopen and navigation regression under 30.                                                                                                                              | Implemented; regression testing open.                                                               |
| Standalone and Project chats, 04–05                | Home handoff, optional Agent selection, folder selection, remembered model/reasoning, native execution and continuation.                                                        | Assessment complete: local registered-Project selection and accepted Codex context are wired. Claude root instructions are enabled for fresh sessions; live local loopback UI starts, reload/reopen, restart recovery and permission denial pass; Skill support follows Ticket 22’s verified isolated adapter; fork/device transfer remain unavailable; the hosted catalogue gap remains explicitly deferred. See the Ticket 04 assessment. | Other surfaces/executable versions, remaining live edge cases and deferred Move/hosted rows. Local Claude loopback starts, reload/reopen and restart recovery now pass. | 04 local Claude UI accepted; retained acceptance/deferrals open. 05 implemented for accepted scope. |
| Recall and feedback, 06 and Personal portion of 15 | Recall evidence and Personal feedback were implemented. Agent chats now use the common memory_answer path.                                                                      | No separate Personal feedback rewrite identified. Collaboration portion of 15 remains open.                                                                                                                                                                                                                                                                                                                                                 | Real recall, source access loss, feedback persistence and current native execution under 30.                                                                            | Personal implemented; testing open.                                                                 |
| Agent identity and native work, 10–11 and 24–26    | Name, optional free-text title, Pixelkin, native history and execution, common Memory. Sequential same/cross-provider conversations with bounded context pass automated checks. | No additional Personal Job engine. Historical soul/template requirements are superseded.                                                                                                                                                                                                                                                                                                                                                    | Live Codex and Claude, unavailable devices, offline/restart and existing history under 30.                                                                              | Personal implementation complete; live acceptance open.                                             |
| Pull Requests, unified 16 including former 17–18   | GitHub connection, browsing, isolated review execution, retained review data and publication controls were implemented.                                                         | Native command completion and bounded discovery replace the retired Job dependency. Preserve exact revision, account, checkout and publication authority.                                                                                                                                                                                                                                                                                   | Real review/fix paths, recovery, exact-content publication and access/revision changes. External writes retain their existing approval requirements.                    | Native implementation complete; live acceptance open.                                               |
| Home, 19                                           | Refresh, sections, chips, draft handoff, native delivery/command activity and owned Team work are implemented.                                                                  | Native work uses existing commands, deliveries and Team request authority. Legacy Jobs remain readable; exact command bindings prevent duplicate failure reminders.                                                                                                                                                                                                                                                                         | Needs you, Ongoing work and Cleared with new Agent deliveries, failures, stale data and bounded refresh.                                                                | Native implementation complete; live acceptance open.                                               |
| Simple/Advanced progress, 21 and 28                | Native Personal command activity, public summaries, retained details and diffs are implemented.                                                                                 | Collaboration progress belongs to 12–13 and 27. Do not treat Personal progress as proof of Team wiring.                                                                                                                                                                                                                                                                                                                                     | Compact/expanded views, history, diffs, restart and active recipient changes under 30.                                                                                  | Personal implemented; 21 superseded by 28 and acceptance under 30.                                  |

## Collaboration status

Human messaging remains a separate capability from AI Agent invocation.
The removal of the Job protocol does not remove the requirement to support the Collaboration features below.

The [Ticket 27 Collaboration assessment](studio-collaboration-chat-assessment.md) maps the native and hosted surfaces to their existing contracts. Private/group Agent requests now reuse the existing channel workflow under the User-approved participant-only audience, with owner-private review/start and explicit result sharing. Native and hosted composers share participant filtering and retain exact-origin authority. The native channel status-invalidation gap is also corrected. Live provider and cross-account acceptance remain open.

| Feature and tickets                                               | Implemented                                                                                                                                                                                                                                                        | Required rewiring or scope assessment                                                                                                                                                                                                      | Remaining testing                                                                                                                                 | Current status                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Team channels and shared Projects, 07                             | Durable human messages, channel creation, Project sharing and membership boundaries were implemented.                                                                                                                                                              | No new human-messaging gap identified. Agent invocation is tracked separately in 13 and 27.                                                                                                                                                | Membership loss, Project unshare, reconnect and cross-member navigation under 30.                                                                 | Human messaging implemented; regression testing open.                               |
| Private teammate chats, 08                                        | Private human messages, encrypted receipts and reload/restart recovery were implemented.                                                                                                                                                                           | Participant-owned Agent requests and private owner execution are implemented under 27; retain the immutable human participant-set contract.                                                                                                | Cross-account isolation, failed-send recovery and restart under 30.                                                                               | Human and approved Agent wiring implemented; live acceptance open.                  |
| Shared Memory, 09                                                 | Explicit sharing, retention, Team recall and admin removal were implemented for the accepted scope.                                                                                                                                                                | Reconcile invocation through the common Memory path under 27. Team feedback remains under 15. Never substitute Personal scope for Team scope.                                                                                              | Grants, revocation, source removal, authorized Team recall and private-source isolation under 30.                                                 | Sharing implemented; new execution integration requires acceptance.                 |
| Public Square, 12                                                 | Native command publication, Team Agent offers, per-Team briefs, visibility and frozen history are implemented.                                                                                                                                                     | Native command publication, exact-turn state, real dispatch time, Team-scoped Idle, per-Team brief controls and realtime/status refresh are implemented. Legacy history remains readable; native entries do not fabricate Checking phases. | Working/waiting/completed/stale/Idle, membership loss, private-work isolation and legacy/new coexistence.                                         | Implemented; focused automated checks pass; live acceptance open.                   |
| Channel Agent requests, 13                                        | Native owner-private request execution, consent, review, status and explicit sharing; legacy reads retained. Local Docker Codex run now verifies planning denial, accepted file creation, private follow-up, exact-command summary and owner-reviewed publication. | Paired wake and owner-review API wiring corrected. Safe empty-history recovery and non-Codex runtime-item output fallback remain; see TODO.md.                                                                                             | Claude, additional Devices, nested-thread destinations, cancellation/access-loss races, restart and deployed Team acceptance remain open.         | Codex loopback core passes; remaining implementation and live acceptance open.      |
| Replies, edits and reactions, 14 including 14a–14c                | Human thread replies, edit history and reactions were implemented.                                                                                                                                                                                                 | No new human-messaging gap identified. AI reply integration belongs to 13 and 27.                                                                                                                                                          | Unread state, retries, edit history, reactions and authorization under 30.                                                                        | Implemented; regression testing open.                                               |
| Team Memory feedback, Team portion of 15                          | Personal feedback and the separate QA storage foundation exist.                                                                                                                                                                                                    | Complete authorized Team-answer/source binding and settle the remaining Team feedback scope. Preserve memories without modification.                                                                                                       | Team-admin visibility, inaccessible sources, comment protection and reload.                                                                       | Partially implemented; open.                                                        |
| For you, 20                                                       | Team filters, human attention, native Agent blockers/outcomes, PR actions and exact-revision reminders are implemented.                                                                                                                                            | Native work reuses Team publications and exact command authority. Legacy history remains readable. Team-scoped keys and loaded-page refreshes preserve independent reminders.                                                              | Counts, grouping, clear/restore revisions, revocation, stale reads and new/legacy coexistence.                                                    | Native implementation complete; live acceptance open.                               |
| AI participation across private/group/room surfaces, remaining 27 | Shared composer, participant-filtered Agent selection, exact-origin requests, owner-private native acceptance and authorized Home/For you projections are implemented. Personal recipient validation remains shared between local and hosted chat.                 | Reuse native request execution from 13 and the supported Memory path. Approved destination wiring exists; shared native recovery and non-Codex adapter follow-ups found under 13 also apply. Private results require explicit sharing.     | Live Codex/Claude, owner/requester/outsider isolation, native/hosted recovery and exact-origin sharing; keep Personal and PR acceptance separate. | Approved destination wiring implemented; focused checks pass; live acceptance open. |

## Collaboration backend and database scope

The Collaboration tickets cover Studio, API, PostgreSQL, migrations, authorization and realtime delivery where needed.
They are not UI-only tickets. Existing human messaging already has database tables, repository methods, authenticated routes and replay/reconnect infrastructure.
Reuse that backend rather than create a second messaging service.

Ticket 07's accepted scope explicitly included PostgreSQL models/migrations, API/contracts, membership checks, encrypted storage and real database tests.
Tickets 08 and 14 extended private chats and message interactions.
Ticket 15 still requires backend/storage work for its deferred feedback behavior. Tickets 20 and 27 now reuse native execution and existing Collaboration storage; their live and deployment acceptance remains open.
Tickets 12 and 13 now use native command publication and execution while preserving durable Team visibility/request relationships; live acceptance remains open.
Migration files in source do not prove deployment into a live Team database.

See the [Orys study and backend source map](studio-orys-implementation-study.md) for the concrete existing tables and service files.

## Shared infrastructure and release status

| Tickets                     | Implemented                                                                                                                                                                             | Remaining work                                                                                                                                                                                                                               | Current status                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 02                          | Browser-local connection and existing local execution boundary.                                                                                                                         | Browser regression under 30.                                                                                                                                                                                                                 | Implemented for accepted scope.                          |
| 03                          | Hosted sign-in, backend selection and local runner integration were assembled.                                                                                                          | Complete the recorded two-identity/two-device acceptance: backend switching, membership/revocation, runner availability and disconnect. Own these rows in 03, referenced by 30.                                                              | Testing/acceptance open; no new code gap confirmed here. |
| 22                          | Shared scoped Skill picker across Studio and Electron, owner-private launch, native availability/execution status, bounded discovery, send-time revalidation and access-change fencing. | Verify live native invocation, reconnect and supported device/hosted paths. Installation and sign-in stay in the original Client; provider execution limits are recorded in the Plugins/Skills checkpoint.                                   | Supported integration implemented; live acceptance open. |
| 29                          | Owner-managed schedules, encrypted definitions, durable occurrences, native submission/recovery and Studio controls are implemented.                                                    | Validate live Codex/Claude, offline restart, hosted device recovery and packaging/deployment. Latest-only missed runs, overlap prevention, review and private audience rules are implemented; see the recurring-task design.                 | Implementation complete; live acceptance open.           |
| 30, incorporating former 23 | Focused automated checks and Studio production build pass for the simplification checkpoint.                                                                                            | Release regression on both sides, provider execution, deployment/migrations, packaging and supported platforms. Reference 03's acceptance results rather than counting those tests twice. Retain previous explicit deferrals until resolved. | Testing/release open.                                    |

## Remaining ticket count

There are 12 distinct open tickets. They include retained feature scope, recovery/adapter follow-ups found during live validation, and remaining testing/release acceptance.
The number counts tickets, not estimated effort. A ticket with both code and tests counts once.
A surface can remain untested without creating another implementation ticket.

| Owning area       | Open tickets                                   | Count |
| ----------------- | ---------------------------------------------- | ----- |
| Personal          | 04, 16, 19                                     | 3     |
| Collaboration     | 12, 13, 15, 20, 27                             | 5     |
| Shared            | 03, 22, 29, 30                                 | 4     |
| Total, unique IDs | 03, 04, 12, 13, 15, 16, 19, 20, 22, 27, 29, 30 | 12    |

Ticket 15 retains feature/scope work. Live Ticket 13 validation also identified recovery and remote-adapter follow-ups under 04, 13 and the shared execution dependency of 27. Ticket 04 now has a default-enabled implementation with live local loopback UI acceptance; retained acceptance and explicit deferrals remain open.
Ticket 04 assessment is complete; the User chose instruction-only Claude loading with permission isolation before enablement. Its hosted catalogue gap and prior live-review deferrals remain explicit. Ticket 22's [implementation checkpoint](studio-plugins-skills-assessment.md#implementation-checkpoint) records the supported integration, provider limits and remaining live acceptance; Client-owned installation and sign-in boundaries remain unchanged. Ticket 15 retains its explicit scope deferral. Ticket 29’s approved owner-private implementation and focused checks are complete; live and deployment acceptance remain open. Ticket 27’s approved destination wiring is implemented; its live acceptance remains open.
Tickets 03, 04, 12, 13, 16, 19, 20, 22, 27, 29 and 30 retain testing/release acceptance. The newly found recovery and adapter gaps are implementation work within those existing tickets, not additional ticket IDs.

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

Ticket 04 assessment is recorded in [Project chat assessment](studio-project-chat-assessment.md). Local Codex does not need a catalogue/instructions rebuild. The instruction-only Claude adapter passed live validation and is enabled for fresh sessions without changing permission authority; its local loopback UI acceptance now passes. Preserve the deferred hosted catalogue and remaining live-review scope. Ticket 15's Team-visible-answer feedback was explicitly deferred beyond the internal release; resolve that deferral before treating it as ready for implementation. Tickets 12, 13, 16, 19 and 20 remain open for live acceptance. Their native replacements are implemented. Retain the scope assessments and destination decisions below before extending those surfaces.

1. Retain Ticket 04’s recorded local Claude UI acceptance and its remaining explicit deferrals. Resolve Ticket 15’s explicit feedback deferral before treating that feature as ready for implementation.
2. Validate native channel Agent execution under 13 and private/group Agent execution under 27, including owner/requester/outsider isolation and recovery.
3. Complete live acceptance for native Public Square 12, PRs 16, Home 19 and For you 20.
4. Validate recurring tasks 29 and, after its explicit deferral is resolved, implement Team feedback 15. Validate the supported Plugins/Skills 22 implementation against live Clients and devices.
5. Complete 03 and 30 acceptance with separate Personal and Collaboration results.

Run focused tests during each implementation ticket. Final release testing does not replace those completion gates.

## Evidence and limits

Reconciled on 2026-10-14 against branch commit 9ed5d9b1, the local ticket index and original ticket records.
Source dependencies that justify reopening tickets include:

| Ticket | Source evidence at reconciliation                                                                                                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 04     | Reassessed against 233b5a18 on 2026-10-15: local catalogue and accepted Codex context are wired. Claude disables native Project instructions through empty settings sources; enabling them also loads Project permission settings. Hosted graph-based choices can omit empty registered Projects. See studio-project-chat-assessment.md; preserve explicit deferrals. |
| 12     | public-square-repository.ts joins personal_agent_team_job_publications, personal_agent_execution_jobs and personal_agent_execution_attempts.                                                                                                                                                                                                                          |
| 13     | At reconciliation, createManagedConversationAcceptedAgentAssignmentWithClient returned 410 after the Job protocol retirement. The Ticket 13 checkpoint below replaces this path with native execution.                                                                                                                                                                |
| 16     | At reconciliation, pull-request-repository.ts required a succeeded personal_agent_execution_jobs row for retained review output. The Ticket 16 checkpoint replaces that dependency with native command provenance.                                                                                                                                                    |
| 19     | At reconciliation, home-repository.ts obtained Agent labels, outcomes and reminder revisions from personal_agent_execution_jobs. The Ticket 19 checkpoint replaces new-work dependencies with native commands/deliveries while retaining legacy history.                                                                                                              |
| 20     | At reconciliation, team-overview-sources.ts used Job publications for Agent activity. The Ticket 20 checkpoint below adds native publication/command sources, retaining legacy and human-message authority.                                                                                                                                                           |
| 27     | The historical chat-surface matrix distinguishes Personal execution from Collaboration audience/identity/Memory authorization. Current shared presentation alone does not prove those adapters.                                                                                                                                                                       |

The complete original ticket records remain in the local prototype checkout under .scratch/koed-frontend-integration.
This versioned plan carries the current reconciliation so that the status is available in the repository.
Koed recall returned an unverifiable answer during this reconciliation. No recalled statement was used as evidence.
The initial reconciliation added no implementation or live acceptance result. The later Ticket 13 checkpoint below records the native replacement and its validation separately.

## Recurring-task reference

Inspected CopilotKit/OpenDots main at `625452e06cde74cb25b0ce319e2c1be0488f5a5f` on 2026-10-14. Reference: https://github.com/CopilotKit/OpenDots. Its `src/server/store.ts` persists interval/next-run state, claims runs with leases, schedules repeats after success and retains interrupted/failed runs for explicit review. `src/server/runner.ts` separates scheduling from an injected executor. Its default chat adapter uses an OpenAI-compatible API (`src/server/dot-agent.ts`), not Codex app-server. Claude support is not established by that adapter.

Reuse concepts only initially: schedule separate from execution, durable occurrence identity, explicit pause/resume/Run now, next-run visibility and honest interruption. Adapt execution through Koed’s existing Codex and Claude native adapters. Decide interval versus calendar/time-zone semantics, missed-run behavior, concurrency and restart handling before implementation. An unavailable provider/device must not trigger another account/provider or silently replay uncertain effects. Scheduled runs use the same Memory and progress path and appear in Agent/conversation history. No OpenDots runtime, credential model, Intelligence dependency or separate Memory store is adopted.

Ticket 29's 2026-10-15 implementation follows the [agreed scheduling and recovery rules](studio-recurring-agent-tasks.md), which resolve those initial questions. A follow-up reference check at OpenDots `79b4db192f608cfa6f2976c6f16a160a1a952424` retained interruption review as a useful concept. Koed uses the User-approved fixed cadence and latest-only missed-run policy through its own native execution lifecycle.

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

### Ticket 13 live checkpoint, 2026-10-15

The isolated Docker Codex core flow passes: real pre-acceptance write denial, explicit acceptance and exact file creation, same-key acceptance retry without duplicate work or legacy Jobs, owner/requester/outsider isolation, private follow-up, exact accepted-command summary sourcing, owner-edited publication and reload continuation in the same execution. Native setup, Collaboration focus retention, Team owner identity, paired-worker wake notifications, initial-send lifecycle and remote owner-review lookup defects were corrected with Luna Extra High subagents. The approved existing minor changeset includes these corrections.

This is local loopback validation with real provider execution and authenticated test accounts. Claude, additional Devices, Google/WorkOS, deployed Teams, cancellation/revocation races and retained UI coverage remain open. Safe recovery when the first prompt failed before any provider history, and the remote non-Codex output fallback, are implementation follow-ups in `TODO.md`. Do not weaken the provider-history guard. See the [live evidence and limits](studio-team-agent-native-execution.md#local-docker-live-result-2026-10-15).

No ticket is closed by this partial acceptance result. The distinct open-ticket count remains **12**.

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

Ticket 16 publication: commit `9f04f8128a0440455d806fdb2373fd1c942a7b81` is pushed to `epic/ui-revamp`. [Studio UI regression 38633997597](https://github.com/koed-labs/koed/actions/runs/38633997597) passed.

## Ticket 19 implementation checkpoint, 2026-10-14

Native Home activity now reads owner-scoped conversation deliveries, current failed commands and accepted native Team work through the existing Home feed. Legacy Jobs remain readable. Successful ordinary chat replies appear in Ongoing work rather than creating a review requirement. Team publication decisions remain explicit, with private execution navigation reserved for the owner.

Clear and Restore retain the existing account-owned reminder table. Semantic revisions ignore refresh timestamps, command claims, display names and unrelated private follow-ups. Exact command/generation/failure checks prevent duplicate failure reminders and prevent an explicitly skipped delivery from reappearing as a generic execution failure. Existing valid failure dismissals remain respected when native delivery attribution is introduced. No Job lifecycle, execution system or Memory path was added.

The User approved inclusion in the existing minor changeset. Migration 0082 widens the existing reminder source check; it was tested only in disposable databases. The configured Personal database was not migrated. Ticket 19 changes remain local, following the separately published Ticket 16 checkpoint above.

Validation: disposable PostgreSQL Home authority acceptance passed, along with all 15 migration scenarios through 0082. API Home/upstream tests (53), desktop proxy tests (eight), Studio Home/client/routing/refresh tests (26) and six Home browser scenarios passed. Existing Agent/Team/responsive browser cases (19) and PR browser cases (three) also passed. Shared/DB builds, API typecheck and full build, Studio production build, migration metadata and release consistency checks passed. Browser cases use synthetic APIs; these counts are focused evidence, not a whole-repository test total. [Home review guidance](studio-home-review.md) records behavior and deployment requirements.

Ticket 19 remains open for live native/hosted account synchronization, provider and deployment acceptance. Changed-file lint and formatting pass. A broader shared-package run reported four custody-test failures outside the changed Home files; a clean-revision baseline was not established. Existing broader lint/test limitations remain recorded above. The open count remains 12: five feature/rewiring tickets, one scope assessment and six testing/release tickets. Ticket 20, Team → For you native activity, is next.

Ticket 19 publication: commit `835696ffc4326a95575e66719f9a1c6b1ea538d9` is pushed to `epic/ui-revamp`. GitHub Studio UI regression [38637875416](https://github.com/koed-labs/koed/actions/runs/38637875416) passed.

## Ticket 20 native rewiring authorization, 2026-10-14

The User authorized implementation using GPT-6 Luna Extra High subagents and inclusion in the existing minor changeset. Native For you sources will reuse existing Team publication, request and command authority. Preserve human-message grouping/unread behavior, legacy history, Agent availability, per-User exact-revision reminders and visibility-only outcome acknowledgements. Native Team destinations expose authorized publication and Team Project identifiers, without private execution or command IDs. No additional Job lifecycle or Memory retrieval path is introduced.

## Ticket 20 implementation checkpoint, 2026-10-14

Implemented using GPT-6 Luna Extra High subagents, with the User's approval to include the work in the existing minor changeset. For you reads native Team Agent blockers and significant outcomes through existing publication/command authority. Legacy Job history, human messaging/unread state, Agent availability and canonical actions remain in place. Private command/execution IDs, prompts, runtime questions and response text are excluded from Team feed DTOs. Native links open the exact authorized Public Square publication.

Native PR actions require the exact current draft, command, generation, account and reviewed commits. Duplicate publications are grouped into one PR action, suppressing their generic outcomes for the owner. Explicitly shared request outcomes do not produce duplicate catch-up. Terminal history retains Public Square's connection-remap behavior; Project unshare and publication withdrawal remove access.

Reminder and seen state use existing per-User storage and semantic source revisions. Display names, leases, reconnect and unrelated private turns do not resurface reminders. Actual question revisions do. API and UI keys include Team ID, preserving independent state when a PR appears in two Teams. Refresh now retains all loaded pages instead of resetting to the first page after reaching the end.

Validation passed: focused PostgreSQL source/reminder suites (two files, six tests), shared contracts (two), API collaboration/upstream (69), desktop proxy (six), client/helpers (21), Team Agent UI/progress (seven), and 30 maintained browser scenarios across Team, Home, Agents, PR and responsive layouts. All 15 migration acceptance scenarios passed through 0083 in disposable databases. Shared/DB checks, API typecheck/full build, hosted and desktop Studio production builds, changed-file lint/formatting, migration metadata, release consistency and diff checks passed. Browser scenarios use synthetic APIs; the counts are focused evidence, not a whole-repository gate.

A broader shared-package invocation reported four custody receipt equality failures in unchanged files (`mentionUserIds: []`); no clean-revision baseline was established. Existing broad-gate limitations remain recorded above. Migration 0083 only widens the existing reminder source allowlist. The configured Personal database was not migrated; live native/hosted and provider/deployment acceptance remains open. Ticket 20 changes remain local and are not part of the Ticket 19 push.

The open count remains 12: four feature/rewiring tickets (15, 22, 27, 29), one gated implementation (04), and seven testing/release tickets (03, 12, 13, 16, 19, 20, 30). See [the review flow](studio-team-overview-review.md) for live acceptance.

Ticket 20 publication authorized on 2026-10-15. The approved existing minor changeset is included; focused automated validation is recorded above. Live acceptance and migration deployment remain open.

## Ticket 04 assessment checkpoint — 2026-10-15

Three Luna Extra High reviews reconciled the original acceptance ledger against `233b5a18`. The local registered-Project catalogue and accepted Codex folder context are implemented. The old blanket catalogue/instruction follow-up is superseded by the [provider-specific assessment](studio-project-chat-assessment.md). Ordinary Claude chats disable native Project instructions; the pinned SDK couples that loading to Project settings, so the User chose instruction-only loading with permission isolation, and the [instruction-only design](studio-claude-project-instructions.md) is recorded, and the gated implementation checkpoint below supersedes the design-only status. Hosted empty-Project discovery requires a device-scoped registry publication and remains within the earlier hosted deferral. No deferred Move or provider test is marked passed.

Focused current-source validation passed 194 API/runner tests, 30 Studio launch/selection/handoff/component tests and 42 hosted-client/sidebar/preference tests. These are not fresh live provider or two-device acceptance. The open ticket count remains 12; Ticket 04 remains open for its confirmed gap, instruction-only implementation and retained acceptance rows.

Ticket 04 authority decision, 2026-10-15: preserve Koed permission isolation and design instruction-only loading before enablement. The design is now recorded; it bounds the first reader to the registered Project root, keeps instruction text outside public User prompts, and requires session-recovery and selected-skill validation. The implementation checkpoint below supersedes this design-only status. Omit an additional changeset for the assessment; include the behavior fix in the existing minor changeset, as approved by the User.

## Ticket 04 implementation checkpoint — 2026-10-15

The root-only Claude instruction reader, private immutable snapshots, signed snapshot-expectation marker and same-home recovery are implemented. New opted-in turns keep filesystem settings disabled and fail selected-skill requests before submission; existing sessions are not retrofitted. Status uses native progress, with readable local/hosted failure messages. The default-off contributor flag remains off in the running app. See [the implementation and live validation gate](studio-claude-project-instructions.md).

A supported signed-in Claude executable was unavailable, so the disposable live script returned `BLOCKED` without querying a provider. Source guards reject marked fork/handoff sessions before sealing or publishing transfer material. Owner-scoped authority guards also reject these operations before command insertion or state changes; three disposable-PostgreSQL regressions passed, covering unchanged source state, legacy behavior and owner isolation. Fork/device transfer is unavailable for instruction-enabled sessions. No live provider, hosted, Move or transfer row is marked passed. The existing minor changeset includes the gated implementation as approved; no separate assessment changeset was added. The open count remains 12.

Final Ticket 04 focused checks: 327 tests passed, including three authority regressions in a new disposable PostgreSQL database (removed after the run). MCP Server, DB and worker builds, Studio typecheck, changed-file formatting, new-code/UI lint and release consistency passed. Worker-service lint retains baseline findings; broader DB test-file lint has findings on unchanged lines. The live Claude smoke script remains blocked on an unavailable supported signed-in executable, so the rollout flag stays off.

## Ticket 27 implementation checkpoint — 2026-10-15

Three Luna Extra High subagents assessed native/hosted Collaboration surfaces,
backend authority and Memory boundaries. The User approved reusing the channel
request workflow for private/group chats, restricted to Agents owned by current
participants, with owner-private review/start and explicit result sharing.
See the [assessment and implementation record](studio-collaboration-chat-assessment.md).

Implemented the shared participant filter, actual colleague-Agent selection,
private/group request panels, native acceptance/owner-targeted dispatch,
current-room authorization and owner-only Home/For you projections. Navigation
scope guards preserve drafts and prevent late sends or handoffs after A→B or
A→B→A navigation. Existing owner-consented Public Square status remains coarse;
private origin metadata and outcomes are not automatically published there.

Migration 0084 sends content-free status invalidations for the exact bound
native command/execution, including batched pending-item transitions and
reconciliation after expiry. It retains consent versions, avoids ordinary
stream/healthy-heartbeat refresh traffic and preserves owner-departure freezing.

Focused validation passes: 96 API tests, 42 Studio helper tests, 15 component
tests, 35 database/migration metadata tests, 18 Team/browser responsive scenarios
and all 15 migration acceptance scenarios through 0084. Database build, API and
Studio typechecks and scoped lint pass. Hosted and native Studio production builds pass.
No live database, provider session or running app configuration was changed.
The existing minor changeset includes the behavior changes; the assessment has
no separate changeset, as approved. Native/hosted multi-account and live
Codex/Claude acceptance remain open, so the count stays 12: three feature tickets,
one gated implementation and eight testing/release tickets.

## Ticket 29 scheduling and recovery checkpoint, 2026-10-15

The User approved latest-only missed-run recovery, owner-managed private tasks and explicit Team sharing. The [recurring-task design](studio-recurring-agent-tasks.md) records fixed-anchor intervals, daily/weekly time zones, daylight-saving behavior, explicit activation, non-overlap, stable native submission identity and review after uncertain effects. Implemented with Luna Extra High subagents through the existing native Personal chat submission path, without another Job executor or Memory path. The existing minor changeset includes this feature with User approval. This checkpoint does not activate a schedule or certify deployment or live provider acceptance.

Validation for Ticket 29: shared scheduling/contract tests 16; new API route tests 11; existing managed/Personal conversation and upstream routing regression tests 128; worker runner/authority/coordinator tests 23; disposable PostgreSQL recurrence tests 5; existing Agent identity/history tests 21; Studio client tests 7; Studio gateway tests 28; synthetic browser tests 2. Typechecks/build checks pass for shared, DB, API, worker and Studio; Studio production build and DB migration check pass. Release metadata is synchronized. The disposable PostgreSQL cluster was removed; no configured Personal database migration or live schedule was performed. Focused checks do not certify live provider execution, hosted two-device recovery, packaging or other supported platforms.

Scoped lint passes for the new recurring-task code. The existing Agent repository's legacy role-template mapping still has 25 typed-lint errors; the same 25 errors were reproduced from the unchanged branch HEAD in a temporary source copy, which was then removed. This is not a passing whole-repository lint gate.

Push validation also exposed a hosted Collaboration draft race: typing was enabled before draft hydration, allowing the stored draft to replace newly entered text. The composer now uses the same verified draft readiness for visibility, editability, send and change callbacks; callbacks from an earlier conversation cannot overwrite text or mention selections in the current one. Home browser tests warm their cold route and install the fake clock after the initial snapshot. The recurring-chat fixture handles the exact empty Project-move read while retaining unexpected-read assertions. Live provider and Team acceptance remain separate from these synthetic regressions.

## Ticket 04 live instruction validation and enablement — 2026-10-15

The supplied existing executable passed version/authentication checks: Claude Code 2.1.295, authenticated first-party Claude sign-in. The disposable provider script passed with SDK 0.3.226 and `claude-haiku-4-5-20251001`, verifying initial Project instructions, continuation, separate-process native history and frozen instructions after file edits, real tool denial, settings/hook isolation, unverified-Skill refusal and standalone exclusion. The harness confines discovery cache writes to its temporary root and records SDK/CLI versions. See the [live checkpoint](studio-claude-project-instructions.md#live-executable-validation--2026-10-15).

Fresh-session instruction snapshots are enabled by default; `KOED_CLAUDE_PROJECT_INSTRUCTIONS=0` remains an explicit rollback. Existing unmarked sessions retain legacy behavior, and marked sessions still require their immutable snapshots even after rollback. Separate provider sessions retain independent snapshots. The User's approved existing minor changeset covers this behavior.

The live smoke used an explicit executable path, not the running app's registry. Koed's current local registry has no Claude entry; Preferences → Agents → Claude setup/repair is the supported route to register the installation and configure its Koed integration before full Studio UI acceptance. No running app configuration, capture hooks, credentials or configured Personal database were changed. The tested CLI version is 2.1.295; this is not certification of every version above Koed's minimum. Ticket 22's exact Skill executable-version boundary is unchanged. Hosted/two-device, Claude Move and fork/device-transfer limits remain. Ticket 04 is implemented with remaining acceptance, so the distinct count stays 12: one deferred feature ticket and eleven acceptance/release tickets.

## Ticket 04 registered Claude and local UI checkpoint — 2026-10-15

The User-authorized setup/repair flow registered the supplied Claude executable in the real existing V2 installation. Setup, its independent read-only check and the current local capability snapshot were healthy/authenticated/ready. Unrelated AI Client registrations, MCP entries and non-hook Claude settings were preserved. No Personal database migration or existing-runtime restart ran.

Live current-branch loopback Studio UI acceptance passed with real Claude replies using a separate native PostgreSQL cluster and private runtime: Home-to-Project handoff without selecting an Agent, instruction status, sidebar Project grouping, reload/continuation, immutable instructions after a file edit, supported isolated-backend restart and sidebar reopen, UI Write approval/Decline despite permissive Project settings, hook suppression, standalone exclusion/grouping and updated instructions in a fresh Conversation. See the [acceptance matrix](studio-claude-project-instructions.md#registered-installation-and-live-local-ui-acceptance--2026-10-15) for execution IDs, runtime versions and limits. The current Studio production build and supported source-runtime preparation passed.

This supersedes the missing-registration and local-browser acceptance blockers in the preceding checkpoint. It does not certify new Electron/provider acceptance, hosted/two-device, selected-Skill, other executable versions, Claude Move or instruction snapshot transfer. Preserve the original open edge-case rows and explicit deferrals. Ticket 04 remains open for retained acceptance/deferrals; there are still 12 distinct open tickets, with one deferred feature and eleven acceptance/release tickets.

## Ticket 13 recovery and Claude follow-up — 2026-10-16

The validated Codex Docker checkpoint was pushed as `56155e4b`. Follow-up implementation keeps missing-history and uncertain-outcome guards intact: eligible stopped, unaccepted reviews can open a new blank planning chat, without replaying the old prompt. The existing start transaction rechecks current owner, request/review versions and binding authority. Paired-runner output recovery now uses bounded execution-generation/provider-turn reads of existing encrypted runtime items. Owner-review polling preserves controls and unsaved edits.

The new Home/sidebar reopen check exposed lost Team context and a rejected Personal message send (403). Reopen routing must recover the owner-only Team binding before choosing the conversation path. A separate Claude 2.1.299 profile is configured and signed in for the disposable runtime. Codex restart also exposed repeated `thread_open` timeouts; history restoration does not certify successful provider continuation. Keep live Claude, reopen/restart, additional Devices and deployed Team acceptance open until their own results are recorded. The distinct open-ticket count remains **12**; no ticket is closed by this checkpoint.

Claude live follow-up: the new private planning turn completed with only read/search/question tools, and its history restored after reload. Explicit acceptance created one native command, but the provider returned `ManagedConversationAuthenticationError`; the command is indeterminate and the output file is absent. Keep the uncertainty guard, do not replay the accepted command, and leave Claude accepted-work/recovery acceptance open. CLI sign-in status alone does not resolve this failure.

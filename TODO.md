# Current UI integration direction — 2026-10-14

See [the revised ticket plan](docs/studio-ui-integration-plan.md). Tickets 24–28 replace the historical soul, role-template, Agent Job protocol and parallel-recall direction below. Ticket 29 implements owner-managed recurring tasks for Codex and Claude using OpenDots concepts; see [scheduling and recovery rules](docs/studio-recurring-agent-tasks.md) and the implementation checkpoint. Its live and deployment acceptance remains open. Ticket 30 tracks retained-UI and release acceptance. Historical completed entries below are evidence, not approval to preserve superseded behavior.

## Current open tickets

The [separate Personal and Collaboration tables](docs/studio-ui-integration-plan.md) replace the earlier five-ticket count.
There are 12 distinct open tickets, including retained feature scope, newly identified recovery/adapter work, and testing/release acceptance. Ticket 04's instruction-only implementation is enabled after live adapter validation; live local loopback UI acceptance passes; retained acceptance and deferrals remain open.

| Area          | Open ticket IDs    | Count |
| ------------- | ------------------ | ----- |
| Personal      | 04, 16, 19         | 3     |
| Collaboration | 12, 13, 15, 20, 27 | 5     |
| Shared        | 03, 22, 29, 30     | 4     |

Ticket 16 now stores native review completion and shared bounded discovery. Ticket 19 reads native Agent activity with shared reminder state and retained legacy history; live acceptance remains open. Ticket 20 now reads native Team Agent activity and retains legacy history, with independent Team reminders and refreshed pagination; live acceptance remains open. Tickets 12 and 13 now use native Public Square publication and channel execution; focused automated checks pass, while live native/hosted and deployed Team acceptance remain open.
Ticket 04 assessment is complete: local catalogue and accepted Codex context are wired. Claude root-instruction loading is enabled for fresh sessions after live adapter validation; live local loopback UI acceptance passes; Skill support follows Ticket 22’s verified isolated adapter; fork/device transfer remain unavailable; the hosted catalogue and live-review deferrals remain open. See [the assessment](docs/studio-project-chat-assessment.md). Existing human messaging remains implemented.
Ticket 27 Collaboration assessment is recorded in [the surface and authority map](docs/studio-collaboration-chat-assessment.md). Implemented participant-owned Agent requests in private/group chats with owner-private native execution, explicit result sharing, exact-origin permission checks and guarded local/hosted navigation. Native request status refresh is corrected without private content or extra Job/Memory machinery. Focused checks pass; live provider, cross-account and deployment acceptance remain open under 27.
Ticket 22 reuses one scoped Skill picker across Studio and retained Electron AI chats, with truthful native availability, owner-private launch, fresh send-time validation and discovery access checks. The [implementation checkpoint](docs/studio-plugins-skills-assessment.md#implementation-checkpoint) records provider limits and validation. Installation and sign-in remain in the original AI Client. Live Codex/Claude invocation, hosted/device and reconnect acceptance remain open; the distinct open-ticket count stays 12.
Keep original acceptance records and explicit deferrals. Do not count superseded tickets or repeated tests twice.

Ticket 13 live follow-ups found on 2026-10-15:

- Validate explicit new blank planning chats for eligible stopped, unaccepted Team reviews. Keep the missing-history guard and never replay the old prompt: current records do not prove nonacceptance. Accepted and uncertain outcomes retain their existing protections; assess broader recovery with Ticket 04.
- Validate the bounded paired-runner runtime-item output read with live Claude. Generation/turn-scoped listing now reuses the existing encrypted items; automated wiring alone does not certify provider execution.
- Audit the remaining remote adapter gaps for file-operation continuation and Project Move within their existing retained scope. Do not count a passing Codex channel test as evidence for those paths.
- Validate the owner-review refresh correction under Ticket 30: controls and dirty edits stay mounted during same-request polling; authority loss still removes private actions.
- Validate restored Team request context when reopening a bound execution from Home/sidebar. The previous route displayed history but sent through the Personal message endpoint, which correctly returned 403.
- Investigate the isolated Codex worker restart's repeated `thread_open` timeouts (`ManagedConversationThreadOpenError`, about 10 seconds). History display is not evidence that the provider resumed successfully.
- Resolve the live Claude accepted-turn authentication failure after successful read-only planning. The accepted command is indeterminate; keep its uncertainty guard and do not replay it merely because the output file is absent or CLI auth status says signed in.
- Preserve the human-derived chat title after reload under 04/30. The accepted test conversation reloaded with an internal managed-context label instead of its initial human-message title.

The historical backlog below contains superseded descriptions. Use the current plan for implementation scope and status.

# Implementation backlog

## Studio Personal Agents

Plan: [persistent identities, conversation participation and runtime context](docs/studio-personal-agents-plan.md).

- Completed: map original Agents UI and existing backend contracts before implementation.
- Completed: persist owner-scoped identities, encrypted soul versions, model defaults and retirement.
- Completed: reuse the original Agents design; add default model/effort and editable instructions.
- Completed: role-template catalogue with Git-managed source, immutable database publication, Role autosuggest and explicit editable-copy selection. Activated locally on September 23; existing agents are not updated automatically.
- Completed for Personal standalone New Chat: durable conversation participants, `@Agent` mentions, active respondent, actual model/effort defaults and attributable outputs.
- Implemented: [multiple Agents in one Personal conversation](docs/studio-multi-agent-conversations.md), using the same or different AI Clients, sequential durable deliveries, separate native sessions, per-participant settings and bounded incremental public context. Automated checks cover restart/reopen, uncertain-delivery blocking, shared checkout identity and one Project/sidebar conversation. Manual follow-up: exercise live Codex and Claude Code replies in the updated desktop app.
- Assessed under Ticket 04: local New Chat uses registered Projects independently of captured history, and accepted local Codex tests verify Project instructions. Ordinary Claude instruction loading is disabled by SDK settings isolation; the instruction-only reader and same-home recovery are enabled for fresh sessions after live validation on Claude Code 2.1.295 and SDK 0.3.226; local loopback UI starts, reload/reopen, restart recovery and permission denial pass; retained acceptance and deferrals remain open. Hosted empty registered Projects need a device-scoped catalogue contract within the existing deferral. See [the assessment](docs/studio-project-chat-assessment.md).
- Remaining: make the shared `@Agent` contract work in every chat mechanism. PR Chat needs a PR-specific, owner-authenticated Agent turn adapter that resolves immutable identity/version and authorized Personal Memory, binds verified repository/PR/base/head context, preserves its isolated read-only runner, and records author/model attribution. Do not route it through normal managed execution until that path can preserve read-only mode. Collaborative channels, rooms and direct/group chats need explicit User-versus-Team identity, audience and memory authorization before invocation is enabled.
- Completion gate: use the chat-surface matrix in `docs/studio-personal-agents-plan.md`; no chat mechanism is complete from mention suggestions alone.
- Completed: managed runtime assembles immutable identity and authorized Personal Memory; the context builder accepts a verified Project scope. Live Studio passes selected Project scope. Each other chat adapter must supply its own verified context.
- Validate restart/reconnect, access isolation and retained history before surfacing verified outputs on Home.
- Completed: encrypted output references and freshness-aware runtime counts; project counts derive from recorded jobs. Add richer project engagement metadata separately.
- Completed: expose actual model/effort and runtime instance for each recorded retry attempt.
- Extend retained job history beyond the first bounded page.

## Studio Pull Requests and Orys integration

Current source study: [Orys refresh, review, recovery and reuse](docs/studio-orys-implementation-study.md). Ticket 16 includes lightweight five-minute inbox discovery and native review completion. Refresh must not automatically clone repositories or start reviews. Ticket 16 native implementation is complete. Live provider and GitHub acceptance remain open.

Planning baseline: [feature map and porting plan](docs/studio-pr-orys-port-plan.md).

- Completed: Orys feature inventory, initial pure review contracts, and local GitHub Plugins identity connection using explicit GitHub CLI sign-in.
- Completed: repository selection and bounded PR list/detail reads, validated through live and demo browser flows.
- Next browsing work: comments, CI, team-request membership and actual review history. Preserve Orys safety contracts throughout the remaining TypeScript port.
- Port PR browsing, review execution, findings and confirmed publication as separate tested slices.
- Completed: read-only PR Chat using the isolated Codex runner, account/repository/commit-scoped conversations, and GitHub plugin reconnect/disconnect/browse flow.
- Add durable PR conversation storage and authorized memory context without changing independent review or publication boundaries. Current preview conversations are in-process only; service restart clears them.
- Include desktop notifications with preferences, privacy, deduplication and validated PR deep links.
- Port pipeline tooling, history/export, recovery, diagnostics and evidence cleanup.
- Keep current UI skin; validate required additions before expanding scope.

## Studio Personal Home integration

Preserve the imported UI. See [the wiring plan](docs/studio-home-wiring-plan.md).

- Superseded: captured-content navigation from Home/Chats. Replace with explicit workflow destinations, never a history-viewer fallback.
- Completed: stable project-ID filtering across captured conversations, executions and requests.
- Completed: scope isolation, canceled stale reads and visible source coverage warnings.
- Reuse connection/capability services; confirm the intended upstream before changing routing.
- Implement the agreed New chat suggestion/draft flow, then port managed conversation launch/runtime/approval contracts.
- Define evidence-backed before/after change preparation, per-user seen checkpoints and relevance ranking for personalised Home invitations.
- Reuse project metadata and define separate Electron/browser directory behaviour.
- Validate each slice in the imported UI before selecting another page.
- Resolve imported prototype lint errors and the Electron CommonJS lint configuration before PR readiness.

## Joining-device-first Personal Device pairing

Implemented on 2026-09-14:

- Joining headless and Electron installations create a short-lived device request.
- The existing Authority-hosting Electron installation reviews and explicitly
  accepts that request, using the existing signed enrollment protocol.
- `pnpm koed-server pair` starts the native Personal runtime with automatic ports
  and credentials. CLI and Electron share supervisor-owned request state.
- Setup no longer requires a recovery JSON export or a recovery code. Advanced
  optional recovery export remains available through the CLI.
- Joined devices publish their own closed sessions without an Authority private
  key. User authentication and secure membership context remain required.
- Request transport is private LAN/Tailscale only. The existing Authority relay
  listener remains in Electron; the joining request listener lives in koed-server.

Validation and current operation are documented in `docs/device-pairing.md`.

Deferred work:

- Internet-accessible relay and restricted-network traversal.
- Approval from joined replicas that do not host the Authority.
- Moving the existing Authority relay listener into the supervisor.

## Personal Device session visibility and automatic publication

Implemented, following ADR-0045:

- Signed cumulative checkpoints preserve V1 permanent closure semantics.
- Durable Pi, Codex, and Claude Code completion evidence triggers publication.
- Ordered, deduplicated checkpoints extend one read-only received Session.
- Pairing and local replication progress are reported separately.

Remaining validation: physical Studio-to-Electron capture, later-turn updates,
and offline catch-up on the updated runtime.

Implemented: received-session badges use verified replica provenance and the
installation-local nickname; device icons no longer guess hardware by row order.

## Studio frontend simplification

Agreed sequence after the frontend QA review: begin with unused UI removal and small shared adapters/cards. Preserve the current design and Desktop/web behavior. Further extraction should land before colleagues begin work in the affected components.

- Completed: share human Team message-row presentation; Desktop/web visibility and read-receipt contracts remain separate.
- Completed: extract repeated Project Move pickers and Team review/message actions; runtime and recovery controllers remain separate.
- Completed: share Team Memory settings presentation through existing Desktop/web data adapters; transport, permissions and stale-result guards remain in each controller.
- Completed: resolve the 67 existing React hook findings in the Desktop/web Team screens, including draft, receipt, reconnect and authority checks.
- Completed: separate Agents detail, Working now and retirement presentation from the library controller.
- Defer larger controller or composer restructuring until upcoming ticket ownership is known.

## Agents library overview

Implemented: shared Desktop/web Cards/List views, lifecycle filtering and
automatic verified current-work summary. See `docs/studio-personal-agents-plan.md`.

- Implemented: bounded owner-scoped bulk activity reads preserve lease/generation verification, explicit unknown states and compact Working now context.
- Implemented: cursor-based older Job history preserves original attribution and already loaded pages, with guarded retry and refresh.
- Implemented: reusable synthetic Studio browser regression tests and a focused GitHub Actions workflow. See `apps/studio/tests/ui/README.md` for commands, coverage and limits.

## Personal Studio QA follow-ups — 2026-10-04

- Complete the live rewritten-transcript continuation check after macOS
  Keychain approval; verify a reply in the same provider thread and retained
  history/drafts. See `docs/studio-personal-qa.md`.
- Resolve ESLint 10 / React plugin compatibility and triage the touched-file
  ESLint 9 findings (262 errors); distinguish existing configuration/test
  issues from new source issues before claiming lint passes.

## Personal Studio folder runtime follow-up — 2026-10-05

- Fixed: explicit folder selection and new runtime checkout selection preserve the exact directory. A folder inheriting Git from an ancestor is a plain-folder Project with explicitly unsupported checkpoints, rather than granting scope over the ancestor repository. Selecting a repository root retains Git checkpoint guarantees. Regression coverage includes an unborn parent repository containing an unrelated embedded repository without a commit.

- Studio synthetic Team QA: update and verify launch-option fixtures and composer expectations for human chat versus Agent activation. The 14 Team/Team-responsive failures are present both on `69252ab9` and in the Personal-fix pre-push run; see `docs/studio-personal-qa.md` for verification limits.

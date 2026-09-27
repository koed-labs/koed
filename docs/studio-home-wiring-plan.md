# Studio Home wiring plan

Status: workflow-first Home with ticket 01 local browsing in the sidebar; conversation and project creation remain planned.
Reviewed on 2026-09-21 against `ff5c7e1b` and the local Studio integration.
The existing main checkout is at the same commit. This pass did not fetch or change branches.

## Rules for this work

- Home is a personalised invitation to work, not a captured-conversation browser.
- Each item explains what changed or needs attention, why it matters, and its next action.
- Route by workflow: chat, collaborative discussion, agent decision, agent review or change briefing.
- Never substitute raw captured-content retrieval for a destination that is not integrated.
- Recent captured sessions alone are not Home suggestions or proof that a chat is resumable.
- Preserve the imported skin, menu names and page layout. Discuss broader UI changes first.
- Work on Personal Home first. Do not import concurrent Collaborative prototype changes.
- Leave the current Electron app and the original prototype unchanged.
- Reuse existing contracts and services before adding new ones.
- Keep API Tokens outside the renderer. Backend authorization remains authoritative.
- Do not describe captured Memory as a complete or resumable Conversation.
- Do not start AI work, approve a request, or change backend routing through an incidental Home read.

## Ticket 01: local discovery and Desktop loading (2026-09-25)

The Desktop menu opens Studio in a separate sandboxed window on an ephemeral
loopback origin. Desktop main supplies its existing local API access to the
Studio gateway, and the API Token stays outside the renderer. The existing
Desktop window and its managed Conversation services remain available.
Packaged Desktop builds stage Studio's static export and gateway modules.

`listLocalConversationSources` discovers bounded, recent-first source summaries
from the local Codex, Claude Code and Pi transcript roots. It reads only limited
header and early title records, groups a Project when source metadata supplies
its directory, and exposes no source path. The default page has 50 items, with
cursor-based Load more and no age cutoff. Discovery does not ingest records or
create a Koed Conversation. Scan limits and partial provider coverage are shown
in the UI. File modification time is the activity proxy until a provider supplies
a more exact indexed value.

Ticket 02 reuses this catalog in the same-computer browser through the local
Studio gateway. Registered Projects and discovered sources share Project identity
only when their local directory paths match; names alone never merge Projects.
The sidebar nests Conversations inside each Project, shows five at first and
reveals more within that Project on request. The separate Conversations section
holds projectless sources. The AI Client filter sits with Projects. The browser
cannot use Electron's native folder picker, so New project is disabled there;
Koed's local Project metadata remains the registry for both views.

For Codex titles, discovery optionally reads the local Codex `state_5.sqlite`
thread index using a read-only SQLite connection. The displayed name takes
precedence over its title; transcript metadata and the existing bounded title
fallback remain available when the index or runtime cannot be read. This index
is a private Codex format, so failure to read it does not block discovery. The
lookup does not change Codex thread records or ingest conversation content.

The Studio gateway exposes fixed local catalog and exact captured-source
resolution routes. A discovered source that matches a running Koed-managed
execution uses the existing managed continuation flow. A captured or external
source without a matching writable execution shows an inline unavailable
reason; Studio does not inspect captured Memory events in a side drawer or
invent a transcript or send action. Taking over an external source versus
creating a linked copy is deferred until after the full UI port. Hosted web access to a
user's local source catalog on another device requires a separate client bridge
and user session design. The same-computer browser uses the gateway on loopback.

The historical audit and proposed sequence below predate this ticket. In
particular, their statements that sidebar Chats have no navigation or that
captured-content drawers are a Studio destination no longer describe ticket 01.
Home remains workflow-first and does not promote recent captured sessions into
recommendations.

## Agreed New chat and project behaviour

These are user-approved requirements for the next workflow slices, not features
implemented by the read-only Home gateway.

- Keep the imported New chat screen and its Suggested by Koed chips.
- Suggestions use Personal Memory for a standalone chat and project-relevant
  memory within a project. Include Team Memory only where authorized.
- Clicking a suggestion fills the composer; it never sends automatically.
  Ask before replacing an existing draft, and preserve the draft on cancel.
- Keep the Local / Collaborative choice in Create project.
- After creating a Local project, open its first empty chat.
- Defer the post-creation Collaborative flow until it is discussed with the user.
- New conversations inside a shared project inherit sharing with its selected
  teams. Preserve the sharing indicator and Move, Share, Edit and Archive controls.
- Implement sharing through explicit backend grants, not folder upload or an
  assumption that team membership grants access to all source content.
- Before implementing collaborative changes, settle the access behaviour when an
  existing conversation moves into/out of a shared project, and the meaning of
  per-conversation overrides. Do not make those choices silently.

## Initial Home audit

Current correction completed: removed Home/sidebar captured-content navigation
and recent captured sessions from the suggestion feed. Added typed workflow
destinations, factual execution/request status cards, disabled unavailable actions
and an empty state without fabricated suggestions. The imported layout remains.
The change-briefing type is a placeholder for a future producer, not an evidence
verification service or a working recommendation pipeline.

Current validation: 16 focused tests, typecheck, targeted lint and production
build pass. Headless browser checks confirm no captured-content request or drawer
is triggered, raw recent history is not promoted to a Home card, and unsupported
workflow actions are disabled. The existing full-app lint limitations remain.

The matrix below is historical: it records the initial read-only approach, which
the user subsequently rejected as a product direction. The workflow-first rules
above supersede the drawer and recent-history behaviour below. New chat and
project creation remain disabled until their actual workflows are connected.

| Existing element                                                          | Works now                                                                                                                           | Gap and next action                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suggested by Koed                                                         | Cards come from pending requests, failed/running executions and recent captured conversations. Original card components are reused. | This is a fixed ordering, not a context-aware recommendation engine. Do not imply personalised AI recommendations. Agree richer suggestions separately.                                                                         |
| Featured card, grid and More from Koed                                    | Open a read-only captured-content drawer when a session is available.                                                               | Carry explicit destination types. A managed execution needs runtime context; a captured session needs a read-only viewer; a resumable Conversation needs a verified provider/runtime route.                                     |
| Needs-you / failure cards                                                 | Read bounded managed execution and runtime request data.                                                                            | Some cards have no session and silently do nothing when clicked. Disable unavailable actions with a reason; do not promise a Desktop handoff without a working handoff. Add approval submission only in the conversation slice. |
| Running activity                                                          | Reads managed execution state on load and refresh.                                                                                  | Not live streaming. Show freshness honestly and reuse runtime updates later. Do not equate a running process with task progress or completion.                                                                                  |
| New chat                                                                  | Original label retained, action disabled.                                                                                           | Reuse provider discovery, launch options, project context and managed execution creation. User describes composer behaviour before integration.                                                                                 |
| New project                                                               | Original label retained, action disabled.                                                                                           | Reuse local project metadata and directory selection in Electron. Browser cannot select an arbitrary host directory; define the browser project contract separately.                                                            |
| Projects                                                                  | Names come from recent captured sessions; selection filters recent cards.                                                           | Filter by stable project identity, not display name. Include managed execution projects and apply selection consistently to all applicable cards. Do not treat this sample as the complete project registry.                    |
| Chats                                                                     | Up to eight real titles are shown.                                                                                                  | Rows are not wired. Connect them to the correct viewer/conversation destination without changing their design.                                                                                                                  |
| Refresh and retry                                                         | Fetch a new bounded snapshot.                                                                                                       | Handle multiple coverage warnings, account/backend changes and stale data consistently. Preserve empty, offline, unauthorized and partially available states.                                                                   |
| Sidebar collapse and Projects/Chats toggles                               | Local expand/collapse works.                                                                                                        | Keep existing behaviour; no redesign needed.                                                                                                                                                                                    |
| Settings, Pull Requests, Plugins, Agents, Memory Inbox and project search | Labels retained; destinations not integrated.                                                                                       | Keep clearly unavailable until each page is selected for work. Do not mount mock providers to make them appear functional.                                                                                                      |

Sources: [PersonalHome](../apps/studio/src/components/studio/PersonalHome.tsx),
[StudioSidebar](../apps/studio/src/components/studio/StudioSidebar.tsx),
[HomeDetailDrawer](../apps/studio/src/components/studio/HomeDetailDrawer.tsx),
[original Home](../apps/studio/src/components/KoedHome.tsx),
[original feed](../apps/studio/src/lib/home.ts),
[gateway](../apps/studio/server/index.mjs).

## Earlier read-only fixes (superseded where noted)

Opening captured content from Home and sidebar Chats has been withdrawn.
The fixes below record earlier work, not acceptance of a history-browser workflow.

- Sidebar Chats open the captured-content drawer.
- Project selection uses stable IDs and filters captured conversations, executions
  and their pending requests consistently. Execution-only projects are included.
- Duplicate project names remain separate. The project ID is available on hover.
- Cards without a session are disabled with an explanation rather than a no-op action.
- Home cancels superseded reads and clears old content on authorization/scope failures.
- Scope keys distinguish the backend and user without exposing the API Token.
- The warning area displays all returned coverage warnings.
- Only pending approval/input runtime items become needs-you cards; transient output does not.
- Aggregate request limits use deterministic ordering and explicitly mark incomplete coverage.
- Recent captured conversations are sorted newest-first across project groups.
- Detail lookup resolves the owner-scoped session and exact external thread IDs,
  instead of searching only the first recent-thread page.
- The drawer guards against stale asynchronous results and describes its content
  as Captured Memory, not a complete live transcript.

Validation: 13 focused Node tests and the Studio production build passed.
Headless browser checks covered duplicate-name filtering, execution-only projects,
disabled cards, Chats navigation and authorization clearing. A real captured
conversation was also opened successfully. No sharing, credentials or active
backend routing was changed.

Touched Home files pass targeted lint. Full Studio lint still reports errors in
the imported prototype screens/providers and the Electron CommonJS entry point's
lint configuration. Those broader integration issues remain open.

## Current connection finding

The local registry has an active upstream with managed execution routing enabled.
Its capability cache is marked validated but expired on 2026-09-11.
The API rejects managed-conversation requests when the cache is expired, invalid,
or does not advertise the required capability. This explains the observed 503
and does not establish that there are no running agents.

Recovery should use the existing upstream capability refresh operation, then
check advertised managed-execution support and enrollment. Refresh success alone
does not prove that the remote service or the user's authorization is ready.
If the upstream is no longer intended, agree the target before changing routing.
Do not silently fall back to a different backend or disable these checks.
This audit did not refresh, enroll, switch targets or modify credentials.

Sources: `remoteAuthority()` in
[managed-conversation routes](../apps/api/src/managed-conversations/routes.ts),
`refreshUpstreamBackendCapabilities()` in
[upstream registry](../packages/koed-server/src/upstream-registry.ts),
and `upstream refresh` in [CLI](../packages/koed-server/src/cli.ts).

## Boundaries and missing capabilities

### Personalised changes

Example intent: "Project X changed its authentication approach" with an explanation
of how that affects the user's current work and a link to the relevant review or
discussion. Do not reduce this to "a new document was uploaded" or a list of sessions.

This needs a separate preparation path, not an inference made while rendering Home:

1. Observe versioned, authorized project sources and their provenance.
2. Compare the previous and current evidence; a changed summary alone does not
   prove that an ADR or accepted decision changed.
3. Produce a bounded change record with before/after source references, time,
   project/workspace identity and an appropriate action destination.
4. Track a per-user/project seen checkpoint; application connection time and
   project discovery timestamps are not proof that the user read a change.
5. Rank permitted changes against the user's relevant work and preferences.
6. Recheck access before delivery and on click. Invalidate stale or revoked cards.

Share preprocessing only within an appropriate authorization boundary; evidence
from a private source must not leak through a supposedly shared change summary.
Personal ranking and delivery remain user-specific. Decide processing budgets,
deduplication, refresh triggers and seen/dismissed semantics before implementation.

These capabilities are not supplied by the current Studio Home read endpoints.
The current change only introduces explicit destination semantics and removes
the incorrect retrieval fallback. It does not implement personalized ADR analysis,
unread collaboration or a recommendation engine. Any AI synthesis design must
respect the current self-hosted AI-client synthesis boundary; no backend LLM
service is introduced by this frontend work.

The preview gateway is local and read-only. It is not authenticated hosted web
infrastructure. Before exposing it to other users, add browser authentication,
user isolation and a suitable session policy. A local bridge is needed for a web
client to use software or repositories on the user's own machine.

The legacy detail reader reads graph events, not the canonical conversation
timeline, and is no longer a Home destination. Projection can omit source content.
Do not reuse it as live chat, approval context or a memory-retrieval UI without
a separately agreed workflow.

Home reads at most 50 executions and 50 recent threads. Runtime request scans and
content reads have additional bounds. More from Koed expands the loaded sample,
not the entire backend inventory. Preserve coverage warnings until pagination or
an owner-scoped aggregate endpoint can justify complete coverage.

There is no integrated unread marker, since-last-visit briefing, generated
recommendation engine or automatic approval action. The unused catch-up drawer
branch is not a shipped catch-up feature. Keep these out of completion claims.

## Proposed implementation sequence

### Reuse from the current app

| Area                                                               | Existing source                                                                                                                                     | Reuse boundary                                                                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI Client models, reasoning and permission modes                   | [AI Client contract](../packages/shared/src/ai-client-contract.ts)                                                                                  | Reuse shared types and capability semantics. Do not invent a parallel provider catalog.                                                                             |
| Start, inspect/resume, send, runtime and approval requests         | [Managed Conversation protocol](../apps/desktop/src/ipc/managed-conversation-protocol.ts)                                                           | Reuse validation and operation semantics through a small transport-neutral client. Do not put Electron IPC in browser code.                                         |
| Runtime state and event ordering                                   | [Runtime reducer](../apps/desktop/src/renderer/state/managed-conversation-runtime.ts)                                                               | Extract pure reduction logic with its tests. Preserve execution generations, item revisions and snapshot recovery. Do not import the Desktop renderer wholesale.    |
| Authenticated API mapping and recovery                             | [Desktop manager](../apps/desktop/src/koed-server/manager.ts)                                                                                       | Use as the reference for bounded requests, errors, idempotency and owner-scoped recovery. Keep credentials, CLI startup and filesystem access in a trusted process. |
| Live managed updates                                               | [Collaboration contract](../packages/shared/src/collaboration-contract.ts), [local transport](../apps/desktop/src/collaboration/local-transport.ts) | Existing managed-conversation events are reusable, but Studio has no browser transport for them yet.                                                                |
| Project directory selection, provider setup and credential storage | Desktop main-process services                                                                                                                       | Keep Electron-specific actions separate. A browser must use a defined bridge or server-side contract, not direct filesystem or secret access.                       |

A narrow `ManagedConversationClient` should express operations without depending
on React or Electron. Studio can then implement the transport through its trusted
gateway. Reuse the API's launch-options, execution creation, prompts, runtime,
request-response, interrupt and stop operations rather than adding new backend
conversation semantics.

Before enabling gateway writes, add appropriate local session authorization and
request protections, strict input validation and idempotency. The current
single-operator read-only preview is not the security contract for agent execution.
For a hosted web client, design authenticated user sessions and CSRF protection;
do not relay one operator's API Token for every browser user.

Start with bounded runtime polling if necessary, clearly labelled as refreshed
state rather than streaming. A later event bridge must recover from disconnects
and missed events by reading a durable snapshot. Approval responses must include
the expected execution generation and obey runtime item presentation rules.

The imported `WorkspaceProvider` and `workspace.ts` contain synthetic state and
fake replies. Keep their UI components as design references, not as the source of
truth for real execution. Replace their data path one workflow at a time.

### Delivery order

1. Replace the retrieval fallback with typed workflow destinations and explicit
   unavailable actions. Preserve project filtering and honest coverage/freshness.
2. Reuse connection and capability services behind a small Studio adapter. Resolve
   the intended existing upstream configuration without changing the skin.
3. Agree New chat and existing-conversation behaviour with the user. Port launch,
   runtime events, send/cancel and approvals as one coherent vertical slice.
4. Wire New project using the existing metadata model. Define browser limitations
   explicitly instead of exposing server filesystem access.
5. Select the next Personal page with the user; repeat the same audit and test process.

## Acceptance checks

- Compare Home with the imported design: no renamed menus or replacement layout.
- Exercise empty, offline, unauthorized, partial and capped responses without fake records.
- Verify project filters with duplicate display names and execution-only projects.
- Verify Chats/cards never open captured-memory content as a workflow fallback.
- Verify the destination types for live chats, collaborative discussions, agent decisions,
  agent reviews and change briefings; disable targets that are not yet implemented.
- Ensure cards with no destination cannot silently accept a click.
- Clear old content on identity or backend changes; cancel stale requests.
- Verify no token reaches browser responses, storage, URLs or bundled JavaScript.
- Test connection failure and capability expiry without bypassing backend policy.
- Before enabling writes, test duplicate submissions, denied/revoked access,
  request expiry, reconnects and cancellation against existing contracts.

New chat, project creation, live execution and sharing remain outside the completed
read-only slice. The requirements above are not claims that those features are implemented.

# Studio Personal Agents implementation plan

## Purpose and scope

Build persistent, personally owned agents into the existing Studio design.
An agent is a reusable identity, not an AI provider, model, process, or single
execution session. Preserve the original design in the separate prototype;
implement only in the Studio integration branch. Do not change the main Desktop
app, redesign navigation, or introduce another agent harness in this slice.

## Agreed behaviour

- Keep the existing avatar customisation, agent library, creation/edit dialogs,
  and detail-panel design. Add only the agreed controls and real data wiring.
- Persist name, role, avatar, editable soul instructions, preferred model and
  reasoning effort. Generate initial instructions, but never overwrite custom
  instructions automatically when name or role changes.
- Mentioning an agent adds it to the conversation and makes it the active
  respondent. It remains active until explicitly switched. Show its name and
  avatar in the conversation and attribute each response to its actual author.
- Make `@Agent_Name` a shared capability of every chat mechanism in Koed, not
  only Personal New Chat. This includes standalone and project chats, PR chats,
  and every chat surface introduced by the Collaborative side. New chat
  mechanisms inherit this contract before they are considered complete.
- Resolve a mention to the selected Agent's stable identity. On Send, that
  Agent must answer the addressed message using its versioned identity,
  authorized memory and the verified context of the containing chat. A mention
  is routing intent, not merely highlighted text or a name added to a generic
  reply.
- Apply one consistent participant and active-respondent model across chat
  surfaces. The selected Agent remains active for follow-up messages until the
  User explicitly switches or clears it. Show its name/avatar and attribute
  every response and retained output to its actual author.
- Preserve each chat's execution permissions and audience boundary. The
  containing chat determines which Agent identities, memory, messages and
  project context are available. A shared chat must not expose a User's private
  Agent identity or Personal Memory to other participants without an explicit
  authorization and sharing contract. Do not silently substitute a Team Agent
  for a Personal Agent or vice versa.
- An adapter that cannot yet execute an Agent must not show active-looking
  mention behavior or silently fall back to a generic respondent. Until its
  adapter is connected, clearly report that Agent execution is unavailable;
  full product completion still requires the adapter for that chat mechanism.
- Offer the user's available agents when typing `@`. Resolve selected mentions
  by stable ID, not display name alone; ask for selection when names are
  ambiguous. Unknown or retired agents must not silently fall back to another
  respondent. Quoted mentions and agent output must not trigger new executions.
- Support multiple participant records from the outset. Adding another agent
  does not remove the first. Initially only the explicitly addressed or active
  agent responds; automatic delegation and agent-to-agent loops are out of scope.
- Collaborative chat surfaces have not yet been implemented. Their eventual
  design may include workspace/project rooms, channels, direct or group
  conversations and Agent workrooms. Each is in scope for `@Agent`, subject to
  explicit identity ownership, audience, memory authorization and execution
  rules; this plan does not claim that those surfaces or Team Agents exist yet.
- The composer can override the identity's model and effort for a conversation.
  Models, effort and execution permissions must match runtime capabilities.
- Invoking or explicitly switching to an agent resets the chat's selected model
  and reasoning effort to that agent's preferred defaults. For example, if New
  Chat currently shows GPT-6 Luna / High and Bob prefers GPT-6 Astra / Medium,
  resolving `@Bob` makes Bob active and updates the composer to GPT-6 Astra /
  Medium before sending. These names are illustrative, not guaranteed runtime
  capabilities. The visible settings and submitted execution settings must agree.
- A manual model/effort override made after selecting Bob applies to subsequent
  messages with Bob without changing his saved defaults. Ordinary follow-up
  messages preserve that override; explicitly invoking an agent again reapplies
  that agent's defaults. Switching does not alter an already-running turn.
- If the preferred model or effort is unavailable or disallowed by the chat's
  execution adapter, do not silently substitute an engine or display a setting
  the runtime will ignore. Show the incompatibility and require an explicit
  supported choice before sending. Agent selection never expands permissions.
- Retirement prevents new use of an agent without deleting its prior outputs,
  authorship, execution history or retained memory. Retention remains subject to
  the product's applicable data-deletion and authorization policies.
- Home can surface verified outputs and actionable blockers. Collaborative
  For You is a future consumer, not part of this implementation slice.

## Agent detail: history and live activity

Preserve the existing Projects, Running Now and Jobs logged counters and the
Active in, Highlights and Job history sections. They require durable operational
records alongside near-real-time execution updates. Do not derive historical
work exclusively from current project assignments or browser state.

### Library views and current work

Desktop and web use the same `AgentsView`. The library defaults to Active
(non-retired) Agents, with Retired and All filters. Cards and List offer the same
profile selection and actions. Retirement keeps the identity and history; the
Retired filter preserves access to Restore.

Working now covers Active Agents independently of the library filter. It loads
activity automatically through the existing owner-scoped Agent detail API. Current work uses verified runner leases and execution
generations. Persisted running history alone is not proof of current work.
The detail response includes a separate `runningNow` list of verified Jobs;
ordinary history and pagination remain unchanged. Older backends can supply a
verified count without Job details; persisted history is never used as current
Job evidence. Unknown or failed reads are
shown explicitly rather than counted as idle.

Activity reads are paced and refreshed without overlapping scans, preserving
headroom for Agent controls under the existing API rate limit. Project labels
are optional for standalone Jobs. Conversation links reuse the existing
navigation callback and do not start another Job.

### Working cards and new avatar defaults

Working now uses compact visual cards with live Agent avatars and profile
links, verified Job titles, optional Project locations and a two-line recorded
goal. It does not synthesize a reason or infer work from Conversation text. A
goal identical to its Job title is not repeated. Missing locations and goals
remain explicit. The scroll area is capped at320 pixels to leave room for the
library.

A fresh Create Agent form starts with the existing Pixelkin engine’s randomized
character. Cloning copies the profile but generates a fresh default character
for its new identity. Editing and recovering the same saved draft keep its
avatar. Typing in the form does not randomize the character again. The existing
manual appearance controls and avatar capture/save flow are reused.

The visual/avatar follow-up passed315 Studio tests and26 focused Agent client,
overview and identity-editor tests. Studio typechecking, scoped lint,
formatting, diff checks and native/hosted builds passed. Desktop/web checks
verified the compact visual cards, goal/Project fields, bounded viewport,
existing filters and actions, three different fresh avatar seeds, typing
stability, saved custom draft recovery, edit preservation and distinct clone
defaults. No real Agent/execution writes or page errors were observed; original
drafts were restored. Private preview images use test data. Runtime source
digest: `f7000312fbc14c9db483709f59cfaac64c7b72310e0d99161cef8fa1111d5444`,
based on `8a34bea1`.

### Agents overview validation — October 1, 2026

The configured Studio suite passed315 tests. The focused Agent overview,
client, repository and route suites passed61 tests. Studio typechecking,
DB/API server builds, native/hosted Studio builds, Studio scoped lint, formatting and diff checks
passed. Backend lint retained27 existing findings and added none.

Desktop/web checks verified the default Active filter, Cards/List layout,
Retired/All access, retirement/restoration, current Job and Project labels,
Conversation navigation, failed-read recovery and manual refresh while a
profile is selected. A delayed background response could not overwrite newer
selected activity. Verified work outside the first50 history items is covered
by a repository regression; ordinary history and owner isolation are preserved.

The live checks used authenticated GET fixtures and intercepted lifecycle
actions, with zero real Agent/execution writes and zero page errors. The actual
review backend also returned the additive verified `runningNow` array. Existing
provider/device authority evidence was reused; no new provider Job was run.
Review runtime digest: `23e4ea26d325466079c9b802e3c0ed422191c11a165080067dabdbf444f3f73b`,
based on `db5a7bf0`. Private artifacts remain outside Git.

### Durable records

- Agent engagements: link the stable agent identity to a project or standalone
  conversation, with start/end timestamps. Ending an engagement must not cascade
  delete its jobs. Standalone work must not require an invented project.
- Jobs: stable owner-scoped job ID, agent identity/version, originating message,
  conversation, optional project/engagement, title or objective, lifecycle state,
  created/started/finished timestamps, outcome and output/evidence references.
- Execution attempts: link retries and provider executions to the same logical
  job, recording actual model, effort, permission and execution generation.
  A retry, streamed token or status update is not another completed job.
- Job history must display the model and reasoning effort actually used, not
  the agent's current defaults. If attempts used different models, retain and
  show each attempt's engine. Unknown legacy values remain unknown.
- Job events: durable ordered, deduplicated lifecycle/progress events with source
  identifiers, timestamps and execution generation. Keep a queryable current
  state projection and last-observed timestamp for efficient live presentation.
- Outputs: persist or durably reference completed responses, PR review results
  and other artifacts, with agent attribution and access checks. Store private
  user notes separately under their author's ownership. Highlights reference
  these records rather than duplicating or fabricating work.

For the first chat implementation, the proposed job unit is one submitted
agent-addressed turn, including its execution attempts. Future multi-step jobs
can group runs explicitly; do not equate a whole conversation with one job or
silently reinterpret historical counts when those workflows arrive.

## Universal `@Agent` Chat Contract

Agent invocation belongs to the shared chat capability, not to an individual
page. Every current and future chat composer must use the same stable-identity
mention resolution, active-respondent behavior, model-default handling,
response attribution and unavailable-agent rules. Each adapter supplies the
target chat's verified context and authorization; the renderer cannot choose a
memory scope.

| Chat mechanism                                              | Required context and boundary                                                                                                            | Current status                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal standalone chat                                    | User's Personal Memory; no fabricated Project context                                                                                    | Wired through managed local execution                                                                                                                                                                                                                                                                                                                                                 |
| Personal Project chat                                       | Verified selected Project, available Project instructions and authorized Personal Memory scoped to that Project                          | Live Studio selects Project IDs surfaced by the authorized Home snapshot and passes the selection to managed execution; a complete Project catalogue and Project-instruction context are still pending                                                                                                                                                                                |
| Pull Request chat                                           | Frozen repository, PR number, head/base revisions and authorized context; local execution only, no GitHub publication                    | Wired through an isolated PR adapter. `@Agent` revalidates the Personal Agent version/model and supplies authorized Personal Memory; replies retain explicit Agent attribution. Read-only, Ask-before-run and Full access apply only to a temporary local checkout; Full is sandboxed to that checkout, and GitHub writes remain unavailable. Codex-backed Agents only in this slice. |
| Future Collaborative channels, rooms and direct/group chats | Only identities, messages, Workspace Memory and Project context authorized for that destination and audience                             | Collaborative side has not started                                                                                                                                                                                                                                                                                                                                                    |
| Any future chat mechanism                                   | Register its audience, identity ownership, memory/context scope, execution permissions, attribution and adapter before enabling `@Agent` | Required by this shared contract                                                                                                                                                                                                                                                                                                                                                      |

The Collaborative row is future work, not an exception to the product
requirement. A private direct message and a shared channel are both chat
mechanisms; each must define its audience and allowed Agent context before
Agent invocation can be enabled. A User-owned Personal Agent must not become a
Team-visible identity merely because its owner mentions it in a shared room.

Cross-surface acceptance requires tests for mention resolution, explicit
switching, model/effort defaults and overrides, response attribution,
unavailable/retired identities, retries and reconnects, and permission
preservation. Context tests must prove that standalone, Project, PR and future
Collaborative contexts cannot bleed into one another or reveal unauthorized
Personal Memory. A chat surface is not complete until its matrix row passes;
displaying an `@` suggestion alone does not count.

### Counter and section semantics

Proposed initial definitions, retaining the current labels:

- Projects: distinct currently active project engagements, consistent with
  Active in. Retain historical project associations separately; do not count
  standalone chats as projects or double-count multiple jobs in one project.
- Running Now: jobs with current verified running execution state, not merely
  assigned agents or open chats. Distinguish waiting, queued and stale/unknown
  state; a disconnected client cannot establish that work has stopped or finished.
- Jobs logged: distinct durable logical jobs, including unsuccessful and canceled
  jobs, not the number of status events. Show each job's actual outcome.
- Active in: current engagements with project/conversation context, current work
  and runtime settings. No synthetic running status when no execution exists.
- Highlights: selected verified completed outputs with links and optional private
  notes. Initially use recent completions; intelligent ranking is a later step.
- Job history: paginated history across past and present engagements, including
  failed/canceled work and expandable progress or attempt details.

Live subscriptions or bounded polling should refresh these durable records;
reconnect must recover from a snapshot and ignore duplicate or stale events.
Counts and lists must use the same authorization scope. Historical attribution
survives agent renaming, retirement and removal from a project, but does not
override revoked access to a project's content.

Operational history and retained memory are distinct: saving a job is not proof
that its outputs were captured, projected or indexed. Apply the existing capture
and memory policies to eligible outputs, while retaining authorized job history
independently. This also gives Home and future For You a reliable source of
completed work and blockers.

Acceptance tests must cover restart/reconnect recovery, event replay and retries
without double counting, concurrent jobs, standalone work, terminal outcomes,
stale running state, retirement/removal with history retained, and cross-owner
and revoked-project access denial.

## Runtime context

Assemble three distinct inputs for every run:

1. A versioned snapshot of the agent's identity and working instructions.
2. Task-relevant memory retrieved under the current user's authorized scope.
3. Available context and instructions for the selected project.

Do not append all recalled material permanently to soul instructions. Memory
content is evidence, not executable policy or permission. Absent project context
must stay absent rather than becoming a fabricated briefing. Runtime context
must be bounded and must not carry private material between unrelated projects.

Record agent identity/version, resolved model/effort, conversation, run, project
scope, and context references for attribution. Recheck authorization when using
or opening evidence; a historical reference does not grant future access.

Use the existing managed-conversation lifecycle and authorization contracts.
No new backend answer-synthesis service and no Hermes dependency. The PR Chat
Agent adapter preserves frozen PR scope and separates local execution from
GitHub publication. Read-only, Ask-before-run and Full access affect only the
temporary checkout; Agent support does not authorize GitHub writes, reviews or
publication. Unsupported Agent providers must be rejected rather than silently
switched.

## Delivery sequence

### Verified reuse and gaps (initial audit baseline)

- `apps/studio/prototype-pages/agents/page.tsx` preserves the original Agents
  page but is not a reachable route. Port it to `src/app/agents/page.tsx` and
  deliberately update the gateway's route allowlist/test expectations.
- Reuse `CreateAgentModal`, `AddAgentModal`, `AgentAvatarView` and `PixelkinLab`.
  Keep prototype-only workspace simulation separate from live provider wiring.
- The original prototype's newer `ChatComposer` already has mention selection;
  port that behaviour without removing Studio's execution permission guards.
- The current `AgentDefinition` lacks defaults, retirement and versioning.
  Editing regenerates its instructions; deletion removes project assignments.
  These behaviours must change before production persistence is connected.
- Existing local AI Client settings describe provider configuration, not reusable
  personas. Do not repurpose those records as agent identities.
- Managed executions already support model and effort, but require explicit
  identity-version attribution. Existing Team collaboration participants are
  user-only; do not silently overload them with agent IDs.
- `apps/api/src/managed-conversations/routes.ts` has validated start and prompt
  contracts, including per-prompt settings changes. Extend those contracts
  explicitly rather than hiding identity metadata inside free-form prompts.
- Personal New Chat has a live Send path and versioned Agent routing. PR Chat
  has a separate owner-authenticated Agent context and attribution contract;
  its isolated adapter supports local checkout execution without GitHub write
  authority. Hosted identity, durable PR conversation history and additional
  model providers remain out of scope for this slice.

### 1. Evidence and contracts

- Map the original UI and imported components before editing.
- Identify existing identity, conversation, execution and authorization records.
- Define storage ownership, migration compatibility and provider capability
  mapping. Do not conflate agent personas with provider IDs already called agents.
- Identify the adapter boundary for desktop and browser clients.

### 2. Persistent identities and faithful Agents UI

- Add or extend owner-scoped durable storage, identity versions and retirement.
- Port the original page and reuse its dialogs and avatar components.
- Add preferred model/effort and editable soul controls in creation and editing.
- Wire real create/read/update/retire operations; browser storage is not the
  authoritative agent database. Keep synthetic fixtures explicitly separated.
- Test authorization, restart persistence, edits, retirement and retained history.

### 3. Chat participants and shared mention behavior

- Persist participants and the active respondent independently of executions.
- Add mention selection, active-agent presentation and response attribution.
- Acceptance: create Bob, enter `@Bob` with a message, and send it. The run must
  reference Bob's identity/version and his response must display Bob's name and
  avatar. Subsequent unaddressed messages go to Bob until explicitly switched.
  Verify this on every chat surface in the matrix, including mention
  suggestions, ambiguous names, unavailable agents and preservation of
  execution permissions.
- Acceptance: start with different composer settings, invoke Bob, and verify
  his preferred model/effort appear before Send and are used by the execution.
  Cover manual overrides, follow-up messages, switching agents, unavailable
  defaults and immutable settings for an in-flight turn.
- Resolve defaults and per-chat overrides without mutating the reusable identity.
- Specify agent switching during a running turn: preserve that turn's snapshot;
  do not silently retarget an in-flight execution.
- Keep legacy conversations usable without inventing an agent author for them.

### 4. Real execution and context-aware chat adapters

- Reuse managed launch, prompt, runtime events, approvals, interrupt and
  reconnect where the surface supports managed local execution.
- Connect each chat mechanism to an adapter that binds identity, authorized
  recall, audience and verified destination context to each run.
- Cover cancellation, duplicate submissions, access revocation, stale events and
  provider failures. Do not display a successful run from optimistic UI state.
- Complete Personal New Chat and Project context first, then connect PR Chat
  without weakening its read-only sandbox, GitHub access or
  publication-confirmation boundaries.
- Design and implement Collaborative chat adapters when that side of the app
  begins. Include channels and direct/group chats in the `@Agent` acceptance
  matrix; preserve User-versus-Team identity ownership and audience restrictions.

### 5. Verified outputs and end-to-end validation

- Feed completed work and blockers to existing Home destinations, with correct
  ownership, evidence and freshness rather than a transcript-viewer fallback.
- Preserve attributable history when an identity is retired or renamed.
- Test desktop/browser layouts, mention selection and active-agent switching
  across the complete chat matrix, multiple participants, resize/collapse,
  restart/reconnect and denied access.
- Confirm that prototype-only collaboration and simulated activity did not
  become presented as real functionality.

## Work allocation and review gates

Luna High agents perform bounded work with explicit file ownership; they must
not edit the prototype folder, overwrite concurrent work, or spawn more agents.
The orchestrator integrates changes and verifies runtime boundaries and UI.

Start with independent read-only design and backend mapping. Agree shared
contracts before dividing implementation between storage/API and UI workers.
Wire execution after those contracts are tested. Review each slice before
continuing; do not advertise the full feature after only the UI is implemented.

No commits, pushes, Linear tickets or release metadata changes are authorized
by this plan alone. Seek release-bump confirmation before a release changeset.

## Backend review gates

The read-only audit identified these prerequisites:

- Reuse `packages/db/src/managed-conversation-repository.ts`, API managed
  conversation routes, and the Desktop manager's generation-aware adapter.
  Add explicit durable identity/version, conversation membership and run
  attribution records rather than reusing captured-session nicknames.
- Protect private soul instructions using the repository's existing encrypted
  payload patterns. Enforce owner scope for every record operation and prevent
  cross-owner existence probes. Avoid credentials in public identity responses.
- Studio's upstream operator credential is not a hosted user identity. Before
  agent writes, provide authenticated server-side request handling, input
  validation, request protections and idempotency. Never expose gateway tokens
  to the renderer; hosted use needs its own per-user credential boundary.
- The managed worker currently builds provider instructions and dispatches
  prompts through distinct lifecycle operations. Context assembly must therefore
  be bound to the actual first prompt exactly once, not merely saved at start.
  Test retries and reconnects explicitly. Assemble trusted identity and scoped
  evidence at the authorized runtime boundary, not from renderer-supplied claims.
- Project ownership and capability validation already exist and must remain
  authoritative. A saved preferred model cannot bypass current capabilities.
- Personal New Chat is the first connected surface. The live page now selects
  Project IDs from the authorized Home snapshot and passes the chosen ID to the
  managed execution path, which scopes Personal Memory accordingly. A complete
  Project catalogue and Project instruction source remain pending. PR Chat
  identity integration is a separate acceptance gate: its current isolated
  runner is not the Personal Agent managed execution adapter. Leave its runtime
  unchanged until durable attribution and context wiring preserve its read-only
  and publication boundaries.
- Collaborative chats are not implemented yet. Before enabling Agent mentions
  there, define Team-versus-Personal identity ownership, membership and audience
  visibility, authorized Workspace/Project/Personal Memory context, output
  attribution and execution permissions. Then implement `@Agent` for every
  Collaborative chat surface, not only channels or one selected page.

These are implementation prerequisites, not reasons to change the UI design.
Both initial Luna High reviews are complete; implementation remains staged by
the contracts and gates above. Koed recall was attempted but rate-limited.

### Local gateway boundary

The Studio gateway forwards only the allowlisted Personal Agent routes to its
loopback Koed API. It resolves the local User credential server-side; the browser
never receives it. Existing Host and Origin checks apply to every request. Writes
also require a short-lived, origin-bound Studio CSRF token, JSON content, and a
bounded request body. Upstream redirects are rejected and error details are not
relayed to the browser. Optimistic-concurrency conflicts remain HTTP 409 so the
editor can ask the user to reload rather than overwrite another edit.

This local, single-user transport does not establish hosted SaaS authentication.
A hosted adapter must authenticate the individual User and must not reuse an
Operator credential across users. The API remains responsible for owner scope,
validation, capability checks, and transactional persistence.

## Implementation progress

- Initial foundation: shared validated Personal Agent contracts and focused
  tests, plus a provider-independent creation/editing form reusing the existing
  avatar editor. The form accepts actual model capabilities and a save adapter.
- Legacy prototype callers cannot persist the new fields; those controls remain
  disabled there. Custom instructions must not be silently discarded.
- Durable identity management is implemented: additive migrations, encrypted
  soul instructions, owner-scoped routes, retry fingerprints, version-checked
  edits and retirement. The `/agents` page uses the real local API.
- The original editor and animated avatars are retained. Creation and editing
  support available provider/model/effort defaults. Custom instructions survive
  metadata edits. Retired identities retain their history.
- Logical jobs and immutable execution-attempt attribution have a storage
  foundation. History displays each recorded attempt's actual engine, effort
  and instance. Unknown project counts and unverified live counts remain unknown.
- Personal New Chat now uses durable participants, stable `@Agent` routing,
  version-pinned context and managed local execution. Completed replies retain
  encrypted output and historical author identity. Explicit agent selection
  applies its preferred model and effort without changing permissions.
- Universal `@Agent` support is not complete: Personal Project selection is
  wired for Projects present in the authorized Home snapshot, but Project
  instructions are not yet assembled; PR Chat is not wired to Personal Agent
  execution; and the Collaborative side has not started. The chat matrix above
  is the completion gate for all current and future chat mechanisms.
- Project counts derive from owner-scoped jobs. Running counts require a current
  command and live execution lease; persisted stale attempts remain uncertain.
- Named-agent PR execution, richer project engagement metadata, history
  pagination controls and verified Home highlights remain pending. Collaborative
  multi-agent scheduling and generic unnamed live chat are not enabled here.

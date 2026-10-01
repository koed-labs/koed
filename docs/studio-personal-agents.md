# Studio Personal Agents

## Purpose

Personal Agents are reusable, user-owned identities. Their names, avatars,
instructions and preferred execution settings are separate from individual
conversations and execution attempts. Studio preserves the imported Agents
page design and uses an authenticated API instead of the prototype's browser
storage.

The [role-template catalogue](personal-agent-role-templates.md) defines reviewed
starting instructions, immutable publication and independent per-agent copies.
It is separate from runtime memory retrieval and project context.

## Storage and API

Migration `0042_personal_agent_foundation` adds identities, immutable identity
versions, and logical job and execution-attempt records. Soul instructions use
the existing encrypted-field payload store. Retiring an identity prevents new
use without deleting previous versions or work attribution.

Migration `0043_personal_agent_idempotency` adds retry identifiers for identity
writes. `0044_personal_agent_request_fingerprints` rejects reuse of a retry key
with a different payload. `0045_personal_agent_encryption_source` permits the
new identity-version source in the encrypted payload store. These migrations
are additive; they do not reset conversations or memory.

Migration `0046_personal_agent_durable_history` adds execution-keyed
conversation participants, ordered job events, command references and encrypted
assistant output. The original flow created a prompt and its attributed job in
one transaction. Ticket 13 now keeps planning outside assigned Jobs and binds
explicit assignments through the same managed authority.
Attempt completion is compare-and-set and idempotent for the exact attempt and
outcome. Hard deletion of an execution cascades its operational job records;
retiring an agent does not delete those records.

Migration `0057_handy_loki` permits a profile to have no default AI Client or
model, with provider and model either both set or both absent. It also reserves
each current and former Agent name for one identity within the owner's account.
The normalized name claim is kept when an Agent is renamed or retired. The
migration checks existing profile versions for cross-Agent name collisions
before altering the schema; a collision must be resolved without rewriting
historical work before that database can upgrade.
Migration `0058_windy_warpath` also requires default effort to be absent when
there is no default model, for both the current profile and saved versions.

The `/v1/personal-agents` API supports listing, detail, creation, version-checked
updates, retirement and same-identity restoration. A name already claimed by
another Agent, including a former name, returns a conflict. Detail history
reports the immutable Agent name and version captured for each Job, while all
Jobs remain associated with the same Agent identity after a rename.
The Job goal stays in its encrypted managed command payload. Its short title
is derived from that goal when the owner reads history; the plaintext Job row
keeps only a generic marker. Agent detail includes the complete goal for that
owner.

`/v1/personal-agents/capabilities` exposes the current
user's ready AI Client models and supported reasoning efforts. The local Studio
gateway forwards only these routes, keeps credentials outside the renderer,
and checks origin and CSRF tokens for writes. Hosted deployments require their
own authenticated User session. Hosted Studio serves the static UI at `/studio/`
and calls the same-origin `/v1/personal-agents` API; the API checks browser
write origins. The local transport is not hosted authentication.

When Desktop has an enabled hosted managed-execution authority, its local API
forwards Personal Agent profile, version, history, and role-template requests
to that same authority using the enrolled device credential. The hosted
authority supplies the account owner; local owner IDs are not forwarded. If
there is no enabled hosted authority, Desktop uses its local Agent store. If a
configured hosted authority is unavailable, Agent operations fail closed rather
than switching to the local store. This keeps Desktop and browser Studio on one
account-owned Agent library while preserving local-only installations.

Create requests carry an idempotency identifier. Edits and retirement include
the version the user saw, so a stale editor cannot overwrite a newer identity.
Changing a name does not regenerate the saved soul. Avatar storage contains the
compact Pixelkin configuration, not its generated image cache.

Studio keeps an unsaved create/edit form on the device where it was typed,
scoped by the verified account and backend. Browser Studio uses local browser
storage. Desktop Studio uses the existing encrypted local recovery bridge and
permits a narrowly scoped Agent-draft write during a temporary backend outage
after that account/backend pair was authenticated in the current app process.
A cold offline restart keeps the draft but does not reveal it until the account
is verified again. Drafts do not become account profiles until the User saves
explicitly; a successful save clears the device draft.

### Activity and older Jobs

Studio reads current activity in bounded batches through
`GET /v1/personal-agents/activity`, with one `agentId` query parameter per Agent.
The response is scoped to the authenticated owner. It does not load Agent
instructions or full Job histories. Working status still requires a current
execution generation, dispatching command and unexpired runner lease.
Unavailable or unverifiable activity remains unknown.

The compact response retains authorized Job descriptions, Project context and
Conversation links for the Working now display. A request accepts up to 100 unique Agent IDs. The response includes at most
five current Jobs per Agent and 100 across the batch, with an explicit count
and truncation indicator. Goal excerpts are limited to 240 characters. A missing or
failed read must not imply that an Agent is idle.

An optional Project summary preserves the cards’ historical Project engagements
without hydrating Job histories. It lists up to five named Projects per Agent
and 100 per batch, with the full distinct Project count and a truncation
indicator. Missing names remain unavailable. Select the profile for remaining
engagements; an older authority without this field shows an explicit prompt
to load the profile instead of a permanent checking message.

Agent details use `GET /v1/personal-agents/:agentId/jobs` to load older history.
The `before` cursor and `limit` (1–20 Jobs) preserve the existing creation-time
and ID ordering, including PostgreSQL timestamp precision. Pages retain the original Agent name, goal and execution attempt
metadata. Loading older Jobs does not change their identity or start work.
Studio merges pages by Job ID, preserves loaded history during refresh and
rejects late page results after the selected Agent or account changes.

Desktop forwards both reads through its existing authorized Studio gateway and
configured Personal authority. Hosted Studio uses the same-origin API. Neither
read changes Memory, Agent profiles or execution state.

The maintained synthetic browser suite is documented in
[Studio UI regression tests](../apps/studio/tests/ui/README.md). Its fixtures
exercise the real Studio components without accounts, providers or a live
backend; API and PostgreSQL authorization checks remain separate gates.

### Verification of activity and history improvements

Focused API, local-edge routing and repository tests pass (94 checks). A real
isolated PostgreSQL test covers valid leases, expired and mismatched attempts,
owner isolation, encrypted goals and cursor traversal at sub-millisecond
precision. Agent client/state tests pass (33 checks), alongside 317 existing
Studio tests. All six maintained synthetic browser tests pass with two workers.
Shared, DB, API and Studio typechecks pass.

Desktop and hosted production builds pass. Authenticated reads in both review
runtimes pass through their actual gateways: bounded activity, history,
unknown IDs and invalid cursors. No provider work or profile changes were
started by these checks. The selected live profile had no history; populated
history traversal is covered by PostgreSQL and synthetic browser tests.

The affected Studio files and new API/shared files pass focused lint. The DB
repository retains 27 pre-existing lint findings in unchanged code; none are
in the new activity or history paths. These checks do not claim a clean
whole-repository lint result or a new provider/device execution validation.

## Execution Boundary

An Agent profile may be saved without a preferred model, or with a model that is
currently unavailable on this computer. Saving it does not launch an AI Client.
Runtime integration validates capabilities when a Job actually starts and asks
for an available per-Job choice when the saved default is absent or unavailable.
It does not silently change the reusable profile. Each execution attempt
must record the actual provider, model, effort and permissions; history must not
derive these values from today's agent defaults.

Retirement prevents new Jobs and attempts but does not cancel or rewrite an
already-running attempt. Restoration returns the same Agent identity and
historical work to the active list. Profile edits create immutable versions;
running and completed Jobs retain their original version and name.

The approved conversational assignment refinement is documented in
[Studio Team Agent work](./studio-team-agent-work.md). Ticket 13 changes the
per-request Job recording described below: planning remains private, active
steering retains one Job, and additional assigned work after completion creates
another Job. That refinement is currently being implemented.

Give a job starts a fresh Personal chat with that active Agent selected. The
User writes one clear goal in the chat composer. Model and reasoning effort are
runtime choices for that Job and do not edit the saved profile. Each submitted
request has its own Job record. Follow-ups can stay in that chat and use its
relevant conversation, but the Agent's other Jobs are not inserted into the
prompt. Studio does not offer a daily token cap that the AI Client cannot
enforce; it reports progress, elapsed time and Stop, with provider usage shown
only when that value is reliable.

Every chat mechanism must resolve mentions to stable identity IDs. An explicit
mention selects the respondent and applies its preferred model and reasoning
effort. A manual model override remains in effect until another explicit
selection. Permission settings do not change when an Agent is selected. Unknown,
ambiguous and retired mentions cannot start a task. The containing chat's
adapter supplies its audience, authorization and context; the renderer cannot
choose a memory scope.

For a private Personal Job, the API resolves an immutable identity version and
retrieves bounded evidence from the User's own Memory and from Team Memory the
User can currently access. A Project can help rank relevant evidence but does
not restrict the User's Memory access to that Project. Team membership,
Workspace access, grants, source fidelity and lifecycle checks apply when
retrieving shared evidence. The managed AI Client receives identity guidance,
evidence and the current request in a labeled per-turn prompt. These are not a
separate system-instruction channel. Memory is evidence, not instructions, and
identity guidance cannot grant tools or override runtime permissions. No
server-side LLM synthesis is added. Team-visible Jobs require a separate Team
audience boundary in later tickets; private evidence is not published by this
Personal flow.

If recall is temporarily unavailable, the turn pauses before provider
execution. The User can retry or explicitly continue this request without
Memory; the latter remains visible in history and does not disable recall for
later requests. An authorization denial stops the request and cannot use that
bypass.

This is not yet a claim of universal chat coverage. The live Studio page offers
Project IDs surfaced by its authorized Home snapshot and passes the selected ID
to managed execution. A complete Project catalogue and Project-instruction
context are not yet wired.
PR Chat is not connected to Personal Agent execution; Collaborative chat
surfaces have not started. See the [shared chat matrix and completion gates](studio-personal-agents-plan.md#universal-agent-chat-contract).
No chat mechanism is complete until its row passes those gates.

Local and hosted Personal Agent Jobs may launch without a Project. The selected
AI Client must advertise the model, effort and
permission mode. This adapter does not substitute providers or treat supervised
execution as read-only. A provider change requires a new conversation; the
unsupported read-only option fails closed before launch.

For a hosted Job assigned to a local runner, Job and attempt records stay in
the hosted authority. The runner uses its authenticated, device-bound managed
execution channel to read the assigned Job and record attempts and encrypted
output. The authority checks the User, execution assignment, device and
deployment on every operation; a local Job row is never substituted for the
hosted record.

The browser sends commands through a loopback-only, CSRF-protected gateway.
Credentials remain in the local service. Approval requests expose the specific
command, file change or permission scope before a one-request response; they are
never accepted automatically. Reopening a conversation restores verified
execution settings rather than today's identity defaults.

PR Chat retains its existing read-only runtime boundary. Named-agent PR
execution, automatic Home highlights and collaborative multi-agent scheduling
are separate integration steps, not implied by enabling Personal New Chat.

Operational job records are not proof of memory capture. Existing Capture Policy
and access checks still apply. Unknown runtime state must not be presented as
verified running work or a completed task.

Assistant text is retained as encrypted operational output, separately from
memory ingestion. Reading it requires ownership and a currently enabled managed
runtime message presentation policy. Cleanup of temporary runtime items does not
erase the retained output. Historical authors use the immutable identity version,
not the current name or avatar. Conversation responses are bounded and report
when older history exists. A running job without a verified live command lease
is reported as uncertain rather than currently running.

See [the implementation plan](studio-personal-agents-plan.md) for the agreed
behaviour and remaining acceptance gates.

## Validation

Focused contract, repository, route, editor and adapter tests cover ownership,
stale edits, retries, model availability and response mapping. The disposable
PostgreSQL smoke runs migrations in a separate database and verifies concurrent
creation, encrypted instructions, payload conflicts and retained retirement.

Local browser validation covered creating Bob, selecting Luna High, changing
his role without changing custom instructions, and reloading the saved identity.
The local database was backed up before applying the additive migrations.
Identity management uses a dedicated API rate-limit bucket, separate from
transcript ingestion. HTTP 429 remains a retryable failure and must never be
reported as a successful save.

The September 22 local runtime test completed a real Bob conversation and
verified the attributed reply after both browser reload and backend restart.
The selected saved model was `gpt-5.6-luna` with high effort; no provider or model
substitution was made. Managed execution was routed locally with the User's
approval; the saved remote connection and its other routing settings remain.
The test found and fixed an assistant-output buffer lookup that incorrectly
assumed the provider did not supply an item ID.

The disposable PostgreSQL test also covers transactional prompt replay,
participants, actual attempt settings, encrypted output, presentation-policy
suppression, cross-owner denial, completion replay, retirement retention and
stale-running detection. Focused tests and the Studio production build pass.
This is not a hosted SaaS or collaborative multi-agent acceptance test.

Ticket 11 validation used the signed-in hosted Studio and a disposable local
Codex runner. **Agents → Give a job** opened a new Agent-selected chat. The
initial request and a follow-up produced two successful Jobs in one
conversation, each with its own encrypted goal, automatic owner-visible title,
immutable Agent attribution and actual model/effort. Both replies were visible
in the chat. Focused tests cover authorized Personal and Team evidence,
revocation and other-owner denial, temporary recall failure, the one-request
skip, duplicate prevention and attempt fencing. A separate disposable Electron
review used the same hosted account authority for Agent profiles and Jobs. It
completed one fresh Codex Job with the exact reply, one durable Job and the
saved Agent version/model/effort in Desktop history. Delayed local start
recovery keeps the Agent and original send identity until the first prompt is
accepted. The private runner advertised Codex only; live Pi and Claude
multi-Job checks remain unrun.

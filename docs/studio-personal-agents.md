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
assistant output. A prompt and its attributed job are created in one transaction.
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
`/v1/personal-agents/capabilities` exposes the current
user's ready AI Client models and supported reasoning efforts. The local Studio
gateway forwards only these routes, keeps credentials outside the renderer,
and checks origin and CSRF tokens for writes. Hosted deployments require their
own authenticated User session. Hosted Studio serves the static UI at `/studio/`
and calls the same-origin `/v1/personal-agents` API; the API checks browser
write origins. The local transport is not hosted authentication.

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

Every chat mechanism must resolve mentions to stable identity IDs. An explicit
mention selects the respondent and applies its preferred model and reasoning
effort. A manual model override remains in effect until another explicit
selection. Permission settings do not change when an Agent is selected. Unknown,
ambiguous and retired mentions cannot start a task. The containing chat's
adapter supplies its audience, authorization and context; the renderer cannot
choose a memory scope.

For the connected Personal New Chat path, the API resolves an immutable identity
version and retrieves bounded, authorized Personal Memory evidence for each
turn. Project-scoped turns must use the verified execution Project; standalone
turns use the User's Personal scope. The managed AI Client receives identity
guidance, evidence and the current request in a labeled per-turn prompt. These
are not a separate system-instruction channel. Memory is evidence, not
instructions, and identity guidance cannot grant tools or override runtime
permissions. No server-side LLM synthesis is added.

This is not yet a claim of universal chat coverage. The live Studio page now
offers Project IDs surfaced by its authorized Home snapshot and passes the
selected ID to managed execution, enabling Project-scoped Personal Memory. A
complete Project catalogue and Project-instruction context are not yet wired.
PR Chat is not connected to Personal Agent execution; Collaborative chat
surfaces have not started. See the [shared chat matrix and completion gates](studio-personal-agents-plan.md#universal-agent-chat-contract).
No chat mechanism is complete until its row passes those gates.

Local standalone chats may launch without a Project. Hosted projectless launch
is rejected. The selected AI Client must advertise the model, effort and
permission mode. This adapter does not substitute providers or treat supervised
execution as read-only. A provider change requires a new conversation; the
unsupported read-only option fails closed before launch.

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

# Project-Backed Workspaces And Project Share Policy

Status: Accepted.

Amended by [ADR 0064](./0064-frozen-contributions-share-origin-and-sharing-page.md).

Related decisions:

- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0047 Team Conversation Source Access](./0047-team-conversation-source-access.md)
- [0049 Selective PII Team Representations](./0049-selective-pii-team-representations.md)
- [Project-sharing lifecycle](../project-sharing-lifecycle.md)

## Context

The Desktop redesign lets a User share a whole Project with a named group or
with an owner-managed group shown as **Shared**. A Project is a User-owned
container under D4. A shared Project also has a distinct Team-side Workspace
Project identity; it links participating Users' Personal Projects and does not
replace or own them. A Workspace remains the stable Team-side identity used
for shared memory. The repository's local Project-to-Workspace mapping is
recall context; it does not create a Workspace Project or authorize sharing.

This decision amends ADR 0004 only where that ADR defines Project as local
AI-client or code context. In this model, Project is the User-owned container;
repository, path, branch, ref, cwd, and similar local context may resolve to a
Personal Project but are not the Project itself. Existing ADR 0004 rules for
User ownership, Share Grants, Team and Workspace authorization, Cross-Identity
Sync, retention, and lifecycle continue to apply.

Project sharing must preserve the ownership and authorization boundaries in
ADR 0004. Each User owns their Conversations and resulting Personal Memory. A Project
owner is not thereby a Team owner, and a Project policy cannot share another
person's Memory.

## Decision

Each Project shared through this model has exactly one dedicated Team
Workspace at a time, represented by a distinct Workspace Project. This does
not constrain ordinary Team Workspaces or local Project-to-Workspace mappings
used for recall. A share outside a named group creates an owner-managed Team
with one Workspace. A Project shared to a named group gets its own
Project-backed Workspace within that Team. Moving a shared Project between
groups is outside this decision.

For a Project-backed Workspace, the UI presents members with Workspace Access
`write` and `can_share_owned_memory`. Team membership roles remain independent
and continue to control Team-wide authority. Project ownership is stored in
`workspace_projects.owner_team_member_id` and is independent of Team role:

- Project-scoped actions use the Project's owner binding together with current
  Team membership and Workspace authority.
- Team-wide governance uses Team role. Sharing or owning a Project never
  promotes its owner to Team role `owner`.
- The last-Team-owner guard applies to the Team membership role, regardless of
  which member owns any particular Project.

A Project Share Policy applies separately on each member's own Desktop and
only to that member's own sources. At join, the member reviews the
summary-sharing disclosure and explicitly enables the policy through the
Native-review `shared_memory.project_share_policy.enable` action in ADR 0024.
That consent is durable, versioned, and revocable; it is not the expiring,
single-use UI Action Grant used to review the enable decision. The policy
excludes the Project's HQ Conversation and Conversations marked private. It
never grants another member's sources, Conversation Source Access, raw
`memory_events`, or `curated_assertions`.

Bind the policy version to the source owner, the currently enrolled source-
owner device credential generation and backend origin, Team, Workspace, exact
Workspace Project, the owner's exact Personal Project, and fidelity
`lcm_leaves`. Credential rotation or re-enrollment, backend or source-owner change,
Project-link change, or a mismatch between the bound policy scope and source
mapping fails closed and requires new reviewed consent. A newly captured
Session may use a new exact mapping under the same current scope only through
the Bundled stage; a changed or ambiguous existing mapping receives no
inherited authority and requires a fresh source/share decision. Authority is
not migrated automatically.

The policy does not create a Conversation grant type. Each resulting Share
Grant binds to one exact, owner-owned Captured Session. When the owner enables
the policy, the owner's trusted local edge builds a bounded candidate manifest
from authoritative local capture and Project state for currently eligible
Captured Sessions whose Conversations are already associated with the exact
shared Project. Before Native review binds the issuance set, the Team Backend
validates authenticated source-owner/device provenance, the exact Project
link, current policy scope, source/mapping versions, and destination state. It
excludes any Session whose `(logicalMemoryId, teamWorkspaceId)` destination
already has a Share Grant row in any lifecycle state or an unresolved Pending
Share operation. Native review binds consent to the remaining exact Session
IDs, source revisions, trusted Conversation-to-session mapping revisions, and
approved summary scope. The renderer cannot supply or alter the candidate or
filtered set. The remote Team Backend never reads the owner's Personal
database. Existing destinations are skipped without adopting, mutating, or
renewing their grant or Pending Share consent; frozen or revoked grants and
private, moved, or deleted sources cannot be restarted. If an independent
authorized grant or Pending Share operation wins a race after review, serialize
against destination uniqueness and skip that destination without failing the
batch. Retries use the same operation identity and are idempotent. Any source,
mapping, or policy-scope drift still conflicts and requires new review; the
initial batch must not widen or backfill a different set.

An unresolved Pending Share includes any operation that can still prepare,
activate, or retry, including a retryable `failed` or `needs_attention`
operation. It is not limited to operations selected by the worker's current
in-flight query. Policy issuance cannot replace or adopt that operation.

The Bundled stage issues a fresh one-use backend authority for each exact
policy-scoped Pending Share operation; it does not directly insert or publish a
Share Grant. The trusted owner local edge uses that authority through the
existing owner-authorized Pending Share preparation and acceptance flow,
preserving its durable operation/outbox and unavailable Workspace access. The
source-owner local runtime retains source preparation and owner-private
relationship work. The existing Team worker resumes the durable Pending Share,
requires the exact consented source revision, creates the authoritative
encrypted preview, and materializes the selected Team representation. It does
not read the owner's Personal database or synthesize Personal records. The
Team worker does not call an LLM to generate or augment the representation;
deterministic Team-side materialization and indexing remain part of the
existing protocol. The representation stays unavailable while staging;
activation publishes it and activates the Share Grant together only after the
complete, immutable, authorized, sanitized `lcm_leaves` closure and current
authority checks pass.
Missing, partial, or unsanitized content remains unavailable and cannot be
exposed. Activation rechecks the exact source and Project link, Pending Share
consent and operation binding, and current lifecycle/freeze state while
serialized against freeze, delete, private, and leave actions. A freeze or
tombstone that wins prevents an earlier Pending Share from publishing new
material; if no revision was previously published, the frozen grant exposes no
bytes. See [Asynchronous semantic sharing](../self-hosted-to-hosted-sync.md#asynchronous-semantic-sharing)
for the existing Pending Share and activation protocol.

While the versioned policy remains active, the Team Backend may use the same
Bundled stage for each newly captured eligible source whose Conversation is
already associated with the exact shared Project at capture time. Before
issuing authority, and again before consuming it, the Team Backend verifies the
current owner and device association, backend origin, Team membership and
Workspace Access, Project link, policy version and scope, and trusted mapping
from the owner's Conversation to that exact Captured Session. It issues and
consumes a fresh one-use backend authority bound to that one Session, source
owner, active policy version, and complete scope. This authority is not
exposed to the renderer and cannot authorize another source, action,
destination, or later operation. Before authorizing a future Session, the
Backend skips a destination that already has a Share Grant row in any lifecycle
state or an unresolved Pending Share operation. A concurrent authorized
operation that wins destination serialization is also skipped, never adopted
or treated as a batch failure; retries keep the same operation identity. The
stage is not a generic reuse of an expiring UI Action Grant and does not bypass
the Pending Share state machine or its safe-activation protocol. After atomic
activation, that exact Share Grant and its own consent and lifecycle govern its
revision advancement.

Eligibility comes from authenticated capture and trusted source association,
not a renderer-supplied path, Project flag, or arbitrary source identifier. The
trusted source association must resolve the owner's Conversation to exactly one
supported Captured Session. Missing or ambiguous mapping, including multiple
candidate sessions, creates no grant. A grant can advance only revisions of its
bound Captured Session, never another session from the same Conversation. No
Project owner or other member can grant someone else's source.

The reviewed initial set includes eligible existing Captured Sessions that
were already in the exact shared Project when the owner enabled the policy.
While the policy remains active, future Sessions may receive grants through
the Bundled stage only if their Conversation was already associated with the
exact shared Project at capture time and they pass the same trusted mapping
and current policy checks. Moving an existing Conversation into the Project
after enablement does not add its already-captured Sessions to the initial set
or make them eligible
for future policy issuance; the owner must separately confirm sharing of each
exact source through the existing `shared_memory.pending_share` action.
Creating a Conversation in a shared Project is not itself a grant.

The source owner can disable the durable policy through the exact Native-review
`shared_memory.project_share_policy.revoke` action, bound to the current policy
version. Revocation disables future policy-based grant issuance only; existing
Share Grants continue to advance under their own consent and lifecycle. Policy
revocation does not revoke, freeze, or change their consent, advancement, or
published evidence. Freezing or revoking an existing grant to stop
advancement or remove access remains a separate explicit action. Making a
source private, moving or deleting it, or freezing or revoking its grant
invalidates its policy eligibility. Restoring,
rejoining, or moving the source back cannot recreate or restart a frozen or
revoked grant; a fresh source/share decision is required.

Implementation must reject attempts to use another member's source, a stale or
revoked policy version, a changed device/backend/Project scope, a
renderer-selected source identifier, an ambiguous mapping, or a frozen/revoked
grant. Existing destination grant rows (including revoked rows) and unresolved
Pending Share operations must be skipped without changing their consent or
lifecycle; concurrent destination races must not create duplicates or fail the
batch. A staged Pending Share remains unavailable unless the complete
authorized, sanitized `lcm_leaves` closure can be published atomically with the
grant. A changed initial set or source/mapping revision before execution must
conflict and require new review, without partial execution or wildcard
backfill. An existing Conversation moved into the Project after enablement
must not make its already-captured Sessions eligible. Rejections create no
grant and publish no Team-visible revision.

Policy-created grants use fidelity `lcm_leaves`. This is summary sharing; it
does not create Conversation Source Access. An owner may separately enable
that capability for the exact Captured Session under the Step-up flow in ADR 0024. The Team receives only the separately encrypted, sanitized Conversation
Source Artifact and verified source segments allowed by the Team-audience
presentation policy in ADR 0047. Conversation Source Access never authorizes
the owner's raw private journal, and values redacted by the Team-audience
policy remain unavailable. The Project join disclosure authorizes summaries
only.

`curated_assertions` is a separate representation and consent. An initial
Pending Share that enables Curated Memory requires its own disclosure and
Step-up under ADR 0024, as does enabling it later; Full access does not bypass
that requirement. An assertion is eligible only when its complete, non-empty
active direct-source set consists exclusively of direct sources from the exact
granted Captured Session, with all active provenance resolving inside that
session. A single matching source is insufficient if another active direct
source falls outside that session or the provenance is incomplete. The
assertion must also have `scope = project` and resolve to the matching
owner-owned Project linked to the Workspace Project. Me-scoped, unscoped,
mixed-session, and non-Conversation evidence is ineligible. Scope or Project
changes withdraw affected Team representations, semantic routing, and vectors
before the Personal mutation commits. Co-located Personal and Team records use
one database transaction. With separate Team storage, the source owner's
trusted local edge durably coordinates the mutation, fences stale publication,
and waits for an atomic withdrawal acknowledgement from every affected Team
backend. An unavailable backend leaves the Personal change pending for retry;
if withdrawal succeeds but the Personal commit fails, the safer withdrawn
state remains. The Team backend does not read Personal storage, and a Personal
API Token does not authorize withdrawal. Unrelated grants remain intact.
Team backends must receive the atomic withdrawal schema and authenticated
route before the Personal legacy-scope activation worker runs. Legacy
assertions stay activation-pending until every historically linked backend
has returned its durable receipt; an offline or older backend cannot satisfy
that gate.

When a Personal owner action such as Conversation deletion, movement out of a
shared Project, or Personal Project deletion affects an active Team grant, the
exact source owner uses the target per-grant Native-review
`shared_memory.grant.freeze` action and waits for each required Team freeze
before the Personal action reports completion. This action is not implemented
yet. This does not make the Personal command a Team action or require Team
enrollment when no active Team grant is affected. Team-authoritative deletion,
member removal, and membership departure freeze their affected grants through a
target Bundled stage of the exact parent Team action; those lifecycle freezes
are not implemented yet either.

Every freeze pins future advancement at the last actually published revision
and its complete immutable authorized representation closure. It is grant-
specific: it does not revoke the grant or change the source owner's consent.
Already-published material remains recallable while the grant remains
otherwise authorized; later messages and revisions are excluded. The atomic
Team-backend operation serializes with in-flight advancement. The exact source
owner can request the target per-grant action while their Desktop is online; a
narrowed authoritative Team lifecycle action can run while source-owner
Desktops are offline. Neither operation revokes a Cross-Identity Sync
relationship that may serve other grants.

If a frozen grant has attached continuous Conversation Source Access, the same
atomic freeze pins its last authorized sanitized source generation and segment
frontier. No later source generation or segment becomes readable through that
capability. Source consent and capability remain separate from the semantic
Share Grant and continue to follow ADR 0047's revocation, expiry, membership,
Workspace Access, and Team-audience policy checks. Snapshot source access and
unrelated grants are unchanged by the freeze.

Marking a Conversation private is a local owner control. If it affects a
Project-policy-created grant, the owner separately authorizes a freeze through
`shared_memory.grant.freeze` Native review. The last published representation
remains available under current authorization; later revisions do not advance.
Sharing again requires a new explicit sharing action. For active or frozen
grants bound to a Workspace Project, the source owner cannot revoke the Share
Grant; the Workspace Project owner may remove the contribution. Suppression,
expiry, and current policy checks continue to govern frozen grants. Shares
outside a Workspace Project keep their existing revocation lifecycle.

Deleting a shared Project leaves its Workspace and grants in place. The
Project Thread is archived and each affected grant is frozen as described
above. Restoring the Project does not resume frozen grants or recreate sharing
for member Conversations. New grants or another explicit sharing action are
required to advance them again.

Moving a Conversation out of a shared Project is a local owner control. Before
detaching the Conversation, the source owner uses the target separate per-grant
Native-review `shared_memory.grant.freeze` action for every affected old
Project-policy grant. This action is not implemented yet. It pins the old grant
at its current published closure.
The old grant and already-published Team material remain under their existing
authorization; for a Workspace Project contribution, only the Workspace
Project owner may remove it. Sharing to a new shared destination requires a
new explicit confirmation and exact source mapping. Moving back or restoring
the old Project never resumes the frozen grant.

Deleting a Personal Project is a local owner control and does not require Team
enrollment or browser approval. If the Project has active Team grants, the
source owner uses the target `shared_memory.grant.freeze` Native-review action
for every grant
attached to each child Conversation's exact Captured Session and supported
Project Source revision. This includes separately created explicit grants, not
only Project-policy grants. Wait for every required Team freeze before the
local batch reports success or purges child records. The operation is
idempotent; already completed freezes remain frozen on retry.

Team-side Project deletion, member removal or leave, source metadata deletion,
and restore use the exact action names, tiers, and owner checks in the target
Project-lifecycle matrix in ADR 0024. Those target actions are not implemented
by this ADR. A Personal Project, Conversation, or source command remains under
its owner's local controls; when it affects an active Team grant, the owner
uses the separate per-grant freeze action above. A lifecycle freeze is a
Bundled stage only of its exact authorized Team operation; it cannot stand in
for a Personal command or a grant revocation.

Durable user-visible lifecycle behavior is specified in
[Project-sharing lifecycle](../project-sharing-lifecycle.md). This accepted
ADR defines intended behavior; it does not assert that Project-backed
Workspaces, Project Share Policy, or lifecycle-freeze operations are already
implemented.

## Consequences

- Memory remains owned by each originating User; the Team receives only the
  representation allowed by that User's grant.
- Existing privacy filtering and Team representation rules in ADR 0049 apply.
- A Project's policy authorizes separate per-Session grants with independent
  revocation and retention lifecycles, rather than one Project-wide grant that
  would remove per-Conversation control.
- Exact source access, Curated Memory, and semantic summary sharing remain
  separate authority decisions.
- The Project entity and Team-side Workspace Project are required before this
  policy can be implemented.

## Alternatives Considered

### One Project-wide Share Grant

Rejected because it removes per-Conversation revocation and retention controls
and requires a new shared representation model.

### Manual sharing for every Conversation

Rejected because members would have to repeat the share flow for each new
Conversation in a Project.

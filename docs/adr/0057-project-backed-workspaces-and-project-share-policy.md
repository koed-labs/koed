# Project-Backed Workspaces And Project Share Policy

Status: Accepted.

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

A Project Share Policy applies on each member's own Desktop to that member's
own Conversations in the shared Project, after that member confirms the
summary-sharing disclosure once when joining. It excludes the Project's HQ
Conversation and Conversations marked private. It does not create a new
Conversation grant type: each policy-created Share Grant binds to one exact,
owner-owned Captured Session. A trusted mapping from that User's Conversation
to a Captured Session must resolve to exactly one supported source before the
policy can create or advance the grant. A missing or ambiguous mapping, or a
Conversation with multiple candidate sessions, creates no implicit grant; each
session must have an explicit bounded source mapping and its own grant. A grant
can advance only revisions of its bound Captured Session and never another
session in the same Conversation. No Project owner or other member can grant
someone else's source. Creating a Conversation in a shared Project is not, by
itself, a grant; the policy applies when the owner's trusted source mapping is
available. Moving an existing Conversation into one requires a separate
confirmation to share its summary.

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
changes invalidate affected Team representations and vectors transactionally
before the Personal mutation commits.

When a Personal owner action such as Conversation deletion, movement out of a
shared Project, or Personal Project deletion affects an active Team grant, the
exact source owner uses the per-grant Native-review
`shared_memory.grant.freeze` action and waits for each required Team freeze
before the Personal action reports completion. This does not make the Personal
command a Team action or require Team enrollment when no active Team grant is
affected. Team-authoritative deletion, member removal, and membership departure
freeze their affected grants through a Bundled stage of the exact parent Team
action.

Every freeze pins future advancement at the last actually published revision
and its complete immutable authorized representation closure. It is grant-
specific: it does not revoke the grant or change the source owner's consent.
Already-published material remains recallable while the grant remains
otherwise authorized; later messages and revisions are excluded. The atomic
Team-backend operation serializes with in-flight advancement. The exact source
owner can request the per-grant action while their Desktop is online; a
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

Marking a Conversation private is a local owner control. If it withdraws a
Project-policy-created grant, the owner separately authorizes revocation
through the existing `shared_memory.revoke` Native review. Revocation is
different from freezing future advancement: it removes Team access under the
existing revocation and retention rules. Sharing again requires a new explicit
sharing action. Revocation, suppression, expiry, and current policy checks
continue to govern frozen grants as well.

Deleting a shared Project leaves its Workspace and grants in place. The
Project Thread is archived and each affected grant is frozen as described
above. Restoring the Project does not resume frozen grants or recreate sharing
for member Conversations. New grants or another explicit sharing action are
required to advance them again.

Moving a Conversation out of a shared Project is a local owner control. Before
detaching the Conversation, the source owner uses the separate per-grant
Native-review `shared_memory.grant.freeze` action for every affected old
Project-policy grant. This pins the old grant at its current published closure.
The old grant and already-published Team material remain under their existing
authorization unless the owner separately revokes that exact grant. Sharing to
a new shared destination requires a new explicit confirmation and exact source
mapping. Moving back or restoring the old Project never resumes the frozen
grant.

Deleting a Personal Project is a local owner control and does not require Team
enrollment or browser approval. If the Project has active Team grants, the
source owner uses `shared_memory.grant.freeze` Native review for every grant
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
- A Project's policy creates grants with separate revocation and retention
  lifecycles, rather than one Project-wide grant that would remove
  per-Conversation control.
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

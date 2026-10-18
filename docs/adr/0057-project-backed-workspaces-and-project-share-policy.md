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
with an owner-managed group shown as **Shared**. A Project is local work
context; a Workspace is the stable Team-side identity used for shared memory.
The existing repository already supports explicit, user-owned Share Grants to
a Team Workspace. Its local Project-to-Workspace mapping is recall context; it
does not create a shared Project or authorize sharing.

Project sharing must preserve the ownership and authorization boundaries in
ADR 0004. Each person's Conversations remain that person's Memory. A Project
owner is not thereby a Team owner, and a Project policy cannot share another
person's Memory.

## Decision

Each Project shared through this model has exactly one dedicated Team
Workspace at a time, and that Project-backed Workspace is dedicated to that
Project. This does not constrain ordinary Team Workspaces or local
Project-to-Workspace mappings used for recall. A share outside a named group
creates an owner-managed Team with one Workspace. A Project shared to a named
group gets its own Project-backed Workspace within that Team. Moving a shared
Project between groups is outside this decision.

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
Conversation and Conversations marked private. Each policy-created grant is
bound to one Conversation and its source owner. Creating a Conversation in a
shared Project creates a continuous grant under that member's policy. Moving an
existing Conversation into one requires a separate confirmation to share its
summary. No Project owner or other member can grant someone else's source.

Policy-created grants use fidelity `lcm_leaves`. This is summary sharing; it
does not create Conversation Source Access. A full transcript remains a
separate owner action for one Conversation through the Step-up flow in ADR 0024
and the source-access capability in ADR 0047. The Project join disclosure
authorizes summaries only.

`curated_assertions` is a separate representation and consent. It requires a
separate disclosure and Step-up under ADR 0024; Full access does not bypass
that requirement. An assertion is eligible only when its complete, non-empty
active direct-source set consists exclusively of direct sources from the exact
granted Conversation, with all active provenance resolving inside that
Conversation. A single matching source is insufficient if another active
direct source falls outside that Conversation or the provenance is incomplete.
The assertion must also
have `scope = project` and name the matching Project. Me-scoped, unscoped, or
non-Conversation evidence is ineligible. Scope or Project changes invalidate
affected Team representations and vectors transactionally before the Personal
mutation commits.

Chat, source, and Project deletion, and member departure, freeze each affected
grant's future advancement at its last actually published revision and its
complete immutable authorized representation closure. A freeze is grant-
specific: it does not revoke the grant or change the source owner's consent.
Already-published material remains recallable while the grant remains
otherwise authorized; later messages and revisions are excluded. An atomic
Team-backend operation pins the freeze against in-flight advancement. It can
be invoked by the exact source owner or a narrowed authoritative Project
lifecycle action, without requiring that owner's Desktop to be online. It
does not revoke a Cross-Identity Sync relationship that may serve other
grants.

Marking a Conversation private revokes its Project-policy-created grant. This
is different from freezing future advancement: revocation removes Team access
under the existing revocation and retention rules. Sharing again requires a
new explicit sharing action. Revocation, suppression, expiry, and current
policy checks continue to govern frozen grants as well.

Deleting a shared Project leaves its Workspace and grants in place. The
Project Thread is archived and each affected grant is frozen as described
above. Restoring the Project does not resume frozen grants or recreate sharing
for member Conversations. New grants or another explicit sharing action are
required to advance them again.

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

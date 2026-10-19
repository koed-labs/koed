# ADR 0062: Shared Project State on the Team Backend

## Status

Accepted design; runtime implementation is pending.

This ADR defines target behavior. The Project records, routes, and grant-freeze
operations described here are not currently implemented.

Related decisions:

- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0013 Team Collaboration Authority](./0013-team-collaboration-authority.md)
- [0032 First-Class Revisioned Personal Notes](./0032-first-class-revisioned-personal-notes.md)
- [0057 Project-Backed Workspaces And Project Share Policy](./0057-project-backed-workspaces-and-project-share-policy.md)
- [0059 First-Class Personal Projects](./0059-first-class-personal-projects.md)
- [Project-sharing lifecycle](../project-sharing-lifecycle.md)
- [Shared Project state](../shared-project-state.md)

## Context

ADR 0059 defines a Project as one User's Personal container. ADR 0057 gives a
shared Project its own Team Workspace and shares each member's own eligible
Conversations through that member's Share Grants. Those decisions keep
Personal ownership and Team collaboration separate, but they do not by
themselves place shared Work Items, Decks, source metadata, activity, or
Project Thread state.

The local `project-team-workspaces.json` mapping is recall-routing
configuration only; it does not create a Workspace Project or authorize
sharing. Separately, each member keeps a private Personal Project-to-Workspace
Project mapping in their own Personal backend and local configuration. The
Team Backend records authoritative per-member Workspace Project association
and access by Team Member ID and Workspace Project ID, with no Personal Project
ID or Personal-backend identifier. Existing Share Grant records still retain
their required logical memory ID, User ID, and source-owner provenance. Team
role and Workspace Project ownership are distinct.

## Decision

### Three data homes

| Data                                                                                                                          | Home for a shared Project                     | Rule                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Work Items, Decks and cards, Project Source metadata, activity, Project Thread                                                | Team Backend, scoped to one Workspace Project | Shared collaboration records; they are not Memory.                                               |
| Conversations, their Memory, Project Source binary content and extracted document revisions, Curated Memory and Memory Events | Each owner's Personal store                   | They remain owned by that User. The owner shares permitted revisions through exact Share Grants. |
| Private HQ Conversation, Agents, Deck progress and last-seen state                                                            | Each member's Personal store                  | Private to that member.                                                                          |

An original Project Source binary uses the existing encrypted content
reference. Each extracted document revision is a real Personal Note revision
owned by the uploader, linked to its Project Source, and projected through the
existing one-event-per-revision Personal Note path and Note Share Grant
adapter. A Project Source never uses `sessions.personal_deleted_at`. Source
metadata trash and Personal Note revision forgetting are separate lifecycle
actions. Do not add a generic Team-owned or Note-like record in place of the
Personal Note revision.

### Identity, ownership and first share

- A **Workspace Project** is a Team-side record with its own identity and
  lifecycle. Its owner is `workspace_projects.owner_team_member_id`. A member
  may own a Workspace Project while having Team role `member`; Team role
  `owner` does not make a User the owner of every Project. Sharing or owning a
  Project never promotes its owner to Team role `owner`.
- Each member, including the Workspace Project owner, keeps a private mapping
  from their Personal Project to the Workspace Project in their own Personal
  backend and local configuration. Separately, Team-authoritative per-member
  Project association and access are keyed by Team Member ID and Workspace
  Project ID, without a Personal Project ID or Personal-backend identifier.
  Existing Share Grant records retain the logical memory ID, User ID, and
  source-owner provenance required by their contract. The member's private HQ
  Conversation belongs to their own Personal Project.
- The local Project-to-Workspace mapping described by
  [Team Workspace Project Mapping](../team-workspace-project-mapping.md)
  is only recall routing. It is distinct from this shared Project link and
  does not create the link or grant Team authority.
- Team and Workspace setup preserves the existing Team authority paths in
  ADRs 0013, 0024, and 0057. A share outside a named group uses the existing
  `team.create` action: it creates the owner-managed Team, assigns the
  initiating member the Team role `owner`, and creates exactly one default
  Workspace. That default Workspace is the Project's dedicated backing
  Workspace; the flow does not create a second one. A share to a named group
  uses that existing Team and creates its own Project-backed Workspace through
  `team.workspace.create`; it must not reuse an unrelated Workspace. A retry
  may reuse only the Team and Workspace identifiers already bound to that same
  idempotent share attempt.
- These existing actions keep their current capability checks and ADR 0024
  tiers: `team.create` and `team.workspace.create` are Direct;
  `team.invite.create` and `team.invite.accept` are Native review;
  `team.workspace.access_update` uses Step-up when access expands or is
  disabled and Native review when `write` decreases to `read`. Current Team
  management checks, browser reauthentication or per-operation confirmation,
  and exact action grants remain in force where those paths require them. The
  share operation does not invite members or expand another member's Workspace
  Access implicitly; membership and access use the existing invitation and
  Workspace Access actions. Creating the Team assigns its Team owner role;
  `workspace_projects.owner_team_member_id` records the separate Project
  owner, and Project ownership in an existing Team never promotes that member
  to Team role `owner`.
- The initiating Desktop creates the Workspace Project with its Project owner
  binding and runs the collaboration-record copy to the Team Backend. It marks
  Personal collaboration rows moved only after the Team copy is confirmed.
  Retries do not duplicate records or lose the Personal source copy.
- The uploader keeps Project Source binary content and Note revisions in
  Personal storage. Sharing a Source Note revision is a separate, explicit
  Share Grant from that uploader.

### Project sharing and collaborative records

Each member's own Desktop applies the Project Share Policy only to that
member's eligible Conversations. Policy-created grants use `lcm_leaves` and
bind one exact owner-owned Captured Session. They do not share a full
transcript, create Conversation Source Access, share the member's HQ or private
Conversations, or grant another member's data. The bounded join disclosure,
versioned consent, and issuance rules remain those in ADR 0057. Curated Memory
and Conversation Source Access remain separate consent and authority paths.
Project Source Note revisions also require separate explicit grants.

Work Items, Decks, cards, and activity are Team collaboration records, not
Memory. Each member's deck progress and last-seen cursor stay in that member's
Personal store. Sending a Work Item to an Agent is an explicit action on the
sender's device in their own Managed Conversation. The Team Backend receives
only safe progress fields; it never receives that Conversation, tool output,
or file content.

The Project Thread is a human-only Team Chat Thread bound to the Workspace
Project. It is not a Conversation, Memory, or Agent input. Team messages,
including quoted or mentioned messages, do not become Memory and are not used
for Agent context. This preserves D2 and ADR 0013.

### Access, synchronization and offline behavior

Members receive the Workspace Access required to collaborate and share their
own memory. Project-scoped authority uses the Workspace Project owner binding
plus current Team Membership and Workspace authority. Team-wide administration
continues to use Team roles. Removing a member from one Project disables only
that member's access to that Project; it does not remove their global Team
Membership.

Team Project records use the collaboration realtime stream and optimistic
versions. A stale write returns a conflict with current state. The Desktop may
reapply a simple change only when that same field was not changed by another
member; otherwise it refreshes and shows the conflict. When the Team Backend
is unreachable, the shared Project is read-only from its last loaded state and
there is no offline write queue.

Team-authoritative lifecycle changes do not wait for an offline member
Desktop and do not read or write a member's Personal database. The Team Backend
tombstones that member's authoritative Team Project association/access, stops
accepting their Project progress, and denies their Project-job dispatch under
current lifecycle authority. On reconciliation, that member's own Desktop
clears their private Personal Project-to-Workspace Project mapping, detaches
their own Conversations to **Just me**, and pauses their own Project Scheduled
Jobs before they use the shared Project again. A Project-scoped job checks
current Team lifecycle before dispatch and fails closed if authority is
unavailable.

### Freeze and lifecycle

Freeze is per Share Grant. It pins the last actually published revision and
its complete immutable authorized representation closure. It does not revoke
the grant or change source-owner consent. Published evidence remains available
only under current membership, Workspace Access, suppression, expiry,
revocation, retention, and other authorization checks; later revisions are
excluded. Freeze serializes with in-flight advancement on the Team Backend,
so no worker can publish past the committed boundary. If no revision was
published, the freeze exposes no new bytes.

For a Personal action that affects a Team grant, the exact source owner
separately approves `shared_memory.grant.freeze` through Native review and
waits for every required exact-grant freeze before the Personal action
reports success. A Team lifecycle action can freeze grants while their source
owners are offline only as the backend-only `project.lifecycle.freeze_grant`
Bundled stage of the exact approved parent action. ADR 0024 allowlists only
`workspace_project.delete`, `workspace_project.member_remove`,
`workspace_project.leave`, `project_source.team_metadata.delete`, `team.leave`,
and `team.member.disable`. `team.workspace.access_update` is a lifecycle-freeze
parent only for its existing manager-authorized Step-up disablement path; access
expansion and Native-review `write`-to-`read` reduction are not eligible. The
action remains manager-only and does not provide member self-leave authority.
The stage cannot be called independently. Standalone freeze remains Native
review for the exact source owner, and restore is never a Bundled parent. Freeze
also pins the last
authorized sanitized source generation and segment frontier for attached
continuous Conversation Source Access;
source capability consent, expiry, revocation, membership, Workspace Access,
and Team-audience policy remain independent. Snapshot source access,
unrelated grants, and Cross-Identity Sync relationships are unchanged.

Restoring a Project, Conversation, Note, or membership never resumes a frozen
grant. Unsuppression may restore recall only for material already in the
grant's frozen closure. A fresh grant or explicit sharing action is required
before later content can advance. Revocation remains distinct: it removes Team
authority under the existing retention rules.

Deleting a shared Workspace Project soft-deletes its Team collaboration
records, archives its Project Thread, and freezes affected grants and
continuous source frontiers. It does not archive the Workspace or revoke
grants. Already-published Team Memory remains available to members who retain
current authorization; later revisions are excluded. Tombstoning invalidates
Project-specific links and access; it does not disable remaining members'
existing Workspace Access to retained Team Memory. Each member's own
Desktop clears their private Personal Project-to-Workspace Project mapping,
detaches their own Conversations, and pauses their own jobs when it reconciles
the Project tombstone.

Project leave and member removal affect only the named member's Workspace
Access, Project link, grants, progress, and Project jobs. Workspace Project
owners may remove another named non-owner member; the Workspace Project owner
cannot be removed through that action. A non-owner may leave only their own
Project access. The existing admin Workspace Access action remains
manager-only. None of these actions removes global Team Membership.

Before Team leave does any copy-back or destructive work, it checks the
existing last-Team-owner guard. If the member owns no Workspace Project that
would be deleted, the existing Team leave Native review remains. If one or
more owned Projects would be deleted, Team leave requires conditional
Step-up bound to the Team, membership version, exact owned Project set and
versions, and all copy-back and removal effects before mutation. Changed
membership, ownership, Project set, version, or authority requires a new
review; no stale-authority copy-back occurs. Copy-back is idempotent and is
performed by the departing member's own Desktop. The Team Backend does not
write another backend's Personal data. If an owned Project is removed, complete the Team-authoritative D9 effects
for every member before deleting Team Project records: tombstone the Workspace
Project; invalidate every member's Team Project link and Project-specific
access; freeze affected grants and attached continuous source frontiers; and
archive the Project Thread. Stop accepting Project progress and job dispatch.
The Team Backend
can finish this cleanup while member Desktops are offline and does not read or
write Personal databases. After Team cleanup, disable only the departing
member's affected Workspace Access and disable their Team Membership last; do
not wait for Personal reconciliation. Remaining members retain their existing
Workspace Access to retained Team Memory. On later reconciliation, each
member's own Desktop clears that member's private
Personal Project-to-Workspace Project mapping and handles only that member's
Personal-state cleanup. Interruption leaves records recoverable for retry.

Restore is resource-specific: a User restores their own Personal Conversation,
Project, and Note content; a Workspace Project owner restores Team Project
metadata and its Project Thread with current authority; the uploader or
Workspace Project owner restores Team Source metadata within their current
authority. Workspace, Membership, and Workspace Access restoration follow
existing Team governance and invitation rules. Restoring a Team Project never
restores another User's Personal data or membership.

## Current implementation boundary

The repository supports user-owned Share Grants, revisioned Personal Notes
and their `personal_note` sharing adapter, and local Project-to-Workspace
recall mapping. It does not currently implement the Workspace Project and
Project Source collaboration model or the target `shared_memory.grant.freeze`
and `project.lifecycle.freeze_grant` actions. ADR 0024 and the
Project-sharing lifecycle describe their intended approval and lifecycle
contracts; they are not evidence that the routes exist. HQ-011 defines the
target contract, and later implementation tickets must add the records,
routes, and tests.

## Consequences

- Team collaboration does not transfer ownership of Personal memory or
  documents.
- Project ownership does not create Team-wide administration authority.
- Shared Project data remains usable when an owner Desktop is offline, while
  private Personal state is updated by that owner's Desktop on reconciliation.
- First-share and Team-leave copy-back need idempotency and interruption tests.
- Grant freeze requires atomic coordination with publication and current
  authorization checks.

# Project-Sharing Lifecycle

This document records the accepted target behavior for Project-backed
Workspaces and Project Share Policy in [ADR 0057](./adr/0057-project-backed-workspaces-and-project-share-policy.md).
It is a contract for implementation; it does not mean that the described
Project sharing or lifecycle operations are available in the product today.

## Current repository behavior

At publication, the repository supports explicit User-owned Share Grants to a
Team Workspace. Owners review a candidate, destination, representation and
consent. Removing a User from a Team or Workspace changes future access; it
does not itself delete retained Team memory. Personal deletion removes a
Captured Session from the owner's Personal Memory recall but does not
automatically revoke its active Team sharing (ADR 0004).

Conversation Source Access is a separate capability with its own source
sanitization and Step-up requirement (ADRs 0024 and 0047). Curated Memory is
Personal by default; a Team representation requires a separate owner consent
and eligible direct provenance (ADR 0049 and `docs/curated-memory.md`). The
repository also supports local Project-to-Workspace mapping for recall. That
mapping does not create a shared Project or sharing authority
(`docs/team-workspace-project-mapping.md`).

The shared Project entity, Project Share Policy, Project-owner lifecycle,
Project deletion behavior below, and atomic grant-advancement freeze are
intended behavior and require implementation before they are available. They
must not be inferred from the current Project mapping or existing Share Grant
routes.

## Sharing and ownership

Each Project shared through this model has one dedicated Team Workspace at a
time, and that Project-backed Workspace is dedicated to that Project. This
does not constrain ordinary Team Workspaces or local Project-to-Workspace
mappings used for recall. Each member's own Desktop applies the Project Share
Policy to that member's own Conversations after the member confirms the
summary-sharing disclosure once when joining. The policy excludes the
Project's HQ Conversation and Conversations the owner marks private. It creates
one continuous, User-owned Share Grant per eligible Conversation. Moving an
existing Conversation into a shared Project requires a separate confirmation
to share that Conversation's summary. Project Sources are shared through each
uploader's own grants; the Project Share Policy does not grant another
member's Conversations or source revisions. The policy changes recall
authorization; it does not transfer ownership or create a Fork/Import.
Cross-Identity Sync remains a separate relationship under ADR 0004.

Policy-created grants use `lcm_leaves`, so Project members receive summaries.
The policy never creates Conversation Source Access. An owner may share the
full transcript for one Conversation only through the separate Step-up flow in
ADRs 0024 and 0047. The Project disclosure does not authorize `curated_assertions`.
That representation needs separate disclosure and Step-up. Eligible
assertions must have direct provenance from the exact granted Conversation,
`scope = project`, and a matching Project. Me, unscoped, mixed-Conversation,
incomplete, and non-Conversation evidence stays out of the grant.

Project ownership and Team role are separate authority bindings. The Team-side
Project owner is `workspace_projects.owner_team_member_id`; this does not
promote that member to Team role `owner`. Project-specific actions are
authorized against the Project owner binding and current Team and Workspace
authority. Team governance and the last-Team-owner check use Team membership
role. A Project owner therefore cannot satisfy or bypass the last-Team-owner
guard by virtue of Project ownership.

## Delete and forget

The Conversation owner may delete or forget that Conversation. The source
uploader or Project owner may delete a Project Source. Deletion hides an item
through its soft-delete lifecycle; forgetting separately removes eligible
Personal Memory from recall. A soft delete is not a forget, and a forget is
not a Project lifecycle freeze.

### Delete a Conversation

Deleting a Conversation hides it from active lists while its Personal Memory
stays in recall. The Team backend freezes only that Conversation's affected
Share Grants at the last actually published revision and complete immutable
authorized representation closure. Published material remains recallable under
existing authorization; later messages and revisions are excluded. The grants
are not revoked, and owner consent is unchanged. If an Agent is still working
in the Conversation, ask for confirmation and then stop it. If the Conversation
is a Scheduled Job's own chat, pause that job. Show an Undo toast; restore is
available from Settings → Deleted for 30 days and does not resume grant
advancement.

### Delete a Project Source

Deleting a Project Source hides it using its own trash state and retains its
Note revisions. Personal Memory stays in recall. The Team backend freezes only
grants for that source at their last published authorized closure. Published
material remains recallable under existing authorization; later revisions are
excluded. The grants are not revoked. A Project Source never uses
`sessions.personal_deleted_at`. This source-only action does not stop Agent
work or change Scheduled Jobs.

### Delete a personal Project

The Project owner soft-deletes the personal Project, its HQ Conversation,
Conversations, Work Items, Project Sources, and Decks as one batch. Personal
Memory assertions remain and keep the Project label. After confirmation, stop
Agent work running in the Project. Pause its Scheduled Jobs. Show an Undo
toast; the whole batch can be restored for 30 days. Restored jobs stay paused.

### Forget a Conversation, source, or Memory item

Forgetting a Conversation uses the existing Personal deletion path
(`personal_deleted_at`): it removes the Conversation from Personal recall and
suppresses assertions whose only sources are in that Conversation. Forgetting
does not itself revoke an active Share Grant or perform the Project lifecycle
freeze. Previously shared material remains governed by its grant and the
existing suppression, revocation, and retention rules.

After confirmation, stop Agent work in a forgotten Conversation and delete any
Scheduled Job whose own chat it is. The target lifecycle specifies a seven-day
Undo for forgetting a Conversation; this does not assert that the current app
exposes that Undo path.

Forgetting a Project Source removes the actual Personal Note revision content
through the Note revision forget or suppression path. Its trash state remains
independent and does not stop Agent work or change Scheduled Jobs. Undo follows
the Note revision path; this lifecycle does not assign that path a time window
or claim that it is currently available in the app. Forgetting a Memory item
suppresses the assertion; a shared `curated_assertions` representation is
unavailable to Team recall when its source assertion is suppressed. The target
lifecycle specifies a seven-day Undo for unsuppressing an assertion for the
same User; if its grant remains active and authorized, unsuppression permits
the assertion to be shared again. It does not silently restore a revoked
grant. These target Undo windows are not claims about current app availability.
Forgetting a Memory item does not stop Agent work or change Scheduled Jobs.

## Make private and delete a shared Project

### Make a Conversation private

The Conversation owner can mark it private while keeping it in their Project.
The Project Share Policy then excludes it and revokes its policy-created grant.
Revocation removes Team visibility under existing revocation and retention
rules; it does not freeze the grant. An unrelated grant for the same source
follows its own lifecycle. Sharing again requires a new explicit share action
and the normal confirmation. Making a Conversation private does not stop Agent
work or change Scheduled Jobs.

### Delete a shared Project

The Project owner can soft-delete the shared Project. Its Work Items, source
metadata, and decks disappear for everyone, and its Project Thread is archived.
Members' own Conversations move to Just me; their Personal Memory stays with
each owner. The backing Workspace is not archived and Share Grants are not
revoked. Each affected grant is atomically frozen at its last published
revision and complete immutable authorized closure. Published evidence remains
in Team recall under existing authorization and is labelled with the Project
name; future content and revisions are excluded. Members' Agents keep running
in their own Conversations, but their progress is no longer posted to the
deleted Project. Pause its Scheduled Jobs for everyone.

The Project owner may restore within 30 days if they still have access and the
container exists. Restoration brings back the Project records and thread but
does not resume grant advancement or member Conversation sharing. A new grant
or another explicit sharing action is required to advance again.

## Leave and remove access

### Leave a shared Project

A member may leave one Project without leaving the Team. Their Workspace
Access for that Project is disabled, the Project leaves their sidebar, and
their own Conversations move to Just me. The backend freezes this member's
affected grants at their last published authorized closure. Other members
retain access to published evidence under existing authorization; the leaver
loses access to other members' Team memory in that Workspace. There is no
Undo; returning requires a new Project invite. Agents continue in the member's
own Conversations, but progress is no longer posted to the Project. Pause that
member's Scheduled Jobs in the Project.

### Leave a Team

Before any copy-back or destructive change, the Team backend validates leave
eligibility. If leaving would remove the last member with Team role `owner`,
the operation is refused until the existing ownership-transfer workflow is
complete. Project ownership does not satisfy or bypass this guard.

For each Project the departing member owns, copy its records back idempotently.
Remove those scoped records from the Workspace only after copy-back succeeds
and version and authority are revalidated. Then disable that member's
Workspace Access for the affected Workspaces, and disable their Team Membership
last. Grants affected by the member's departure are frozen at their last
published authorized closure. Other members keep already-published material
under existing authorization. Agents continue in the member's own
Conversations. Pause Scheduled Jobs in the Projects removed from the member.
Leaving has no Undo; return requires a new Team invite.

A failed or interrupted copy-back does not authorize removal of the Workspace
records or disablement of Team Membership. Retry the same idempotent operation
after revalidating version and authority. Do not begin destructive removal
while a copy-back is incomplete.

### Remove a member from one Project

The Project owner may remove a member by disabling only that member's Workspace
Access. This does not remove global Team Membership. The member's affected
grants are frozen at their last published authorized closure; other members'
grants are unchanged. A new Project invite restores access, but does not resume
frozen grants. This access-removal action does not stop Agent work or change
Scheduled Jobs.

## Freeze, restore, and authorization

For deletion and member departure, a freeze is scoped to each affected Share
Grant. It pins the last complete, actually published revision; unpublished
work does not become visible. The Team backend serializes the freeze against
in-flight advancement so one transaction determines the pinned revision. The
exact source owner or a narrowly authorized Project lifecycle action may
request it, including while the source owner's Desktop is offline. Freezing a
grant does not revoke a Cross-Identity Sync relationship that may serve other
grants.

A frozen grant keeps its published representation and existing consent. It
stops future advancement; it does not itself end Team recall. Revocation,
suppression, expiry, Workspace Access, retention, and other current policy
checks continue to apply. Restoring a Conversation, Project Source, Project,
Workspace, or membership does not resume a frozen grant, recreate a revoked
grant, or re-enable sharing. A new grant or explicit owner sharing action is
required before future content can advance. Where an action offers restore,
only the deleter or Project owner may restore it while the applicable restore
window is open, the container still exists, and they retain access.
Conversation and shared Project restore are available for 30 days. The target
Undo window is seven days for forgetting a Conversation and unsuppressing a
Memory item; forgetting a Project Source follows its Note revision path's own
window.

## Implementation boundary

These rules specify behavior, not routes, database columns, or a particular
API. A Project lifecycle operation must not claim success until the
authoritative Team backend has completed the required grant and access
changes. Existing code for explicit Share Grants, personal forgetting,
Workspace Access, or source access must not be treated as an implementation of
the Project Share Policy or its lifecycle freeze.

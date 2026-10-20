# Project-Sharing Lifecycle

This document records the accepted target behavior for Project-backed
Workspaces and Project Share Policy in [ADR 0057](./adr/0057-project-backed-workspaces-and-project-share-policy.md).
The terms Project, Workspace Project, HQ Conversation, Project Source, Work
Item, Flashcard Deck, Scheduled Job, and Project Thread use the canonical
definitions in [CONTEXT.md](../CONTEXT.md#language). In this document, **Just
me** means the owner's private Project and Conversation view; it does not mean
that Team-shared Memory changes owner or sets a Memory assertion to
`scope = me`. This is a contract for implementation;
it does not mean that the described Project sharing or lifecycle operations are
available in the product today.

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
Personal Note revision model is defined in
[ADR 0032](./adr/0032-first-class-revisioned-personal-notes.md). The repository
also supports local Project-to-Workspace mapping for recall. That
mapping does not create a shared Project or sharing authority
(`docs/team-workspace-project-mapping.md`).

The shared Project entity, Project Share Policy, Project-owner lifecycle, and
Project deletion behavior below still require implementation. The exact
owner-reviewed `shared_memory.grant.freeze` route and immutable published
closure are implemented. Current Team leave, member disable, and Workspace
Access disable freeze affected grants atomically. The backend-only
`project.lifecycle.freeze_grant` binding fails closed until an authoritative
Workspace Project parent exists; it is not an independent route. Project
lifecycle behavior must not be inferred from local Project mapping.

## Sharing and ownership

Each shared Project has one dedicated Team Workspace and a distinct
Workspace Project identity. The Workspace Project links participating Users'
own Projects; it does not replace those Personal Projects or take ownership of
their Conversations, sources, or Personal Memory. This does not constrain
ordinary Team Workspaces or local Project-to-Workspace mappings used for
recall.

Each member's own Desktop applies the Project Share Policy only to that
member's own eligible Conversations. At join, the member reviews the
summary-sharing disclosure and explicitly enables a versioned policy through
the target Native-review `shared_memory.project_share_policy.enable` action.
This durable owner consent is separate from the expiring, single-use UI Action
Grant that records the enable decision. Bind it to the source owner, current
enrolled device credential generation and backend origin, Team, Workspace,
exact Workspace Project, the owner's exact Personal Project, and `lcm_leaves`
fidelity. It grants no other member's sources, Curated Memory, raw
`memory_events`, or Conversation Source Access. Credential rotation or
re-enrollment, backend or source-owner change, Project-link change, or a
mismatch between the bound policy scope and source mapping fails closed and
requires new reviewed consent. A newly captured Session may use a new exact
mapping under the same current scope only through the Bundled stage; a changed
or ambiguous existing mapping receives no inherited authority and requires a
fresh source/share decision.

The policy excludes the Project's HQ Conversation and Conversations the owner
marks private. It does not introduce a Conversation grant type. Each resulting
Share Grant binds to one exact owner-owned Captured Session. When the owner
enables the policy, the owner's trusted local edge builds a bounded candidate
manifest from authoritative local capture and Project state for currently
eligible Captured Sessions whose Conversations are already associated with the
exact shared Project. Before Native review binds the issuance set, the Team
Backend validates authenticated source-owner/device provenance, the exact
Project link, current policy scope, source/mapping versions, and destination
state. It excludes any Session whose `(logicalMemoryId, teamWorkspaceId)`
destination already has a Share Grant row in any lifecycle state or an
unresolved Pending Share operation. Native review binds consent to the
remaining exact Session IDs, source revisions, trusted Conversation-to-session
mapping revisions, and approved summary scope. The renderer cannot supply or
alter the candidate or filtered set. The remote Team Backend never reads the
owner's Personal database. Existing destinations are skipped without adopting,
mutating, or renewing their grant or Pending Share consent; frozen or revoked
grants and private, moved, or deleted sources cannot be restarted. If an
independent authorized grant or Pending Share operation wins a race after
review, serialize against destination uniqueness and skip that destination
without failing the batch. Retries use the same operation identity and are
idempotent. Any source, mapping, or policy-scope drift still conflicts and
requires new review; the initial batch must not widen or backfill a different
set.

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
existing protocol. The representation remains unavailable while staging;
activation publishes it and activates the Share Grant together only after the
complete, immutable, authorized, sanitized `lcm_leaves` closure and current
authority checks pass.
Missing, partial, or unsanitized content remains unavailable and cannot be
exposed. Activation rechecks the exact source and Project link, Pending Share
consent and operation binding, and current lifecycle/freeze state while
serialized against freeze, delete, private, and leave actions. A freeze or
tombstone that wins prevents an earlier Pending Share from publishing new
material; if no revision was previously published, the frozen grant exposes no
bytes. See [Asynchronous semantic sharing](self-hosted-to-hosted-sync.md#asynchronous-semantic-sharing)
for the existing Pending Share and activation protocol.

While the versioned policy remains active, newly captured eligible Sessions
may also receive a grant through that Bundled stage only if their Conversation
was already associated with the exact shared Project at capture time. A
trusted source mapping must resolve the Conversation to exactly one supported
Captured Session. The Team Backend verifies the owner/device source
association, current membership and Workspace Access, Project link, policy
version and scope; eligibility cannot come from a renderer-supplied path,
Project flag, or arbitrary source ID. Before authorizing the Session, the Team
Backend skips a destination that already has a Share Grant row in any lifecycle
state or an unresolved Pending Share operation. A concurrent authorized
operation that wins destination serialization is also skipped, never adopted
or treated as a batch failure; retries keep the same operation identity. The
stage is separate from a generic UI Action Grant, cannot authorize another
source or later operation, and preserves the existing Pending Share state
machine and safe-activation protocol. Each activated grant can advance only
its bound Session under its own consent and lifecycle.

An existing Conversation moved into the shared Project after policy enablement
does not add its already-captured Sessions to the reviewed initial set or make
them eligible for future policy issuance; the owner separately confirms
sharing of each exact source through `shared_memory.pending_share`. An
ambiguous mapping or multiple candidate Sessions creates no grant. Creating a
Conversation in a shared Project is not itself a grant. Frozen, revoked,
private, moved, or deleted sources lose policy eligibility. Restoring,
rejoining, or moving a source back does not recreate or restart a grant; a
fresh source/share decision is required. The source owner may disable the
policy using the target Native-review
`shared_memory.project_share_policy.revoke` action bound to the current policy
version. Revocation disables future policy-based issuance only. Existing
grants continue to advance under their own consent and lifecycle; policy
revocation does not revoke, freeze, or change their advancement or published
evidence. Freezing or revoking an existing grant to stop advancement or remove
access remains a separate action. These enable, apply, and revoke actions are
target behavior and are not implemented today.

Project Sources are shared only through each uploader's own supported grants;
the Project Share Policy does not grant another member's Conversations or
source revisions. A Project Source's Team metadata remains distinct from its
owner's Personal Note content and revisions. The policy changes recall
authorization; it does not transfer ownership or create a Fork/Import.
Cross-Identity Sync remains a separate relationship under ADR 0004.

Policy-created grants use `lcm_leaves`, so Project members receive summaries.
The policy never creates Conversation Source Access. An owner may separately
enable that capability for the exact Captured Session through the Step-up flow
in ADR 0024. The Team receives only ADR 0047's separately encrypted,
sanitized Conversation Source Artifact and verified segments allowed by the
Team-audience presentation policy. Conversation Source Access never authorizes
the owner's raw private journal, and values redacted by the Team-audience
policy remain unavailable. The Project disclosure does not authorize
`curated_assertions`. An initial Pending Share that enables Curated Memory
requires separate disclosure and Step-up, as does later enablement; Full access
does not bypass the requirement.

An eligible assertion has a complete, non-empty active direct-source set made
only of direct sources from the exact granted Captured Session, with all active
provenance resolving inside that session. A single matching source is
insufficient if another active source falls outside the session or provenance
is incomplete. It must also have `scope = project` and resolve to the matching
owner-owned Project linked to the Workspace Project. Me-scoped, unscoped,
mixed-session, and non-Conversation evidence is ineligible. Project/scope
changes invalidate affected Team representations and vectors transactionally
before the Personal change commits.

Project ownership and Team role are separate authority bindings. The Team-side
Project owner is `workspace_projects.owner_team_member_id`; this does not
promote that member to Team role `owner`. Project-specific actions are
authorized against the Project owner binding and current Team and Workspace
authority. Team governance and the last-Team-owner check use Team membership
role. A Project owner therefore cannot satisfy or bypass the last-Team-owner
guard by virtue of Project ownership.

## Delete and forget

The Conversation owner may delete or forget that Conversation. The source
uploader or Workspace Project owner may delete Team-side Project Source
metadata; only the source owner controls the Personal Note content. Deletion
hides an item through its soft-delete lifecycle; forgetting separately removes
eligible Personal Memory from recall. A soft delete is not a forget, and a
forget is not a Project lifecycle freeze.

### Delete a Conversation

Deleting a Conversation is a local, owner-controlled action. It hides the
Conversation from active lists while its Personal Memory stays in recall; it
does not require Team enrollment or browser approval when no Team grant is
affected. For each active Team Share Grant attached to its exact Captured
Session, the source owner uses the target per-grant
`shared_memory.grant.freeze` Native-review action and waits for every required
Team freeze before reporting deletion complete. This Personal deletion caller
is still pending. The Team operation pins the last
actually published revision and complete immutable authorized representation
closure. Published material remains recallable under existing authorization;
later messages and revisions are excluded. The freeze does not revoke the
grant or change owner consent. If an Agent is still working in the Conversation,
ask for confirmation and then stop it. If the Conversation is a Scheduled
Job's own chat, pause that local job. Show an Undo toast; restore is available
from Settings → Deleted for 30 days and does not resume grant advancement.

### Delete a Project Source

Deleting Team-side Project Source metadata is a Team action through
`project_source.team_metadata.delete` with Step-up approval. Its Team-authority
workflow freezes grants for the exact source revisions before deleting the
metadata. It does not delete the uploader's Personal Note content or revisions;
only the source owner can trash or forget that Personal data through the local
Note lifecycle. If local Note trash affects active Team grants, the source
owner separately requests each required target `shared_memory.grant.freeze`
Native-review operation and waits for those Team operations before reporting
the local trash complete. The local trash caller is still pending. A purely
Personal Note operation needs no Team enrollment or browser approval. Published
Team material remains recallable under existing authorization and later
revisions are excluded. Source trash state is separate from Note revision
forget state; a Project Source never uses `sessions.personal_deleted_at`. This
source-only action does not stop Agent work or change Scheduled Jobs.

### Delete a personal Project

The owner soft-deletes their Personal Project through a local owner-controlled
action. It does not require Team enrollment or browser approval. The batch
includes its HQ Conversation, Conversations, Work Items, Project Sources, and
Decks as one batch. Before reporting success, freeze every active Team grant
attached to a child Conversation's exact Captured Session or a supported
Project Source Note revision when its adapter is available. The source owner
requests `shared_memory.grant.freeze` Native review for each exact grant,
including explicit grants created outside the Project Share Policy. HQ-202
implements the Personal Project deletion caller for Captured Sessions and
waits for every required Team freeze
before reporting deletion complete or purging child records. Personal Memory
assertions remain and keep the Project label. After confirmation, stop local
Agent work running in the Project and pause its Scheduled Jobs. Show an Undo
toast; only the Personal Project owner may restore the batch, for 30 days.
Restored jobs stay paused, and restored sources, Conversations, or Projects do
not resume any frozen grant. A retry is idempotent; already-completed freezes
stay in place.

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
through the Note revision forget or suppression path. Its Team metadata trash
state remains independent and does not stop Agent work or change Scheduled
Jobs. Undo follows the Note revision path and is available only to the source
owner; this lifecycle does not assign that path a time window or claim that it
is currently available in the app.

Forgetting a Memory item suppresses the assertion; a shared
`curated_assertions` representation is unavailable to Team recall while its
source assertion is suppressed. The target lifecycle specifies a seven-day
Undo for unsuppressing an assertion for the same User. For an unfrozen grant,
unsuppression may restore eligibility under that grant's existing consent,
provenance, representation, and policy checks. For a frozen grant, Undo can
restore Team recall only for a representation already included in that grant's
pinned closure. If the assertion was absent when the grant froze, unsuppression
restores Personal recall only; it cannot advance or add the assertion to the
frozen grant. These target Undo windows are not claims about current app
availability. Forgetting a Memory item does not stop Agent work or change
Scheduled Jobs.

## Make private and delete a shared Project

### Make a Conversation private

The Conversation owner can mark it private while keeping it in their Project.
This is a local owner-controlled change. If it withdraws an existing
Project-policy Share Grant, the owner separately authorizes its revocation
through the existing `shared_memory.revoke` Native review and waits for that
Team operation; an unrelated grant for the same source follows its own
lifecycle. Revocation removes Team visibility under existing revocation and
retention rules; it is distinct from freezing future advancement. Making a
Conversation private does not require Team enrollment when there is no grant,
and does not stop Agent work or change Scheduled Jobs. Sharing again requires a
new explicit share action and the normal confirmation.

### Delete a shared Project

The Workspace Project owner deletes the shared Project through the
Team-authoritative `workspace_project.delete` Step-up action in ADR 0024. The
Team Backend atomically tombstones the Workspace Project, invalidates its
Project links, freezes each affected grant and attached continuous source
frontier, archives the Project Thread, and stops accepting Project progress.
It soft-deletes the Team Work Items, Project Source metadata, and Decks. The
operation does not archive the Workspace or revoke grants. It can complete
while source owners' Desktops are offline and does not write to their Personal
databases. Published evidence remains available to members who retain
Workspace Access, under existing authorization, and later messages and
revisions are excluded.

Each member's own Desktop detaches their own Conversations to Just me and
pauses their own Project Scheduled Jobs when it reconciles the authoritative
Project tombstone, before that member can use the shared Project again. A
Project-scoped job checks the authoritative Workspace Project lifecycle before
dispatch; if the Project is tombstoned or its state cannot be confirmed, the
job fails closed and does not run. A member's Agent may continue in a detached
Personal Conversation, but it cannot post to the deleted Project.

Only the Workspace Project owner may restore the Team-side Project metadata and
thread within 30 days, while they retain current Team membership and required
Workspace authority. Restoration does not restore or expose another User's
Personal Project or Conversation, resume grant advancement, or recreate member
sharing. A new grant or another explicit sharing action is required to advance
again.

## Move a Conversation out of a shared Project

Moving a Conversation out of a shared Project is a local owner-controlled
action; it does not need Team enrollment if no Team grant is affected. Before
detaching, the source owner uses the target per-grant
`shared_memory.grant.freeze` Native-review action for each old Project-policy
grant and waits for those Team freezes. This local move caller is still pending.
Each freeze also pins any attached
continuous Conversation Source Access frontier. The old grant and previously
published Team material remain under their existing authorization unless the
owner separately revokes that exact grant. A new shared destination requires a
separate confirmation and an exact Captured Session mapping. Moving back or
restoring the old Project never resumes the frozen grant; a new grant is
required to advance again.

## Leave and remove access

### Leave a shared Project

A current non-owner member may leave one shared Project without leaving the
Team through the target Step-up `workspace_project.leave` self-service action
in ADR 0024. The Team Backend rejects the Workspace Project owner; the owner
must use the explicit Step-up `workspace_project.delete` lifecycle or a
separately accepted ownership-transfer action. This contract does not define a
transfer action. Leave disables only the caller's access to this Workspace
Project; it does not remove global Team Membership or affect another member.
The Team Backend invalidates only the caller's Project link, freezes only their
affected grants and attached continuous source-access frontiers, and stops
accepting their Project progress. These are target effects and are not
implemented today. It does not write to the caller's Personal database. On
reconciliation, that member's Desktop detaches their own Conversations to Just
me and pauses their own Scheduled Jobs before using the shared Project again.
Project-scoped jobs check the authoritative Workspace Project lifecycle before
dispatch and fail closed if access or lifecycle state cannot be confirmed.
Other members retain access to published evidence under existing
authorization; the leaver loses access to other members' Team Memory in that
Workspace. There is no Undo; returning requires a new Project invite. The
member's Agent may continue in detached Personal Conversations, but progress
is no longer posted to the Project.

### Leave a Team

Before any copy-back or destructive change, the Team Backend validates leave
eligibility. If leaving would remove the last member with Team role `owner`,
the operation is refused until the existing ownership-transfer workflow is
complete. Project ownership does not satisfy or bypass this guard. The current
`team.leave` action uses Native review, but that approval cannot authorize the
Step-up deletion of an owned Workspace Project.

In the target flow, the Team Backend derives the complete set of Workspace
Projects currently owned by the departing member. If the set is empty, ordinary
leave remains Native review. If the set is non-empty, the exact `team.leave`
operation escalates to Step-up before any copy-back, tombstone, or destructive
change. The browser review binds the Team and exact membership version, the
complete owned-Project ID/version set, and every associated copy-back,
tombstone, and removal effect. The Backend checks last-owner eligibility first,
then rechecks membership, ownership, the complete set and versions, and current
authority when consuming approval. A changed membership, ownership, Project
set, version, or authority invalidates the approval. Return a conflict and
require a new exact review; do not retry or begin copy-back under stale
authority. This conditional Step-up approval does not grant wildcard Project
authority.

After exact authorization, the departing member's own Desktop copies their
authorized records from each Workspace Project they own back to their Personal
Project, idempotently. The Team Backend never writes another backend's Personal
database. Only after copy-back succeeds and Team version and authority are
revalidated may the Backend remove the member's Project link and scoped Team
metadata. Previously published Team representations are retained under their
grants for other authorized members.

For every Workspace Project linked to the departing member, including Projects
they do not own, the Team Backend invalidates only that member's Project link,
freezes their affected grants and attached continuous source-access frontiers,
stops accepting their Project progress, and denies dispatch of that member's
Project-scoped Scheduled Jobs. These authority changes do not wait for the
member's Desktop and do not write to any Personal database. On reconciliation,
the departing member's own Desktop detaches their own Conversations to Just me
and pauses their own Project Scheduled Jobs before using a linked Project
again. Other members retain published material under existing authorization
and keep their own links, grants, progress, and jobs unless an owned Project is
tombstoned.

If an owned Project is removed, the approved operation tombstones that exact
Workspace Project, freezes all of its affected grants and continuous source
frontiers, invalidates its remaining Project links, archives its Project
Thread, and stops accepting all Project progress. It does not archive the
Workspace or revoke grants; remaining members retain already-published Team
Memory under existing authorization, while later revisions are excluded. Each
member's own Desktop detaches their own Conversations to Just me and pauses
their own Project Scheduled Jobs when it reconciles the authoritative
Project tombstone, before that member can use the shared Project again. The
Team operation does not wait for offline Desktops. Project-scoped jobs check
authoritative lifecycle before dispatch and fail closed if the Project is
tombstoned or lifecycle authority cannot be confirmed.

After successful copy-back and Workspace Project cleanup, disable the departing
member's Workspace Access for affected Workspaces, then disable their Team
Membership last. Lifecycle freezes are Bundled stages of the exact authorized
leave operation and receive no separate approval. Leaving has no Undo; return
requires a new Team invite. [ADR 0060](./adr/0060-in-app-team-invites.md)
defines the target generation-bound
invitation and rejoin checks; rejoining a `member_left` membership is not
implemented until HQ-703 lands the leave-generation and invite-validation
invariant. A failed or interrupted copy-back, Team cleanup, or authority
revalidation does not authorize removal of Workspace Project records or Team
Membership. Do not report leave as complete while copy-back or a required Team
lifecycle stage is incomplete.

### Remove a member from one Project

The Workspace Project owner may remove another member through the target
Step-up action in ADR 0024. `workspace_project.member_remove` rejects the
Workspace Project owner as its target, including self-removal; the owner uses
the explicit Step-up `workspace_project.delete` lifecycle instead. No ownership
transfer action is defined here. Removal disables only the named member's
Workspace Access for this Project and does not remove global Team Membership.
The Team Backend freezes only that member's affected grants and attached
continuous source-access frontiers at
their last published authorized closure, invalidates only that member's
Workspace Project link, and stops accepting their Project progress. It does not
write to the member's Personal database. On reconciliation, the member's own
Desktop detaches their Conversations to Just me and pauses their own
Scheduled Jobs before using the shared Project again. Their Agent may continue
in detached Personal Conversations without posting Project progress. Other
members' grants and progress are unchanged. A new Project invite restores
access, but does not resume frozen grants.

## Freeze, restore, and authorization

A freeze is scoped to each affected Share Grant. It pins the last complete,
actually published semantic revision and immutable authorized representation
closure; unpublished work does not become visible. The Team backend serializes
the operation against in-flight advancement so one transaction determines the
pinned boundary. For a Personal command that affects a Team grant, the exact
source owner explicitly requests each per-grant freeze through Native review
and waits for it before the Personal command reports completion. The Personal
callers are still pending. A Team lifecycle freeze is a Bundled
stage only of an exact allowlisted outer Team action and inherits that action's
target, authority, request binding, and approval; callers cannot request the
stage independently. Current Team parent actions use this freeze while the
source owner's Desktop is offline; Workspace Project parents remain pending.
When an affected browser Team lifecycle request needs that freeze, the
existing browser route returns an explicit Action Grant requirement. The
reviewed, exact one-use Action Grant path performs the freeze and parent
mutation together; browser requests with no affected unfrozen grant keep their
existing behavior.

If the grant has attached continuous Conversation Source Access, the same
atomic operation pins its last authorized sanitized source generation and
segment frontier. No later generation or source segment can be read through
that capability. This does not grant, revoke, or change source-access consent.
Its independent expiry, revocation, membership, Workspace Access, and
Team-audience policy checks still apply. Snapshot source access remains pinned
to its existing snapshot. Unrelated grants and Cross-Identity Sync relationships
are unchanged.
An empty published source has a pinned zero-segment frontier and remains
readable as empty metadata. If no sanitized source was published, the internal
source capability is `frozen_empty`: it exposes no bytes but remains separately
revocable by its owner. The strict v1 Source Access lifecycle reports that
unrevoked state as `active` with its current version, so an owner can review
and revoke the exact capability without treating freeze as revocation.

A freeze keeps the grant's consent and published representation, stops future
advancement, and does not itself end Team recall. Revocation, suppression,
expiry, Workspace Access, retention, and other current policy checks continue
to apply. A frozen grant cannot advance even if its source changes or an
assertion is unsuppressed. Suppression Undo can restore Personal recall and can
restore Team recall only for an artifact already present in that grant's pinned
authorized closure. If the assertion was suppressed and absent when the grant
was frozen, Undo cannot add or publish it to the frozen grant. An unfrozen
grant remains subject to its existing consent, provenance, representation,
and policy checks.

For published Curated items, the Team stores only a grant-scoped pseudonymous
item ID, its pinned revision hash, and mutable eligibility markers. The source
owner's existing Curated mutation transaction blocks the exact copied item
before suppression commits. Undo clears that marker only when the owner-side
current assertion still has the same content, evidence provenance, and Session
scope as the pinned item. Team recall verifies the copied ciphertext and hash
before filtering blocked items; semantic search and citation expansion use the
same marker. An assertion added after freeze has no copied item. Older
published Curated items without a per-item revision hash remain readable until
an owner mutation blocks them, then stay blocked unless an owner-authorized
path can prove the exact pinned revision. Source evidence invalidation blocks
the affected Session's copied Curated items until owner reconciliation proves
their eligibility. Neither a Team reader nor an offline Team lifecycle action
reads the owner's Personal store to decide this state.
Semantic embedding jobs may finish or refresh vectors for the already copied,
fixed Team-safe items after freeze. They recheck current authorization and
privacy before storing a result; only derived embedding state and vectors may
change. The pinned source identity, ciphertext, item set, and content hashes
cannot advance.

Restoring a resource does not resume a frozen grant, recreate a revoked grant,
or re-enable sharing. A new grant or explicit owner sharing action is required
before future content can advance. Restore authority is resource-specific:

- Only the owner of a Personal Conversation may restore that Conversation.
- Only the owner of a Personal Project may restore that Project and its
  Personal children.
- Only the Workspace Project owner may restore Team-side Project metadata and
  its Project Thread, while that owner retains current Team membership and
  required Workspace authority.
- The Project Source uploader or Workspace Project owner may restore its
  Team-side metadata while they retain current authority. Only the uploader
  may restore or expose the Personal Note content and revisions.
- Workspace restoration and Team membership or Workspace Access restoration
  follow existing Team governance, invitation, and access-update rules. A
  Project owner cannot restore Team membership or another User's Personal
  resource.

Personal Conversation, Personal Project, and Personal Note restores are local
owner controls; they do not require Team enrollment or browser approval. Team
metadata restores use Direct access only within the owner and current-authority
bounds above. The target `workspace_project.restore` and
`project_source.team_metadata.restore` actions follow those bounds. Existing
`team.workspace.restore` remains Direct under its Team authorization checks;
an invite or access expansion keeps its existing Team action and tier. Restores
never override suppression, revocation, expiry, or other current
authorization.

Conversation and Project restore windows are 30 days. The target Undo window is
seven days for forgetting a Conversation and unsuppressing a Memory item;
forgetting a Project Source follows its Personal Note revision path's own
window. These target windows do not claim that the current app exposes those
paths.

## Implementation boundary

HQ-202 local Personal Project deletion uses a durable batch and admission
generation for each exact Captured Session source on every known Team backend.
The backend serializes first grant admission and later activation against the
same source ledger. An old approved preview or Pending Share cannot activate
after preparation, including when a replacement preview is supplied. Existing
grants continue their unrelated activity until each exact grant receives its
own Native-review freeze. Sealing acknowledges that no unfrozen grant remains;
transport uncertainty is retried from status and never treated as success.
The local owner can restore within 30 days while offline. Restore keeps frozen
grants frozen and old Pending Shares stale, then durably reconciles release of
only that batch's source hold. A later explicit share goes through fresh normal
review at the new source generation. A second delete waits for outstanding
release acknowledgments before claiming a new batch.

These rules specify behavior, not routes, database columns, or a particular
API. A Team-authoritative Project lifecycle operation must not claim success
until the Team Backend has completed its required grant and access changes. A
Personal command remains a local owner operation; when it affects a Team grant,
it must wait for the exact owner-authorized freeze or revocation to complete
before reporting success. The exact freeze route and HQ-202 Personal Project
coordinator exist; Project Share Policy and the Workspace Project lifecycle do
not. Existing code
for personal forgetting, Workspace Access, or source access does not implement
those pending Project workflows.

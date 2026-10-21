# Shared Project State

Status: Workspace Project state and lifecycle are implemented under
[ADR 0062](./adr/0062-shared-project-state.md). Deck/card storage and
collaboration routes, the human-only Project Thread, Project Share Policy,
Deck study, and Again learning are implemented. Full two-user live Project
validation remains follow-up work under HQ-713.
Workspace Project Work Items, Source metadata, activity, member associations,
and exact Project lifecycle actions use the Team backend; binaries, extracted
Personal Note revisions, Conversations, and execution state stay Personal.

This document applies the accepted D1, D4, and D9 outcomes. It does not change
ADR 0004's user-owned memory model, ADR 0013's Team Chat boundary, ADR 0057's
summary-only Project Share Policy, ADR 0059's Personal Project identity, or the
human-only Project Thread decision in D2. For complete delete, forget, leave,
freeze, and restore behavior, see [Project-sharing lifecycle](./project-sharing-lifecycle.md).

## Identity and data placement

A **Personal Project** is one User's container for their own Conversations,
sources, and work. A **Workspace Project** is the separate Team-side identity
for a shared Project. The Workspace Project has its own ID, Workspace, display
name, key, lifecycle, version, and owner binding. Its owner is
`workspace_projects.owner_team_member_id`.

Project ownership is independent of Team role. A Workspace Project owner may
have Team role `member`; Team role `owner` does not make a User the owner of
every Workspace Project. Creating, sharing, or owning a Project never promotes
a member to Team role `owner`. Team-wide administration and the last-Team-owner
guard continue to use Team Membership role.

Each participating member has their own Personal Project linked to the
Workspace Project. The member's private Personal Project-to-Workspace Project
mapping lives in that member's Personal backend and local configuration.
Separately, the Team Backend records authoritative per-member Workspace
Project association and access by Team Member ID and Workspace Project ID,
without a Personal Project ID or Personal-backend identifier. Existing Share
Grant records retain their required logical memory ID, User ID, and source-owner
provenance. Each member's private HQ Conversation belongs to their own Personal
Project.

The local Project-to-Workspace mapping in
`KOED_HOME/config/project-team-workspaces.json` is a recall-routing setting.
It is not the member's Workspace Project link. It does not create a shared
Project, select Project ownership, create a Share Grant, or authorize a Team
operation. The private Personal Project mapping and the Team-authoritative
per-member association are separate from this routing setting. See
[Team Workspace Project Mapping](./team-workspace-project-mapping.md) and
[Personal Project Identity](./personal-project-identity.md).

| Record or content                                                                                  | Location                                  | Ownership and rule                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Work Items, Decks and cards, Project Source metadata, activity, Project Thread                     | Team Backend, under the Workspace Project | Shared collaboration state; these records are not Memory.                                                                                       |
| Conversations, Captured Sessions, Memory Events, Curated Memory, Personal Notes and Note revisions | The owner's Personal backend              | Remain owned by the originating User. Share only through that owner's current consent and grant authority.                                      |
| Project Source binary and extracted text revisions                                                 | The uploader's Personal storage           | Original binary remains encrypted. Each extracted revision is a real Personal Note revision, not a Team-owned copy or generic Note-like record. |
| Private HQ Conversation, Agent state, Deck progress and last-seen cursor                           | Each member's Personal backend            | Private to that member, including in a shared Project.                                                                                          |

## First share

The local Desktop prepares a durable first-share attempt before the Team copy.
It pins the owner Personal snapshot and stops Work Item/Source edits while the
attempt is pending. A retry with the same attempt key reuses that snapshot; a
different attempt conflicts. The Team copy stores the immutable manifest hash,
and the local edge confirms it against the enrolled Team principal before
marking Personal rows moved. A lost confirmation response can be retried.

The initiating Desktop performs an idempotent operation for one Personal Project
and share attempt:

1. Resolve Team and Workspace through the existing authority paths in ADRs
   0013, 0024, and 0057. A share outside a named group uses `team.create`:
   the initiating member becomes Team role `owner`, and the Team's one default
   Workspace serves as this Project's dedicated Workspace. A share to a named
   group uses that existing Team and creates a dedicated Project-backed
   Workspace through `team.workspace.create`; do not reuse an unrelated
   Workspace. A retry may reuse only the Team and Workspace identifiers bound
   to that same idempotent share attempt. These actions remain Direct and keep
   their existing action-grant and Team-management checks. Invitations and
   acceptance remain `team.invite.create` and `team.invite.accept` with Native
   review. Other members' Workspace Access is not expanded implicitly:
   `team.workspace.access_update` retains Step-up for expansion or disable and
   Native review when `write` decreases to `read`. Existing browser
   reauthentication or per-operation confirmation and request-time role checks
   remain in force where required. Then create the Workspace Project and bind
   its owner to the initiating Team member ID. Team creation's owner role is
   distinct from `workspace_projects.owner_team_member_id`; Project ownership
   in an existing Team never promotes a member to Team role `owner`.
2. Copy the Project's collaboration records, Decks, and source metadata to the
   Team Backend. Mark Personal collaboration rows `moved_to_team` and read
   them through their Team records only after the copy is confirmed. Retrying
   the same share operation must not duplicate records or discard the last
   Personal copy before confirmation.
3. Keep every Project Source binary and its Personal Note revisions in the
   uploader's Personal storage. Share only the exact revisions that uploader
   explicitly authorizes through their own Share Grants.
4. Each member independently reviews and enables their own Project Share
   Policy for their own Conversations. The Workspace Project owner does not
   enable policy for other members.

D1's policy-created grants share summaries at `lcm_leaves` fidelity and bind
one exact owner-owned Captured Session. The policy excludes the owner's HQ and
private Conversations. It does not share raw `memory_events`, full
transcripts, Conversation Source Access, Curated Memory, Project Source Note
revisions, or another member's sources. Enabling the policy uses the bounded
versioned consent and trusted-local-edge manifest in ADR 0057. Newly captured
Sessions qualify only while the policy is active and their Conversation is
already associated with the exact shared Project at capture time. Moving an
existing Conversation into the Project later requires a separate exact source
share. Source Access and Curated Memory keep their separate consent and action
tiers.

Workspace Access `write` and `can_share_owned_memory` are granted only
through the existing invitation and Workspace Access paths, under their
current Team authority checks and approval tiers. A Project share does not
silently add Team members or expand their Workspace Access. Those permissions
do not alter Team roles. Every Share Grant continues to have its own source
owner, exact source, destination, consent, revision, and lifecycle.

## Project collaboration records

An explicit `workspace_project_share_grant_bindings` record identifies a
Share Grant created for one Workspace Project. The Team backend binds only a
current grant owned by the acting member in the same Team and Workspace.
Existing independent Workspace grants are never adopted by matching a source
or Workspace ID. Project leave, member removal, and deletion freeze only
bound grants through the verified lifecycle parent; Team leave also freezes
all grants owned by the departing member. This covers bound Captured Session
and Personal Note grants without changing their custody.

Shared Source edits change metadata only. The uploader's Personal backend
attests its own Project Source and current real Personal Note revision before
Desktop attaches metadata to the Team Project. The uploader or Project owner
may rename, trash, and restore metadata; only the uploader may advance the
Personal Note revision link. Mutations advance the Project version and publish
a Team lifecycle/access event.

Work Items, Decks and cards, activity, and the Project Thread are Team
collaboration records; they are not automatically projected into Memory,
indexed for Memory Answer, or ingested into Team semantic recall. The target
contract permits a supported Work Item or Deck/card source adapter to provide
evidence only through authorized Personal Curated intake for that User, with
the supported adapter validating the exact source identity, current visibility,
provenance, and scope. A resulting Personal Curated assertion belongs to that
User. It does not turn the Team record into Memory or make it eligible for
Session-grant sharing automatically; exact-session eligibility still follows
the direct-source rules in [Curated Memory](./curated-memory.md). Work Item and
Deck/card source adapters are target behavior; this document does not claim
they are implemented. Activity and Project Thread messages remain outside
Memory, and Project Thread messages are never Agent input. No generic
Team-record ingestion is authorized. A Deck is shared; a member's study
progress is personal. Activity exposes only the fields defined for
collaboration status.

Sending a Work Item to an Agent is a user action on that member's device. The
Agent works in the sender's Managed Conversation with that sender's
permissions. The Team Backend may receive safe progress such as status,
assignee, agent display name, step label, and PR link/state. It must not receive
Conversation content, tool output, or file contents.

The Project Thread is a human-only Team Chat Thread bound to one Workspace
Project. It is not a Conversation, Captured Session, or Agent thread. Its
messages do not become Memory and are not Agent input, including as quoted
context or HQ catch-up. Human replies and mentions of people remain within
ADR 0013. Documents in the Project Thread are not automatically Project
Sources under D2.

## Source backing and lifecycle

A Project Source has two distinct records:

- Team-side metadata, such as the source's Project association and display
  information and the uploader's Note identity, is collaboration state under
  the Workspace Project. The Note identity links an explicitly selected grant
  to the same Note across revisions; its body stays Personal.
- The original binary and extracted document revisions stay in the uploader's
  Personal storage. The original uses the existing encrypted content
  reference. Each extracted revision is a real owner-owned Personal Note
  revision explicitly linked to that Project Source.

Use the existing Personal Note revision path and supported Note Share Grant
adapter. Each Note revision projects to its own Memory Event; retries are
idempotent per source revision. The existing privacy pipeline and Snapshot or
Continuous Note-grant semantics remain in force. The Team receives only what
the uploader's exact grant authorizes. The Team Backend does not read or write
the uploader's Personal database or call an LLM to synthesize the Note.
Deterministic Team-side materialization and indexing remain within the
[existing asynchronous safe-publication protocol](./self-hosted-to-hosted-sync.md#asynchronous-semantic-sharing).

Trash of Team Source metadata and trash of the Personal source are separate.
The uploader or Workspace Project owner may delete the Team metadata through
the target Step-up `project_source.team_metadata.delete` action, with current
Team and Workspace authority. Its lifecycle freeze stage covers explicitly
bound grants for that exact Note identity before the metadata is tombstoned. This does not
delete or transfer the uploader's Note content. Forgetting a Personal Note
revision follows its Note revision forget or suppression path; it does not
delete Team metadata. A Project Source never uses
`sessions.personal_deleted_at`. Personal Note trash that affects active Team
grants must wait for the uploader's exact required grant freezes before
reporting completion. A Personal Project batch must freeze all supported
child Conversation and Note revision grants, including explicit grants,
before reporting success or purging child records. No Team enrollment is
needed for a purely Personal action with no affected Team grant.

## Ownership, access, and synchronization

Project-specific actions require the Workspace Project owner binding plus
current Team Membership and Workspace authority. Team governance still uses
Team roles. The Workspace Project owner may delete the Team Project or remove
one named, non-owner member. `workspace_project.member_remove` cannot target
the Workspace Project owner, including self-removal. A current non-owner may
leave only their own Project access through the self-only Step-up
`workspace_project.leave`; the Workspace Project owner cannot use it. The
owner uses the explicit Step-up `workspace_project.delete` lifecycle. This
contract defines no ownership-transfer action. The existing manager-only
`team.workspace.access_update` action is not widened and is not a self-leave
path.

Team Project records use the collaboration realtime stream and optimistic
versions. A stale write returns the current record as a conflict. The Desktop
may reapply a simple change only if the same field has not changed elsewhere;
otherwise it refreshes and shows the conflict. When Team service is
unavailable, the shared Project is read-only from the last loaded state. There
is no offline write queue.

The first-share copy accepts at most 500 Work Items, 500 Source metadata
records, and 7,000,000 bytes of serialized copy data. Personal preflight checks
the full snapshot before creating the pending share fence. The Desktop sends
the exact pinned snapshot on retry; neither side truncates records. The Team
copy and local-edge proxy allow an 8 MiB request body to cover its envelope.

A Team lifecycle operation commits its authoritative Team-side effects without
waiting for offline members' Desktops and without reading or writing any
Personal backend. The Team Backend tombstones or invalidates the
Team-authoritative per-member association and access, then stops accepting
that member's Project progress and job dispatch. On reconciliation, each
member's own Desktop clears that member's private Personal Project mapping,
detaches that member's Conversations to **Just me**, and records a durable
owner-local reconciliation receipt before removing the Project link. HQ-601/602
will use that receipt to pause Project Scheduled Jobs and require an authoritative
Workspace Project lifecycle check before dispatch. Those jobs are not yet
implemented. Other members' links, grants, and progress remain
unchanged unless their Project is also tombstoned.

For a member's Agent work, reconciliation atomically advances the private
execution generation, cancels old shared command leases, and records a durable
detach marker before removing the Personal Project link. A Conversation that
already has a private session can receive a later explicit Personal prompt;
reconciliation does not send a prompt or resume Team progress. A shared start
that never established a session stops and requires a new private Conversation.

## Grant freeze and retained memory

A freeze affects one exact Share Grant. It pins the last actually published
revision and the complete immutable authorized representation closure; it
does not revoke the grant or change owner consent. If nothing was published,
freeze exposes no new bytes. The Team Backend serializes freeze against
in-flight advancement, so a committed freeze defines one boundary and no
worker can publish after it.

The exact source owner uses the target `shared_memory.grant.freeze` action
through Native review and waits for every affected exact grant before a local
Personal command reports success. This is not a Team action and does not
require Team enrollment if no active grant is affected. An allowlisted Team
lifecycle action can run the backend-only `project.lifecycle.freeze_grant`
Bundled stage while the source-owner Desktop is offline. That stage inherits
the exact parent action's target, authority, request binding, and approval. It
cannot be requested alone or used as a generic way to change a Personal
record. The only Bundled parent actions are
`workspace_project.delete`, `workspace_project.member_remove`,
`workspace_project.leave`, `project_source.team_metadata.delete`,
`team.leave`, and `team.member.disable`. `team.workspace.access_update` is an
eligible parent only for its existing manager-authorized Step-up disablement
path; access expansion and Native-review `write`-to-`read` reduction are not
eligible. The action remains manager-only and is not a member self-leave path.
Standalone freeze remains Native review for the exact source owner, and restore
is never a Bundled parent. The standalone route and current Team parent stages
are implemented; Workspace Project parent stages await their authoritative
Project routes and state.

For an attached continuous Conversation Source Access capability, the same
atomic freeze pins the last authorized sanitized source generation and
segment frontier. It does not change that capability's consent. Expiry,
revocation, membership, Workspace Access, and Team-audience policy still apply.
Snapshot Source Access, unrelated grants, and Cross-Identity Sync
relationships are unchanged. Source Access never grants the owner's raw
private journal or data redacted by the Team-audience policy.

Published Team Memory remains recallable only while current Share Grant,
Membership, Workspace Access, suppression, expiry, revocation, retention, and
other policy checks allow it. Freeze blocks later revisions but does not end
recall by itself. Revocation remains a separate action that removes Team
authority under existing retention rules. Unsuppression may restore recall
only for a representation already inside the frozen closure. Restoring a
resource never resumes a frozen grant; a new grant or explicit sharing action
is required before new content can advance.

## Project deletion and departure

### Delete the shared Project

The Workspace Project owner uses the exact Step-up `workspace_project.delete`
action. The Team Backend tombstones the Workspace Project, invalidates its
Project links, freezes every affected grant and attached continuous source
frontier, archives the Project Thread, and stops accepting Project progress.
It soft-deletes Team Work Items, Project Source metadata, and Decks. It does
not archive the Workspace or revoke grants. D9 requires already-published
Team Memory to remain at Team level for members who retain current
authorization; later revisions are excluded. Tombstoning invalidates
Project-specific links and access; it does not disable remaining members'
existing Workspace Access to retained Team Memory.

The Team operation can finish while member Desktops are offline. It does not
read or write their Personal databases. It tombstones the Team-authoritative
per-member association and access and stops accepting progress or job dispatch.
On reconciliation, each member's own Desktop clears that member's private
Personal Project mapping, detaches their own Conversations to Just me, and
records an owner-local reconciliation receipt for HQ-601/602 Scheduled Job
cleanup. Only the Workspace Project owner may
restore Team Project metadata and its Project Thread within the target restore
window and with current Team/Workspace authority. Restore does not reattach
Personal Conversations, resume grants, or restore another member's Personal
data.

### Leave or remove access to one Project

The owner removes one other named non-owner member through
`workspace_project.member_remove`. The Team Backend disables only that
member's Workspace Access for that Workspace Project, invalidates only that
member's Project link, freezes only that member's affected grants and attached
source frontiers, and stops accepting that member's Project progress or job
dispatch. It does not remove global Team Membership. The member's Desktop
reconciles their personal Conversation and job state. Other members retain
their own state and published memory under current authorization.

A current non-owner may use `workspace_project.leave` to disable only their
own Project access and receive the same affected-grant and local-reconciliation
behavior. The Workspace Project owner cannot use self-leave; they use the
explicit Project deletion lifecycle. Project leave and member removal have no
Undo. Returning requires a fresh Project invitation; it does not resume
frozen grants.

### Leave the Team

Before copy-back or destructive work, validate the existing Team last-owner
guard. If this is the last Team role `owner`, refuse before any copy-back or
mutation and use the existing Team ownership-transfer workflow. Project
ownership neither satisfies nor bypasses this guard.

If the departing member owns no Workspace Project that would be deleted,
`team.leave` keeps its existing Native review. If one or more owned Projects
would be deleted, the operation requires conditional Step-up bound to the Team
and membership version, the exact owned Workspace Project ID/version set, and
all copy-back, tombstone, and removal effects before mutation. Revalidate the
complete set and authority at consumption; a changed member, owner, Project,
version, or authority requires a new review and performs no stale-authority
copy-back. There is no new transfer action in this contract.

The departing member's own Desktop copies back its authorized records from
each Workspace Project that member owns, idempotently. The Team Backend never
writes to a member's Personal database. For every Workspace Project linked to
the departing member, including one they do not own, the Team Backend
invalidates only that member's Project link, freezes only their affected
grants/frontiers, stops accepting their progress, and denies their Project-job
dispatch. If an owned Workspace Project is removed, complete the Team-authoritative
D9 effects for every member before deleting Team Project records: tombstone
the Workspace Project; invalidate every member's Team Project link and Project-specific
access; freeze affected grants and attached continuous source frontiers; and
archive the Project Thread. Stop accepting Project progress and job dispatch.
The Team Backend can finish this cleanup while member Desktops are
offline and does not read or write Personal databases. After Team cleanup,
disable only the departing member's affected Workspace Access before disabling
that member's Team Membership last; do not wait for Personal reconciliation.
Remaining members retain their existing Workspace Access to retained Team
Memory. On later reconciliation, each member's own Desktop
clears that member's private Personal Project mapping, detaches only that
member's Conversations to **Just me**, and records the durable receipt for that member's future Project
Scheduled Jobs. Interruption leaves records and membership recoverable for
retry. Leaving has no Undo; a new Team invite is required to return.

## Restore and retention

Restore authority follows the resource owner and current authority:

- A Conversation owner restores their Personal Conversation.
- A Personal Project owner restores that Project and its Personal children.
- A Project Source uploader restores or exposes their Personal Note content
  and revisions.
- The uploader or Workspace Project owner restores Team-side Project Source
  metadata within current authority.
- Only the Workspace Project owner restores Team Project metadata and its
  Project Thread with current Team and Workspace authority.
- Workspace, Team Membership, and Workspace Access restoration keep existing
  Team governance and invitation rules.

Restore does not override suppression, revocation, expiry, retention, or
other current authorization, recreate a revoked grant, reattach another
member's Personal data, or resume frozen advancement. Lifecycle restore
windows are defined by `docs/project-sharing-lifecycle.md`; this document does
not claim those target paths are available in the current app.

## Current implementation boundary

Current code implements Team-authoritative Workspace Projects, per-member
Project access, versioned shared Work Items, Source metadata, and safe activity.
The uploader's actual document and Note revisions remain in Personal storage.
First share, linked Source upload/read, Team leave copy-back, Project delete,
member removal, and self-leave use the scoped authority and lifecycle paths
described above. An explicit trusted binding relates a Share Grant to one
Workspace Project; independent grants are never inferred from a Personal
Project ID. Verified parent actions freeze only bound grants affected by that
Project and all departing-member grants on Team leave.

Visible first-share and invite controls, Note-grant choices, Project Share
Policy, Scheduled Jobs, and Decks now use their scoped lifecycle paths.
Restore remains subject to its separate parent workflow and cannot resume a
frozen grant. The full two-user live Project acceptance remains HQ-713 work.

Team leave first reads a bounded manifest without storing Team content in the
Personal backend. A missing verified Personal link, the last Team-owner guard,
or more than 100 owned Workspace Projects blocks the operation before approval
or copy. The exact complete owned-Project ID/version set and copy manifest go
through Step-up. After approval, the Team backend reserves that operation, and
only the departing member's local edge stores inactive, operation-bound copies
of their owned Work Items and Decks. No Personal Project is detached while the
Team operation is prepared. Work Items are paged against the reviewed Project
version; a changed child record, Project, member, or Team scope cancels the
reservation and requires fresh review. The Team backend then commits the D9
closure and disables the departing membership; only its finished receipt lets
the local edge activate the complete staged Personal copy set. A lost response
is resolved by reading the original consumed approval receipt and exact
operation status, never by repeating an uncertain Team mutation. A current
enrolled device of the same owner may later prove an already-finished operation
and activate its own durable copies if the original device was revoked; it
cannot finish or take over a prepared operation. A fresh owner browser session
can cancel a prepared reservation before Team leave completes. Leaving has no
Undo and returning requires a new invitation.

The new HQ Project menu reads current Team ownership before offering Leave or
Delete. The Who’s in sheet provides an exact named-member removal review.
The Group sheet shows owned Project effects and pending cancellation or
recovery. Deleted Projects remain discoverable to their owner during the
30-day restoration window; restoring brings back only metadata and the
human Project Thread, never member links, Workspace Access, grants, or frozen
source advancement. The `koed_project_leave` and `koed_workspace_leave`
text tools create Human-origin proposals. Their durable journal only records
an applied leave after reading the exact consumed approval and Team execution
receipt. A Project owner’s leave proposal is declined and offers a separate
Delete review with a fresh operation identity.

Team Source fields are the authenticated uploader's metadata assertions, not
permission to read Personal storage or issue a Share Grant. The Desktop derives
them from the real Personal Source and Note joins. The uploader content route
requires that same Note identity and revision and rechecks the Team Source
version after decryption. Invalid or stale metadata returns no document bytes.
Grant binding separately checks the registered Note's owner and Workspace.

# Personal Project Identity

Status: First-class storage, local capture association, and the Projects API
are implemented under [ADR 0059](./adr/0059-first-class-personal-projects.md).
The HQ Conversation and shared Project links remain later work.

The Desktop Projects bridge reads the owner-scoped `/v1/projects` and
`/v1/projects/:id/hq` endpoints and submits create and lifecycle actions with
its existing local Desktop credential. Read and write access require a local
or developer deployment and a loopback socket. Reads require the existing
`personal_collaboration_read` family; writes require
`personal_collaboration_write`. Each Desktop request uses the owner, origin,
and credential captured before dispatch and rejects a profile change. Personal
API Tokens cannot authorize Project operations. The delete UI uses the API's
preview, batch status, and 30-day restore contract, and shows Undo only after
the full delete batch completes. The graph thread read exposes the nullable
effective Personal Project ID from the captured Session's verified assignment;
the Desktop keeps that ID separate from local discovery and execution IDs.
The capture association commits an owner-scoped Project change event with a
new Project or first Session assignment. HQ refreshes both the Project list
and captured graph after that event or an authoritative reconnect.

## Purpose

A Personal Project is a User-owned container for Conversations, sources, and
work. It can have an optional folder and can exist without a repository or
ordinary Conversation; its logical HQ Conversation is created on first open.
A code context may resolve to a Personal Project, but a path,
branch, commit, or remote URL is not the Project's durable identity.
Project names need not be unique; the short ticket key is unique per owner.

## Current Discovery Behavior

The current local discovery source is
`KOED_HOME/config/projects.json`. It records a device-local Project ID and
matching/display metadata such as the local path, Git root, branch, HEAD,
normalized remotes, and package names. Raw paths remain on the device. Git
remote credentials are stripped before remotes are recorded.

The local Project ID is derived from the resolved Git root, or the supplied
working directory when there is no Git root, using the device-local salt.
Separate worktrees therefore have separate local Project IDs. Discovery also
records a salted common-directory hash so the device can recognize worktrees
that belong to the same local Git repository. That hash is a local matching
signal; it does not identify a repository across devices.

Outside PDS V1's paired-device alias rule, current and historical remote
aliases are non-authoritative matching signals. They do not change the local
Project ID, link a Team Workspace, or authorize Team access. PDS V1 separately
allows authenticated paired Personal devices to use keyed canonical-remote
tokens for local Project grouping/search under [§9 of the PDS protocol](./personal-device-sync-protocol.md#9-project-aliases).
Auto-match requires exactly one token intersection mapping to exactly one
local Project on each device, with no explicit deny, manual override, or
competing current or historical token; otherwise the protocol requires User
confirmation. That match does not create, merge, or assign first-class
Personal Project records, choose a Workspace, or grant Team access.
The separate `KOED_HOME/config/project-team-workspaces.json` configuration
supplies explicit MCP recall routing; it does not create a shared Project or
grant Team access. See [Team Workspace Project mapping](./team-workspace-project-mapping.md).

Session metadata still carries automatic Project context and explicit User
overrides for older clients. The Personal database also stores an owner-scoped
Project identity and nullable Captured Session assignments. The first-party
Codex, Claude Code, and Pi transcript watchers associate verified local
contexts after their source journals accept a capture. Other capture paths
continue to create Personal Memory without an implicit first-class Project
assignment.

The local Watcher derives Git facts from a path already present in the
device-local discovery catalog. It verifies the catalog's salted local ID,
checkout Git directory, common directory and Git worktree membership itself.
The Personal API Token capture request cannot select a Project or cause Git
inspection through its Project metadata or working directory. The Watcher
uses the already-provisioned local database connection only when running for
the configured local Personal owner, healthy host-bound device identity and
loopback local backend. The Watcher's capture client must use that exact local
backend URL and provisioned local API token. Raw checkout paths, Git directories, prior folders,
confirmation choices and pending association work stay under `KOED_HOME`.
The Personal database receives opaque local identity hashes and IDs.

The Codex Watcher records pending association work before capture. Claude Code
and Pi recover accepted captures from their locally verified transcript identity
and source journal. All three retry durable pending work on watcher scans, even
without later transcript growth. They associate only a Session whose exact
source journal artifact reached the accepted capture frontier for that owner.
One-time confirmation versions are bound to the local context and consumed
after resolution, so delayed replay cannot reuse an earlier choice. Capture
continues if identity resolution or the database is temporarily unavailable.
Missing local provenance, remote backends and unconfirmed contexts leave the
new Session in Personal Memory without a first-class Project assignment.
Operators can review a deduplicated, bounded ambiguous-override count in the
local MCP server log under `personal_project_legacy_override_ambiguous`. The
diagnostic contains no owner, source, or path value.

## Target Identity And Association

Each Personal Project has a stable, owner-scoped identity independent of its
folder and local discovery metadata. A Project may be created for non-code work
or before it has a folder, local context, or ordinary Conversation. Local discovery
continues to supply code context; it does not replace the Personal Project
record.

Preserve an exact existing association to an active Personal Project. A context
already associated with a soft-deleted Project retains that association for
restore, but the deleted Project is not eligible for new-session assignment.
Capture continues under the existing Personal Capture Policy; the new Captured
Session remains in Personal Memory without a first-class Personal Project
assignment until the User explicitly restores that Project or chooses a new
one. Do not implicitly
revive a deleted Project, hide a new Session under it, drop capture, or wait
for UI before capture. If there is no existing Project candidate and no
retained association to a soft-deleted Project, register its Personal Project
normally. A verified
same-device worktree group reuses one Personal Project, while each context
keeps its own device-local Project ID. Automatically associating a newly
discovered linked checkout requires trusted local Git worktree facts and prior
local association records that identify a verified new checkout of exactly
one repository and Personal Project. A salted common-directory hash is only a
candidate signal. Target association history must retain enough per-checkout
Git-directory identity and prior-folder information to distinguish a new
linked checkout from a known checkout whose path changed; current discovery
does not claim to store this history.

A changed path for a known checkout, missing, insufficient, or ambiguous
provenance, multiple possible Project associations, or a remote-only match
requires one-time User confirmation before suggested reuse or reassignment.
Persist the choice so the same unresolved association does not prompt again.
Never guess, silently merge two Personal Projects, or override an existing
explicit Project assignment. For first-class Personal Project association,
remote aliases may suggest a match but never authorize association by
themselves; renaming a remote does not change Project identity. If the User
declines or an ambiguous match is not confirmed,
keep the context separate and leave unresolved history for review.

Concurrent first captures in a verified same-device worktree group must
atomically reuse one Personal Project. Ambiguous association history remains
for User review rather than being resolved by race order. This target adds no
cross-device Personal Project association or merge. PDS V1's separate,
authenticated paired-device alias matching uses keyed canonical-remote tokens
only for local Project grouping/search under §9; it does not establish
first-class Personal Project identity. Outside that PDS rule, remote URL,
project name, path, branch, or commit do not establish cross-device Project
identity.

A non-code Project may have no local discovery context. Adding or changing a
folder does not change its stable Project identity.

## Existing Assignment Migration

When a Captured Session first resolves to an automatic local Project, register
its Personal Project association. Associate older Sessions lazily as they are
resolved. Keep existing automatic Project fields available to older clients.

An existing explicit `project_override_*` assignment remains a User choice and
maps to the Personal Project identity. Backfill only when the old assignment
matches exactly one Project. Leave ambiguous assignments unchanged and report
them for review; do not guess, merge Projects, or silently move a Conversation.

## Personal Ownership And Team Links

A Personal Project remains owned by its User. When a Project is shared, the
Team-side Workspace Project is a separate record that links the participating
members' own Personal Projects. It does not replace those Projects or take
their ownership. Every member retains their own Personal Project and private
HQ Conversation. The Workspace Project's owner is a Team member, and Project
ownership does not promote that member to Team role `owner`.

The local `project-team-workspaces.json` entry remains recall-routing metadata.
It is distinct from the shared Workspace Project link, Share Grants, and Team
authorization. Sharing and access continue to follow [ADR 0057](./adr/0057-project-backed-workspaces-and-project-share-policy.md)
and the Team backend's current authorization records.

## HQ Conversation Uniqueness

Each Personal Project has one logical private HQ Conversation, created on
first open using get-or-create so concurrent first opens return the same
Conversation. A Project may exist without an ordinary Conversation. A shared
Workspace Project can therefore have a different private HQ Conversation for
each participating member, through that member's Personal Project.

## Lifecycle Boundary

Deleting a Personal Project is a soft delete that can be restored; captured
Memory is not purged. Shared Project grant freeze, restore, and access behavior
follow the [Project-sharing lifecycle](./project-sharing-lifecycle.md), which
is published with HQ-001. Restoring a Project does not transfer ownership or
resume frozen sharing.

The HQ navigation read model suppresses a Captured Session when its selected
Session is trashed or its non-null Personal Project ID is absent from the
active owner Project list. Retained Memory remains available to its existing
read contracts. A null Personal Project assignment can appear under Chats;
an unavailable assignment is not inferred from the technical Project ID.

This document records identity and ownership semantics. Database columns,
indexes, endpoints, and migration mechanics belong in their implementation
contracts and are intentionally not duplicated here.

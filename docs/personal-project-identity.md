# Personal Project Identity

Status: Target behavior under [ADR 0059](./adr/0059-first-class-personal-projects.md).
This document separates existing discovery behavior from the target Personal
Project contract; it does not claim that first-class Project storage,
durable association, override migration, or HQ uniqueness is already
implemented.

## Purpose

A Personal Project is a User-owned container for Conversations, sources, and
work. It can have an optional folder and can exist without a repository or
Conversation. A code context may resolve to a Personal Project, but a path,
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

Current and historical remote aliases are non-authoritative matching signals.
They do not change the local Project ID, link a Team Workspace, or authorize
Team access. The separate `KOED_HOME/config/project-team-workspaces.json`
configuration supplies explicit MCP recall routing; it does not create a
shared Project or grant Team access. See [Team Workspace Project mapping](./team-workspace-project-mapping.md).

Today, session metadata carries automatic Project context and explicit User
overrides. First-class Personal Project records and their durable local-context
association are target behavior, not part of current storage.

## Target Identity And Association

Each Personal Project has a stable, owner-scoped identity independent of its
folder and local discovery metadata. A Project may be created for non-code work
or before it has a folder, local context, or Conversation. Local discovery
continues to supply code context; it does not replace the Personal Project
record.

Preserve an exact existing local-context association. If a context has no
existing Project candidate, register its Personal Project normally. A verified
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
explicit Project assignment. Remote aliases may suggest a match but never
authorize association by themselves; renaming a remote does not change
Project identity. If the User declines or an ambiguous match is not confirmed,
keep the context separate and leave unresolved history for review.

Concurrent first captures in a verified same-device worktree group must
atomically reuse one Personal Project. Ambiguous association history remains
for User review rather than being resolved by race order. Multiple devices
register their own Projects in this release. Do not infer cross-device identity
from a matching remote URL, project name, path, branch, or commit. Cross-device
association waits for a separately accepted trusted personal-device policy.

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

Each Personal Project has at most one private HQ Conversation. Opening or
creating it is get-or-create: concurrent first opens return the same
Conversation. A shared Workspace Project can therefore have a different
private HQ Conversation for each participating member, through that member's
Personal Project.

## Lifecycle Boundary

Deleting a Personal Project is a soft delete that can be restored; captured
Memory is not purged. Shared Project grant freeze, restore, and access behavior
follow the [Project-sharing lifecycle](./project-sharing-lifecycle.md), which
is published with HQ-001. Restoring a Project does not transfer ownership or
resume frozen sharing.

This document records identity and ownership semantics. Database columns,
indexes, endpoints, and migration mechanics belong in their implementation
contracts and are intentionally not duplicated here.

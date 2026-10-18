# ADR 0059: First-Class Personal Projects

Status: Accepted (D4, 18 October 2026).

Related decisions:

- [0057 Project-Backed Workspaces And Project Share Policy](./0057-project-backed-workspaces-and-project-share-policy.md)
- [Personal Project identity](../personal-project-identity.md)
- [Team Workspace Project mapping](../team-workspace-project-mapping.md)
- [Project-sharing lifecycle](../project-sharing-lifecycle.md)

## Context

A Project is a User-owned container for Conversations, sources, and work, with
an optional folder. A local code context may resolve to a Project. That model
must also support Projects without a repository or ordinary Conversation, such
as a course, trip, or investor deck, and give Project-scoped records a durable
owner-scoped identity.

Today, code Project discovery is device-local metadata in
`KOED_HOME/config/projects.json`. Captured Sessions retain automatic Project
identity and User overrides in session metadata. The repository does not yet
have a first-class Personal Project record; identity and assignment remain tied
to those existing local contexts and session fields.

A Personal Project must keep its owner's identity separate from a Team-side
Workspace Project. The Workspace Project links members' Personal Projects; it
does not replace them, take ownership of them, or make a Project an
authorization key. Project ownership must also remain independent from Team
membership roles.

## Decision

Add a first-class Personal Project owned by one User. Each record has a stable
identity, a name, an optional folder, an optional link to local Project
discovery metadata, an owner-unique short key for ticket references, an
active or deleted lifecycle, and a version. Names need not be unique; the
short ticket key is unique per owner. A Project can exist without a folder,
repository, or ordinary Conversation; its logical HQ Conversation is created
on first open. Project-scoped records introduced
by the redesign, including Project Sources, Work Items, Flashcard Decks,
Scheduled Jobs, and Project-scoped Curated Memory, refer to the Personal
Project identity. Personal Project identity is distinct from a path, branch,
commit, or remote URL.

### Code Project identity

Continue using the existing device-local discovery in
`KOED_HOME/config/projects.json` as the source of local code context. On first
capture resolution, preserve an exact existing association to an active
Personal Project. If there is no existing Project candidate and no retained
association to a soft-deleted Project, register a Personal Project normally. A
context already associated with a soft-deleted Project retains that association
for restore, but the deleted Project is not eligible for new-session
assignment. Capture continues under the existing Personal Capture Policy; the
new Captured Session remains in Personal Memory without a first-class Personal
Project assignment until the User explicitly restores that Project or chooses
a new one. The retained association remains available for restore. Do not
implicitly revive a deleted Project, hide a new Session under it, drop capture,
or wait for UI before capture. Existing Captured Sessions are associated
lazily. The existing capture fields remain available to older clients; this
decision adds the Personal Project identity and association without replacing
their current behavior.

A local Project ID is device-local. Separate worktrees have separate local
Project IDs, while a device-salted common-directory hash identifies worktrees
that may belong to the same repository on that device. A verified same-device
group reuses one Personal Project. Automatic association of a new linked
worktree requires trusted local Git worktree facts and prior local association
records that identify a verified new checkout of exactly one repository and
Personal Project. The common-directory hash is only a candidate signal. Target
association history must retain sufficient per-checkout Git-directory
identity and its prior folder to distinguish a new linked checkout from a
known checkout whose path changed; current discovery is not claimed to store
that history. This Personal Project identity and association history remain
device-local. Existing PDS V1 paired-device matching of keyed canonical-remote
tokens for local Project grouping and search remains governed by §9 of the
[Personal-device sync protocol](../personal-device-sync-protocol.md#9-project-aliases);
it does not create, merge, or assign a first-class Personal Project.

A changed path for a known checkout, missing, insufficient, or ambiguous
provenance, multiple possible Project associations, or a remote-only match
requires one-time User confirmation before suggested reuse or reassignment.
Persist the User's choice so the same unresolved association does not prompt
again. Never guess, silently merge two Personal Projects, or override an
existing explicit Project assignment. For first-class Personal Project
association, remote aliases can suggest a possible match but never authorize
association by themselves, change Project identity, link a Team Workspace, or
grant Team access. Renaming or replacing a remote leaves the existing local
Project identity unchanged. A new context with no existing Project candidate
registers normally.

Concurrent first captures in a verified same-device worktree group must
atomically reuse one Personal Project. Ambiguous association history remains
for User review rather than being resolved by race order.

This decision introduces no cross-device Personal Project association or
Project-record merge. PDS V1's authenticated paired-device alias matching is a
separate local grouping/search behavior and does not change Personal Project
identity. Outside that protocol's exact keyed-token rule, raw remote URLs and
repository names do not establish first-class Project identity.

### Existing assignments and HQ Conversations

Keep `project_override_*` as the User's explicit Project assignment, but map
it to the Personal Project identity. Backfill an existing override only when
its identity resolves exactly to one Project. Leave ambiguous overrides
unchanged and report them for review; do not guess or merge their Projects.
New automatic assignments use the same Personal Project identity while
existing automatic Project fields remain compatible with older clients.

A Personal Project has one logical private HQ Conversation, created on first
open using get-or-create so concurrent first opens resolve to the same
Conversation. A Project may exist without an ordinary Conversation. For a
shared Project, each member's Personal Project is linked separately to the
Team-side Workspace Project, and each member keeps their own private HQ
Conversation.

### Personal ownership and Team linkage

The Personal Project remains owned by its User. The Team-side Workspace
Project is a separate record with its own Team-member owner. Workspace Project
ownership is independent of Team role; owning a Project never promotes a User
to Team role `owner`.

The existing local Project-to-Workspace mapping remains a recall-routing
configuration as documented in [Team Workspace Project mapping](../team-workspace-project-mapping.md).
It is distinct from the shared Workspace Project link and does not create that
link, establish a Share Grant, or authorize Team operations. Shared Project
linkage and Team access continue to follow [ADR 0057](./0057-project-backed-workspaces-and-project-share-policy.md)
and current Team membership, Workspace Access, and Share Grant authority.

Deleting a Personal Project is a soft delete. It hides the Project and its
children from active flows and can be restored; it does not purge captured
Memory. Shared Project grant-freeze and restore behavior is specified in the
[Project-sharing lifecycle](../project-sharing-lifecycle.md).

## Implementation Boundary

This ADR defines target behavior. It does not assert that Personal Project
storage, local-context association, migration, or HQ uniqueness is already
implemented.

## Consequences

- Projects can represent non-code work and can exist before they have a folder
  or ordinary Conversation; the logical HQ Conversation is created on first
  open.
- Existing discovery remains local and is reused as association input; raw
  paths stay under `KOED_HOME`.
- The Project model can link several local worktree contexts to one Personal
  Project without making remote URLs or folder names authoritative identity.
- Existing session assignments migrate additively. Unambiguous overrides map
  to a Personal Project; ambiguous data remains unchanged for explicit review.
- Each member of a shared Project keeps a separate Personal Project and private
  HQ Conversation linked to the Team-side Workspace Project.
- The existing MCP Project-to-Workspace mapping remains distinct from shared
  Project ownership and Team authorization.
- Search Domain `project` resolves through the Personal Project identity.

## Alternatives Considered

### Keep Projects Derived Only From Session Metadata

Rejected because this cannot represent Projects without Conversations and does
not provide a durable identity for Project-scoped records.

### Use a Remote URL or Repository Name as the Project ID

Rejected because remote values can change, can be absent, and are not a
trusted cross-device identity. They may suggest a possible moved folder but
cannot merge Projects or authorize Team access.

### Use One Project Per Worktree

Rejected because worktrees of one repository should appear under one Personal
Project for that User on a device. Trusted local worktree facts and prior
association history establish a verified same-device group; the
device-local common-directory hash is a candidate signal, not sufficient
evidence on its own, and each worktree keeps its local Project ID.

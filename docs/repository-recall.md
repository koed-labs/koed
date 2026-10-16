# Personal Repository Recall

## Team Project snapshots

Ticket 14 adds a Share Grant repository snapshot for Team Project matching.
It records only the effective portable fingerprint; nonportable overrides and
unresolved history produce an unresolved snapshot. It contains no checkout path,
device-local identity, or suppressed automatic repository. Project labels must
pass the representation's disclosure policy before inclusion.

The snapshot stays independent of later Personal moves, resets, and anchor edits.
Team semantic search and expansion match the snapshot rather than mutable local
Project fields. Workspace selection, Membership, Share Grants, consent, policy
checks, and source access continue to authorize every read. A repository fingerprint
grants no access and cannot select a Workspace. Team Project tasks require pinned
portable context; device-local and unresolved targets produce a resolution error.
The Local AI Runtime resolves this context before queue acceptance. It stores the
repository scope as `project_id` and keeps the local root as request metadata.
Personal Project move rules do not redirect Team repository matching.

Team fingerprints are unsalted selected-remote hashes. A Team member may guess a
repository name and compute its normalized fingerprint. This accepted exposure
does not bypass Share Grant or Workspace authorization. Personal Device Sync
continues to use its separate encrypted, group-keyed boundary.

Team Global recall allocates one quarter of the existing candidate budget to a
current-repository pool when a portable request context and two search passes
are available. Both pools use the same query embedding, Workspace, authorization,
time bounds, and source rules. They merge grant-scoped canonical sources before
decrypting content, ranking, and truncating the result. Pool overlap contributes
one candidate and one preference.

The authorized Share Grant snapshot classifies evidence as current, other, or
unknown. A later Personal move does not change this classification. The existing
semantic and exact-anchor score receives the same bounded preference as Personal
Global recall: 0.04 for a matching portable repository, plus 0.01 only when the
sanitized representation and snapshot agree on a known matching branch. Missing
or incomparable branch metadata receives no branch preference. Device-local and
unresolved caller contexts receive no Team repository preference. Authorized
labels identify other Projects; the AI Client preserves unknown provenance and
shared lineage. No additional embedding model or reranker is used.

Release remains gated by the complete Project cutover in ticket 16.

Directed Captured Session Sync transfers an owner-authenticated selected-repository
snapshot into the owner-private replica. It carries no checkout path, device-local
identity, or suppressed automatic anchor. Subsequent accepted packages update the
replica's current source context; they do not mutate existing Share Grant snapshots.
The Team snapshot is recorded separately when a new share is created. Permitted
labels and branch observations still require the representation disclosure path.

The encrypted source artifact carries repository provenance separately from its
conversation content. Semantic privacy classifies the Project label and branch
alongside the representation's other text. Reconstruction preserves the exact
fingerprint and rejects additional checkout or device fields. Only the sanitized
label and branch can complete a matching Share Grant snapshot, and only for the
source revision recorded when that snapshot was created. Later source revisions
cannot fill it with newer Personal context. Project routing never waits for or
uses a raw label.

The receiving owner-private replica stores only classification and fingerprint
in its routing metadata. Raw label and branch values stay in an envelope encrypted
with the owner-private replica provider and bound to the local Session, receiving
User, and source owner principal. Privacy review decrypts that envelope only after
source authorization. Changing the source to unresolved removes the old envelope.

The Project integration branch targets Personal Memory using one effective
repository identity. The complete release is gated by ticket 16. Team matching
and Personal Device Sync assignment transport are implemented by their later
tickets; repository identity never chooses or authorizes a Workspace.

## One-time historical assignment transition

Migration `0062_project_assignment_cutover` marks every existing Personal Session
as `historical_unresolved`. This includes Sessions captured during additive
preparation, invalidated rows, and Personal Device Sync replicas. The migration
clears automatic and User override assignments and increments assignment versions.
Stale assignment writes therefore fail their version check.

The migration preserves raw memory, lineage, captured provenance, retained sync
packages, and existing Team Share Grant snapshots. It locks Session writes for
the transition and runs once through the migration journal. Repeated startup does
not clear assignments created after the transition. Fresh Sessions record their
normal capture-time assignment.

Later turns, duplicate ingestion, and imports do not resolve Sessions marked
`historical_unresolved` by the migration.
An explicit User reassignment supplies the effective identity. Resetting that
override returns the Session to unresolved history. Global and Session recall
continue to expose authorized unresolved memory. Project recall requires an
explicit matching assignment.

Fresh historical imports record an automatic assignment only when the
Conversation first enters Koed. A reliable source-time Git anchor takes priority.
Otherwise, Koed inspects Git in the recorded absolute working folder and uses
its current selected repository when available. Without usable Git metadata,
the recorded path supplies a local
folder Project. Missing or conflicting source context stays unresolved. The
importing process's cwd never supplies historical identity.

Historical folder groups use the profile's Project salt and normalized recorded
path. They have no current checkout identity and do not automatically merge with
a live checkout at the same path. Manual assignment remains authoritative.
Re-import, resumed capture, reset, and invalidation recovery retain the recorded
assignment state. No migration or startup repair reassigns existing history.

## Resolve Before Accepting Work

For Project scope, the local adapter resolves the caller's cwd through shared
Project discovery. Subdirectories resolve to the Git root. An explicit path or
catalogued local Project id resolves that requested Project only. An unknown
Project, missing checkout, invalid selected anchor, or failed probe returns a
resolution error. It does not substitute the caller's repository or Global scope.

Supported client integrations bind that cwd to the Conversation, independently
of the MCP process's startup directory. Codex (CLI, desktop, and IDE extension)
and Claude Code install a `PreToolUse` hook for Koed's `memory_answer` tool.
The hook copies its native `cwd` into the adapter-only `conversation_cwd`
argument on every call, including calls from concurrent Conversations. The
adapter validates the absolute path, passes it as caller context, and removes
the argument before submitting blocking or non-blocking work. Missing or invalid
native cwd stops the recall call instead of selecting the adapter's Project.
An explicit `project_id` or pinned `repository_context` still selects the
requested Project; Global and Session search keep their original scopes.

Codex also supplies per-request workspace roots in its native MCP metadata.
When no hook observation or private managed directory is available, a single
absolute workspace root selects that Project. This covers app-server clients
that skip an untrusted hook. Missing or multiple workspace roots require an
explicit Project target or a trusted hook; Koed does not choose one arbitrarily
or use the MCP startup folder. Global recall remains available with unknown
current-Project provenance. The adapter uses only the local root for discovery,
not remote URLs or other identity claims from that metadata.

Pi's native extension passes `ctx.cwd` directly for both delivery modes. Managed
Codex and Claude Conversations also supply a launch-scoped `KOED_MCP_CWD` to
their private adapter; a per-call hook observation takes precedence. No shared
last-active folder is stored. Remote transports still control caller context
and cannot inherit the serving host's directory.

After upgrading, repair the Codex and Claude integrations and restart those
clients so they load the added hook and adapter schema. Review and trust changed
Codex hooks through the client's normal hook review flow. Older MCP-only setups
can pass an explicit Project path. Other stdio clients retain startup-directory
compatibility, but Codex without sufficient native context requires an explicit
target. Moving a whole Project continues to
route newly resolved source folders to its saved named destination before task
acceptance.

The accepted task's encrypted request stores `repository_context`: root, identity
kind/key, branch observation, resolution reason, and checkout/device provenance.
Its `project_id` is an opaque scope value derived from kind, key, and the
originating device for local identities. Portable equality ignores checkout paths,
branches, and device provenance. Local repository and non-Git identities also
require the originating device to match.

Remote adapters can supply typed resolved context for a source checkout that is
not present on the serving host, including a Windows path. Such paths are request
metadata; they do not select the local worker's execution directory. The API
rejects Project task acceptance without resolved context or when the supplied
scope value disagrees with it.

Blocking and non-blocking delivery use the same context. Worker replacement and
retry use the stored request, so cwd, anchor, or branch changes cannot retarget
accepted work. Authorized collection belongs to the User and does not depend on
the collector's cwd. Repeated collection reads the encrypted terminal result
without another recall or synthesis run.

Pinning the request does not snapshot Personal Memory. Every query and expansion
checks current assignments, ownership, source eligibility, deletion, and time
bounds. A User override wins even when it is unresolved or local; resetting it
restores the recorded automatic assignment, including unresolved history.

## Retrieval Boundaries

| Surface                                   | Boundary                                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw Memory Events and messages            | Semantic candidate SQL checks the owning Session's current effective identity before candidate limits.                                               |
| Memory Node semantic search               | Matching source membership, filtered source items, and out-of-window diagnostics use the same identity predicate.                                    |
| Memory Node expansion                     | Current Session assignments filter source rows; capture-time source JSON cannot authorize Project evidence.                                          |
| Curated Memory search                     | Active source evidence must match the effective identity; deleted/excluded sources cannot establish scope.                                           |
| Curated Memory expansion                  | Scope and time bounds filter source links; a scoped summary cannot include known source Sessions outside that boundary.                              |
| Graph and memory-browser collections      | Project predicates use effective identity instead of captured ids, cwd, or paths. Direct owner inspection by source id remains owner-authorized.     |
| Materialized Personal replicated evidence | The same Session predicates apply to local source rows, alongside existing replication-readiness checks. Assignment transport is added by ticket 11. |
| Durable task completion                   | The final Memory Question must retain the accepted Project scope.                                                                                    |

Session API responses and graph views derive the effective Project ID, label,
path, and assignment source from the same repository assignment. Original
capture columns remain display/provenance hints; a stale override label or path
cannot select or describe a different effective Project. A named Project has no
filesystem path. Replicated assignment changes take effect in both views without
rewriting original capture provenance.

Scoped Session lookup uses the effective repository assignment. A captured display
Project ID cannot substitute for that identity. Unscoped owner inspection still
returns authorized unresolved history. Memory-browser results use the same
repository scope IDs as their filters. They label unresolved entries as
`Unresolved history` and return no current Project path for those entries.

`repository_scope_matches` is the shared SQL equality boundary. It returns false
for unresolved identities, malformed scope values, and path-only inputs. It is
only a narrowing predicate; callers retain all existing User and source-access
checks. API retrieval clients carry the opaque `project_id` through search,
expansion, and graph requests. Diagnostic local tools resolve the same context.
Session scope still targets its explicit Session; Global scope retains its
existing authorized search behavior. Neither uses repository equality as an
access grant.

Evidence selection, chunk identities, source references, lineage, and budgets
are unchanged. Existing semantic scoring and candidate fusion remain in use;
there is no additional ranking model and no backend LLM synthesis.

## Verification

The shared identity fixtures cover repository selection. Focused PostgreSQL
checks exercise raw semantic search, nodes, graph browsing, Curated Memory search
and expansion, current overrides, and unresolved assignments. Adapter checks
cover explicit Project targeting and immutable request context. Durable task
checks cover encrypted context across worker replacement, terminal persistence,
and repeated owner collection. Semantic tests use deterministic embedding vectors;
they validate boundaries, not model answer quality.

## Desktop Groups and Single-Session Assignment

Use **+** in the Projects header to create a named local Project. Enter a name;
no folder is selected or created. The local catalog retains its stable identity,
name, and creation time in `config/projects.json`, separately from discovered
checkout metadata. Empty Projects remain available as assignment destinations.
Ingestion continues to discover Git repositories and fallback folders.

Use **Move** on the right side of a Conversation header to assign that Conversation.
Choose a destination and select **Move**. **Create Project…** opens the name dialog
and selects the new Project as a destination. Creating a Project does not move
history. **Reset to automatic** restores the recorded capture assignment,
including unresolved history for legacy Conversations.

Use **Move** on the right side of a Project header to move all of its existing
Conversations. The API selects every current owner-visible Session in the source
Project, including Sessions beyond Desktop's loaded page and hidden subagents.
One transaction updates their overrides and saves an owner-specific routing rule
in `personal_project_routes`. It preserves automatic identities and capture
provenance. A failed update rolls back both the assignments and the rule.

New captures from that source also use the destination. Capture takes a shared
owner routing lock; a Project move takes the exclusive lock. Captures that finish
before the move are included, and captures that start afterward use its saved
rule. Repeated moves flatten incoming rules and reject cycles. A continued
Conversation, inherited lineage assignment, or verified PDS assignment keeps its
existing assignment. Individual moves do not create routing rules. Resetting an
individual override restores that Conversation's recorded identity; it does not
remove the rule for later new captures.

Migration `0063_named_local_projects` adds the routing table and recognizes
`local_project` identities in the common SQL scope functions. Named identities
have no root, branch, remote, or checkout and retain originating-device scope.
They are not portable Team repository fingerprints. Project recall accepts a
named catalog identity without filesystem discovery. For a discovered source,
the authenticated Personal API resolves its saved route before new work is
accepted. The resulting context remains pinned for that request.

The historical cutoff remains unchanged. New observations and routing rules do
not resolve legacy Sessions. Moving **Unresolved history** explicitly assigns
its existing Conversations but creates no rule for unidentified future captures.
Adding a Project never backfills legacy assignments.

Desktop groups Captured Sessions by the same effective identity that recall uses.
Current catalogue entries with that identity join the group, even when their
checkout paths differ. Each local checkout retains its opaque local Project id,
root, and checkout/device provenance for navigation. Paths, extra remotes, and
historical aliases never establish group membership. A stable originating
checkout can remain a navigation target after its selected anchor changes,
without moving its recorded sessions into the new group.

Unresolved history remains visible in its own owner group. Catalogue metadata at
the same path does not resolve or absorb it. The source inspector retains the
recorded automatic assignment and original cwd/root separately from the effective
User assignment. An override can be portable, device-local, non-Git, a named local Project, or
explicitly unresolved. It replaces the automatic identity rather than adding a matching value.

**Move Conversation** moves one Session or resets its override. Each request
includes the assignment version the User inspected. The API atomically compares
that version and updates both the override and version. Stale owner requests
return 409; missing or other-owner sessions return 404. Capture observations do
not overwrite this state. Reset restores the original automatic identity, or
unresolved history when no automatic identity was recorded.

The Desktop Personal contract is version 10. Graph thread responses carry the
assignment state and version through the API and main process so subsequent edits
use fresh versions. Successful moves invalidate graph caches and reload the
Project index. A move changes grouping and subsequent Project recall immediately;
it does not change retained capture source bytes or existing Team snapshots.

Renderer code imports the browser-safe `@koed/shared/repository-recall` entry point.
The server entry point includes Node dependencies and must not enter the renderer bundle.

## Fixed Assignment Reviews

Shared selection controls are described in
[Personal Project association and selection records](personal-project-selection.md).
An accepted association changes live discovery, including quiet checkouts.
Its encrypted configuration updates and deletions run independently of Conversation
capture. Existing Session assignments remain recorded; fixed reassignment still
requires the separate review below. Concurrent shared choices remain unresolved
until explicitly resolved, while a local explicit choice retains precedence.

Anchor discovery records changes in an atomic, profile-local outbox. An unchanged
anchor or a branch observation does not create another change. Checkout identity
includes the filesystem incarnation; replacing a repository at the same path does
not inherit pending changes. Desktop publishes the outbox through the authenticated
Personal API when the User inspects repository changes. A failed publication leaves
the item pending for retry. The API binds every event to the authenticated owner,
originating device, stable checkout, previous/target identities, and a revision.
Continued capture records conflicting anchor observations through the same event
store without replacing the Session's recorded automatic assignment.

A newer target supersedes a pending change for that checkout. Delayed local event
revisions cannot replace the current target. Repeated capture observations with the
same anchor do not reopen applied or dismissed work. The source revision watermark
can advance without changing a fixed review's target revision.

**Review repository changes** shows pending changes for the selected local checkout.
**Prepare fixed review** persists the exact Sessions, assignment versions, options,
and count. By default, it selects that checkout's Sessions with the previous resolved
automatic identity and no manual override. The User can explicitly include manual
overrides or unresolved history that has recorded observations from this exact
checkout and device. Every included override is shown. Paths alone never qualify.
A review is limited to 500 Sessions; exceeding that limit rejects preparation instead
of truncating the count. The User can select a subset of the fixed list.

Applying locks the reviewed Sessions in stable order, then the checkout/event and
review. This follows capture's Session-before-event lock order. The transaction
rechecks ownership, live Session eligibility, checkout/device provenance, event
revision/state, and every reviewed assignment version. A stale set returns 409 and
changes nothing. Accepted Sessions receive User overrides and incremented versions;
Session source bytes, automatic assignments, and existing Team snapshots stay intact.
Later Sessions never join the set. Completion and selected ids are recorded in the
same transaction, so exact replay returns the result without applying again.

Desktop rediscovery also checks the actual local checkout and current target before
execution. Replaced checkouts and changed anchors require a new review. **Dismiss
without reassignment** records dismissal and changes no Session assignments. Project
grouping and subsequent recall use the resulting effective assignments immediately.
The API exposes owner-scoped event listing, review preparation/read, and apply/dismiss
under `/v1/memory/repository-changes` and `/v1/memory/repository-reviews`. Renderer
commands use validated opaque ids; local paths and API credentials stay main-owned.

`pnpm test:repository-review-fixture` runs the snapshot-preservation regression when
`KOED_REPOSITORY_REVIEW_FIXTURE_DATABASE_URL` names a disposable fixture database.
Run under the fixture's test/developer guard. It seeds the existing truth sheet with
three synthetic encryption providers, stages a recorded Personal repository identity,
applies/resets a fixed review, and compares materialized Team families and decrypted
representations. It also repeats the fixture's positive and negative access validation.
It does not replace the later Team Project snapshot or staged release gates.

## Historical import assignments

Fresh historical imports prefer recorded source-time Git metadata, then Git
discovery in a valid recorded absolute working folder, then a local folder
Project. Codex native `session_meta` records can
supply an origin URL, timestamp, and branch. Koed normalizes the recorded URL
with the shared Git remote normalization. A Git observation requires an absolute
recorded cwd and a valid timestamp. It remains valid when that checkout is gone
or now points to another repository. Conflicting branch observations become
unknown. Conflicting Git anchors cannot be rescued by a folder fallback.

Recorded source-time Git identity carries no checkout root, checkout identifier, or
asserted originating device. Its explicit unknown-device marker cannot establish
a device-local checkout match. Without a reliable Git anchor, Codex uses a
consistent native recorded cwd. Claude Code uses the main transcript's cwd,
and Pi uses its verified Session header. Missing, invalid, or ambiguous source
context remains unresolved. No producer substitutes its process directory.

When a source-time anchor is absent, Koed uses the normal local Git discovery
rules in the recorded folder. Subdirectories resolve to the Git root. Explicit
local anchor choices and the upstream/origin precedence match live capture.
Current Git discovery is a present-day grouping choice, not proof of historical
repository contents. Its branch is unknown rather than today's checkout branch.
Conflicting Git selections remain unresolved. Foreign path syntax cannot resolve
relative to the importing process's directory.

Folder fallback creates a `non_git_project` identity with the normalized recorded
path and a profile-salted key. This records an import-local grouping, not proof
that the source lacked Git. It claims no checkout incarnation and remains separate
from live checkout identities. After initial capture, later files, Git remotes,
and checkout choices cannot change that identity. Different importing profiles have separate folder
groups, and the folder key cannot establish a portable Team repository match.

Re-import, delayed capture, and resumed Conversations preserve the existing logical
Session, assignment, and User override. A pre-cutover historical-unresolved
Session cannot resolve from newly observed metadata; explicit reassignment remains
the repair path. No startup or upgrade backfill is introduced.

### Directed Captured Session Sync release profile

The coordinated Project cutover uses `koed.captured-session-sync/v2` with package
format version 2. Every package and target registration includes an explicit
portable or unresolved repository snapshot. Every upload manifest includes its
snapshot hash; targets compare it before applying content, and source
acknowledgements retain the exact hash. Missing fields and V1 packages are
rejected. Codex, Claude Code, and Pi use this same profile. Existing encrypted
source material is retained; the version change does not reset source memory,
change encryption-envelope versions, or retarget existing Team snapshots.
Existing Sessions also retain their saved logical Memory IDs, including IDs that
originated under V1. Capture continuation and graph sharing read that saved binding
instead of deriving a new ID from the current protocol version.

Every enabled Pi capture signal records the current repository observation, even
when its source artifact already exists. A changed anchor enters the assignment
review flow. It does not replace the original Session assignment or source artifact.

## Personal Global Repository Preference

The local adapter pins Global caller context before task acceptance. The encrypted
request stores the resolved identity or explicit `null` when discovery fails.
Retries preserve that value and never infer context from the worker directory.
Global recall continues to search all authorized Personal Memory.

For a PDS replica, the branch preference uses the verified captured branch
observation from its received assignment snapshot. Missing observations give no
branch bonus, even when the imported automatic identity names a branch. The
local automatic and effective repository assignments must also agree. A local
move to another repository cannot reuse the source branch for preference.

Each semantic stage partitions its existing candidate cap: one quarter (rounded
down, at least one when the cap exceeds one) retrieves current-repository
candidates; the remainder retrieves Global candidates. Both pools share one query
embedding, SQL snapshot, authorization, source eligibility and time bounds. The
combined pre-hydration rows cannot exceed the previous stage cap. Canonical source
identity merges overlapping rows before hydration and decryption. Both passes count
against the existing search budget; when only one pass remains, retrieval uses the
Global pool alone. Unknown caller context also uses the Global pool alone.

The shared repository-search plan defines pool eligibility and pass cost for
Personal and Team retrieval. Score scans always cost one pass. A candidate search
costs two only when its current-repository pool is enabled; Team preference
requires portable repository context. The worker reserves follow-up retrieval
separately, charges scans at their actual cost, and schedules routed searches
within the remaining budget. Failed searches retain their reserved cost so
retries cannot evade the request-wide cap.

After the existing semantic threshold, stage weights and exact-anchor fusion,
current-repository evidence receives `0.04`; a known matching branch adds `0.01`.
These fixed additions apply once per canonical candidate, regardless of pool overlap.
They can prefer similarly relevant evidence but do not remove stronger evidence
from other Projects. A shared branch name in another repository adds nothing.
Branch provenance comes from consistent capture observations, never an override's
chosen target branch. Mixed, unresolved, or device-incomparable evidence adds nothing.

Evidence carries `current`, `other` or `unknown` classification, authorized Project
labels, and source Session lineage. Mixed summaries preserve their individual
Project labels while their overall classification remains unknown. Full observed
references retain chunk identities, counts, stages, generations and parent lineage.
Assignment provenance distinguishes a manual User override from the automatic
assignment and retains the captured Project label separately from the effective
label. An AI Client must not reinterpret a deliberate move as misclassification
or a conflict just because retained source text still names the captured Project.
Distinct selected parent summaries and partial children remain subject to the
existing evidence budget. The AI Client identifies other Projects, preserves unknown
provenance, and treats shared history as one underlying source rather than independent
corroboration. No reranker, model service, or backend synthesis is introduced.

Deterministic PostgreSQL vectors compare the baseline Global pool with candidate
recovery, stronger foreign evidence, overlapping pools, historical unknown evidence,
owner isolation and mixed summary lineage. Existing worker evidence-selection
regressions cover parent summaries and partial children. Durable task tests verify
known and unknown Global context through encrypted worker replacement.

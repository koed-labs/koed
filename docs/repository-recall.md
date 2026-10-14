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

Team fingerprints are unsalted selected-remote hashes. A Team member may guess a
repository name and compute its normalized fingerprint. This accepted exposure
does not bypass Share Grant or Workspace authorization. Personal Device Sync
continues to use its separate encrypted, group-keyed boundary.

The full Team milestone still requires the explicit snapshot update action in
ticket 15 and the Team Global preview in ticket 18. Release remains gated by
the complete Project cutover in ticket 16.

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

## Resolve Before Accepting Work

For Project scope, the local adapter resolves the caller's cwd through shared
Project discovery. Subdirectories resolve to the Git root. An explicit path or
catalogued local Project id resolves that requested Project only. An unknown
Project, missing checkout, invalid selected anchor, or failed probe returns a
resolution error. It does not substitute the caller's repository or Global scope.

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
User assignment. An override can be portable, device-local, non-Git, or explicitly
unresolved. It replaces the automatic identity rather than adding a matching value.

**Manage Captured Session** moves one session or resets its override. Each request
includes the assignment version the User inspected. The API atomically compares
that version and updates both the override and version. Stale owner requests
return 409; missing or other-owner sessions return 404. Capture observations do
not overwrite this state. Reset restores the original automatic identity, or
unresolved history when no automatic identity was recorded.

The Desktop Personal contract is version 9. Graph thread responses carry the
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

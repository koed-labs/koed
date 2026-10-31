# Personal selection contract

A selection contains the owning User, one target, and separate caller repository context.
The target determines the source boundary.
Caller context supplies Git provenance for Global repository preference and cannot replace the target.
The connected AI Client continues to synthesize answers and summaries.

## Identity and source context

The shared schemas live in `packages/shared/src/personal-source-contract.ts`.
Project references contain an owner and an opaque Project identifier.
Folder references also contain the originating deployment, device, profile, and directory incarnation.
An incarnation identifies one directory lifetime and prevents a replacement directory from inheriting the old identity.

Folder paths remain display and provenance fields inside authorized Personal storage.
The registration layer normalizes paths with the existing platform rules.
Selection compares the established Folder identity rather than paths, prefixes, or enclosing Git roots.
Parent, child, sibling, foreign-device, and replacement directories require separate identities.

A logical source reference contains the owner, originating deployment, originating device, and logical Conversation identifier.
It preserves the native `logical_session_id` rather than a receiving database Session UUID.
The receiving adapter must establish this reference from verified source binding and authenticated transport.
Source fingerprints and existing logical Memory identities remain unchanged.

The shared source-binding schema separates pending sources from available local Sessions.
A pending reference cannot carry a local Session identifier or create source content.
When a verified source arrives, the binding can become available.
Parsing a reference never proves ownership or source authority by itself.

Git and Folder assignments retain separate original facts and correction revisions.
Each fact is known or unresolved, with an explicit reason.
An unresolved correction suppresses the original until an explicit reset.
Reset selects the retained original, including unresolved historical context.

New Git facts accept portable and device-local repository identities only.
Named Projects and non-Git directories do not become Git facts.
The existing assignment and signed package schemas stay available for compatibility.

## Targets and legacy decoding

`personalSelectionSchema` accepts version `1` only.
Its target kinds are `project`, `repository`, `folder`, `session`, and `global`.
Project, Folder, and Conversation targets carry owner-scoped references.
Repository targets carry the selected Git identity under the current anchor rules.

`normalizePersonalSelection` parses selector fields at the adapter boundary.
Callers must pass only those fields, before legacy schemas inject defaults.
An explicit `recall_target` cannot accompany legacy `search_domain`, `project_id`, or `session_id` selectors.
Conflicting or unresolved selectors fail without a Global fallback.

Legacy Git requests preserve their selected identity.
Their `project_id` must match the canonical repository scope, its pinned root, or an exact established alias.
Alias lookup must use an owner-authorized mapping.
It must not perform prefix matching, follow organization routes, or discover a worker directory.

Legacy named and non-Git identities require exact established mappings.
A named identity maps to a Project reference.
A non-Git identity maps to a Folder reference only when retained provenance establishes that Folder.
Both an explicit alias and its pinned legacy context must identify the same target.

Legacy Conversation identifiers require a verified logical source lookup.
Unknown identifiers remain errors.
With no explicit selector, the adapter must supply trusted Git or exact Folder context before task acceptance.
The contract does not infer an umbrella Project from that context.

`PersonalSelectionBoundary` defines the common source-resolution interface.
Its implementation must apply owner authorization, source eligibility, deletion, time bounds, and current membership before candidate limits.
It must repeat those checks during expansion.
Mixed summaries require source checks before disclosure.

## Membership revisions

`personal-membership-contract.ts` defines immutable membership operations.
Each revision records the owning Project, stable entity identity, revision identity, author device, and reviewed prior revisions.
`replaces` names the exact prior revision set reviewed by the caller.
It does not use device clocks or arrival order to resolve conflicts.

Operations create or rename Projects, delete Projects, include sources, remove inclusions, exclude Conversations, and clear exclusions.
Direct inclusions reference one logical Conversation.
Rule inclusions reference one selected Git identity or one exact Folder identity.
No inclusion accepts a Project, so Projects cannot nest.

Removals require reviewed revisions and remain immutable records.
The storage layer must retain entity type, selector identity, and removal history across replay.
It must reject stale revision sets and cross-owner references at every mutation.
The database and encrypted journal retain those revisions.

One selected Conversation can retain several inclusion reasons.
Each reason identifies the inclusion, its revision, and its kind.
An exclusion takes precedence within its Project only.
Pending and conflicting bindings cannot widen membership.

## Selection authority

Global preference remains in `repository-recall.ts` and `global-repository-context-sql.ts`.
New Project membership cannot change a source's Git classification.
Team requests retain their current authorization, repository snapshots, consent, grants, representations, and source-access contracts.
None of these Personal types permits Team publication.

## Project initialization

A User creates Projects directly
in the owner-scoped database catalog. No legacy catalog import, ownership
confirmation, upgrade repair, or activation command is required. Git and Folder
source context and Capture Policy remain independent of Project membership.

Already-applied SQL migrations remain immutable. Application services expose no
Project conversion workflow.
Existing source provenance and signed Personal sync packages retain their own
validation boundaries. The absence of a Project upgrade never permits guessing
source attribution from a name or today's directory.

## Durable requests and raw evidence

New Personal task requests use envelope `requestVersion: 1`.
The database binds one selection to the authenticated owner before acceptance.
It stores that selection with the request inside the existing encrypted payload.
Plain task rows retain the encryption marker, without source paths or selection metadata.

The selection snapshot supports two explicit versions.
Version `0` preserves legacy Project assignment and local Session semantics.
It records an exact pinned repository identity, a local Session identifier, or Global with separate caller context.
Version `1` uses the new Personal target contract.

Unsupported transport targets return `personal_selection_incompatible` without a broader fallback.

The scheduler passes the accepted selection through trusted execution context.
It does not expose that context as an AI Client tool argument.
Workers make sure that the owner and pinned input still agree with the selection.
Retries never discover the worker directory or follow a new organization route.

Supported old tasks keep their original request format and pinned target.
Terminal task results remain readable through the existing collection path.
Unknown request versions, unknown selection versions, and malformed claimed requests settle with an explicit compatibility error and no retry.
The scheduler releases execution capacity when those requests fail.

Team requests retain their existing authority and request path.
They cannot carry a Personal selection envelope.
Search requests also reject a Personal selection combined with a Team Workspace.
No new target creates Team authority.

Raw retrieval uses `packages/db/src/personal-selection-sql.ts`.
It converts compatible selection versions to one source boundary and checks owner, source eligibility, deletion, and sync readiness.
Raw candidate queries apply that boundary before limits.
They retain the existing time filters, retrieval budgets, and deduplication.

The database projects non-Global targets into the supported query fields.
Global caller context comes from the accepted snapshot rather than a worker argument.
Global requests can retain their supported narrower query filters.
The source boundary remains authoritative if a later query asks for a broader domain.

Raw hydration repeats source selection and time checks before decrypting source text.
A source that no longer qualifies cannot return through a previously selected raw candidate.
The same selection boundary applies to derived evidence, recursive expansion,
Desktop inventory, and graph views.

## Derived evidence policy

A synthesized summary or Curated Memory assertion can combine several sources.
The source boundary must authorize every contributing source before that text becomes evidence.
The selection boundary withholds synthesized text when any source is outside the selection, deleted, ineligible, missing, or unresolved.
This engineering rule prevents retained summaries from disclosing removed source content.

Expansion can return qualifying raw evidence from a mixed summary.
It resolves current database source links and repeats ownership, eligibility, selection, and time checks.
Retained source-item text and its recorded context cannot authorize expansion.
Fully selected sources retain their summaries, lineage, citations, and existing retrieval budgets.
For an LCM Placeholder, retrieval can return a current outline of selected raw sources.
It rebuilds that outline from eligible source records and withholds retained placeholder text from outside the selection.

The shared implementation lives in `personal-derived-selection-sql.ts` beside the raw source boundary.
It checks current node ownership, source eligibility, selection, time bounds, and missing lineage before candidate limits.
It bounds recursive traversal to 32 levels and rejects cycles or incomplete lineage for synthesized text.
Hydration repeats these checks before decrypting a retained candidate.

Curated Memory retains its existing distinction between contributing evidence and reconciled expansion aids.
The four contributing source roles determine whether the assertion text qualifies.
An auxiliary bundle or summary grants no source eligibility.
An unavailable auxiliary link does not invalidate an otherwise eligible assertion.
Search filters source metadata before decryption, and expansion checks each linked source independently.

`curated-memory-recall.ts` uses this boundary for plaintext and encrypted candidates and linked LCM evidence.
`curated-memory-records.ts` applies the source boundary before exact-quote candidate limits.
`personal-expansion-sources.ts` loads current message records and eligible child summaries.
Recursive event expansion and supporting context in `repository.ts` also use current source records.
None of these paths uses retained source-item text as authorization.

The accepted snapshot now travels through the expansion API and Curated Memory search.
The Personal query owner must match the authenticated User.
Team adapters reject Personal selectors before forwarding metadata upstream.
Unsupported target fields also fail explicitly instead of disappearing into Global defaults.

Owner inventory and graph listing readers in `memory-node-repository.ts` use the same selection boundary.
The current work does not activate Project membership, Folder capture, or the final data transition.
Completed task history retains its versioned request compatibility contract.
Current source checks apply to live retrieval, hydration, and expansion.

## Owner inventory and graph inspection

The owner inventory carries the same accepted selection through Conversation inventory, Project
counts, graph candidates, node details, event details, and the deprecated browser
and cluster readers. Conversation lookup by local Session or logical Memory also
uses this boundary. Owner checks and exact target matching run before pagination
and candidate limits. Unknown targets return no sources. A snapshot belonging to
another User fails before the source query.

Event inspection selects and materializes the authorized, ordered page before
hydrating linked-node metadata. The metadata aggregate preserves every selected
event, and each linked node still passes the existing recursive source proof.
This bounds metadata work to the page and avoids repeating its lineage query
across the event-source branches. Cursor order and page membership stay unchanged.

Inspection keeps the existing raw-source view. Trusted inspection readers can
show a captured source that is still pending semantic processing. Raw Approval
Activity remains visible under its existing presentation policy. The diagnostic
`unassigned` group is an exact inventory filter, not a new recall target.
Explicit `includeInvalidated` history still checks the owner and selected target.
These read options are internal to inspection; they do not become accepted recall
snapshot fields or relax semantic retrieval.

Graph and browser summary bodies require every contributing source to pass the
shared recursive proof. The owner can still inspect a standalone node with no
source records, source snapshots, or LCM algorithm, including one created with a
summary-model annotation. Semantic recall retains its stricter source-less-node
rule. Graph details load exact related node identifiers within the same selection
and reconstruct source items from authorized live records and child summaries.
Retained source-item snapshots do not supply current source text.

Graph node and browser readers repeat source authorization before decryption.
Graph overview and Conversation index responses are read fresh rather than
cached across source lifecycle changes. Embedding totals count eligible selected
sources. Global embedding configuration and health remain server diagnostics.

A grouped Conversation retains an optional `sourceReferences` array through the
database, API response, Desktop boundary, and UI data model. Each local binding
contains its Session identifier, native logical Conversation identifier, and
optional logical Memory identifier. The compatibility navigation fields remain.
The array preserves distinct bindings without inventing device or deployment
identity. Verified source bindings establish origin separately. Desktop does not
implement a separate membership predicate. Capture and organization writes remain independent.

## Named Projects and direct membership

The Personal Project schema provides the
owner-scoped Project catalog, direct inclusions, and a retained local revision
journal. Names do not establish identity. Each Project has a stable UUID,
metadata revision head, and a version used to reject stale organization writes.
Membership edits also advance that version. Each inclusion keeps its own stable
identity and revision head. Removal and Project deletion retain their records
and do not delete source Memory.

The focused `personal-membership-repository.ts` owns the mutations. A write
locks the owner journal before the Project so committed cursor order is stable
for that owner. Every direct addition resolves an active owned Captured Session
and stores its native `logical_session_id`, rather than a physical receiving
Session identifier. The database source journal can supply verified origin
metadata. If that origin is missing or ambiguous, the portable source reference
stays null. The inclusion remains local; it cannot be exported as an invented
origin reference. Synchronization requires a verified source binding.

The `/v1/personal/projects` routes expose the new catalog and versioned
organization operations. They accept a local Session identifier for a direct
addition; they do not accept arbitrary owners, source origins, nested Projects,
source overrides, or Capture Policy changes. Explicit version-one Project
snapshots select live inclusions through the common source predicate, including
direct inclusions and retained Git Anchor rules.
Git selection and Global repository classification continue to use recorded
source context.

Desktop now loads new named Projects from the backend, including empty Projects.
It retains named Project identity when members share a Git Anchor. The Conversation
inclusion dialog lists named Projects separately from recorded source context.
A User can add one Conversation to two Projects, remove one inclusion, rename a
Project, or remove its grouping. All writes include the Project version inspected
by the User. New organization controls never call the legacy Move paths or write
new named entries to the local catalog.

The version-11 Desktop contract carries the Project record, native Conversation
identity, source context, and inclusion reasons. Named inventory groups by native
Conversation binding and preserves provider thread labels separately. Parent links
are projected only through sources already selected for that inventory. Timeline
pages and exact-event reconciliation carry both the selected Project and local
Conversation identifier. The same source predicate checks both before limits.

All questions are submitted through the Ask page. Project and Folder detail
views have no separate Ask buttons or question dialogs. The backend pins
the accepted selection on the pending Ask record before retrieval. Retries cannot switch
selection, and an Ask thread cannot change its selection. Named Project Ask does
not reuse earlier answer text as current membership evidence. Every retrieval
search and expansion carries the accepted Project snapshot, including if a worker
asks for a wider query domain. Trusted durable Project requests also keep that
snapshot and do not rediscover a checkout or route through ambient Team settings.
Migration `0048_personal_project_model` adds Project scope to Desktop Ask records.
The public recall-target boundary is described below.

## Exact Folder capture and selection

Folder context is independent of repository assignment. Live capture records an
exact normalized absolute directory, the original path for display, and an opaque
Folder reference containing owner, deployment, device, profile, and directory
incarnation. The local registry uses the directory's device, inode, and birth time
to distinguish a replacement at the same path. A missing directory, unavailable
birth time, or unhealthy device identity leaves the observation unresolved.
It does not fall back to the Git root or the process working directory.

The profile registry is stored in `config/folder-contexts.json`. Native source
records in `data/source-folder-contexts/` retain the first Folder observation,
including a durable unresolved original, separately from the latest observation.
Capture hooks pin the original only for an explicit new-session start. Managed
Conversation creation records the original before capture registration; resumed
and unrecognized historical sources cannot fill a missing original from current
disk state. The Pi Local AI Runtime endpoint accepts authenticated source context
observations without exposing a new agent-facing tool. Unrecognized Pi start
reasons remain unresolved. Native historical import reads recorded evidence only.

Migration `0048_personal_project_model` gives existing Sessions an unresolved
historical Folder assignment. Registration binds new source-time evidence to the
authenticated owner, pins it once, and inherits the earliest assignment when a
logical Conversation receives a new physical Session row. Repeated capture stores
later Folder observations in a separate, deduplicated table. Missing source-time
evidence cannot silently promote an existing unresolved assignment. Folder
correction state is interpreted independently from Git correction state.

A version-one Folder selection compares the entire effective Folder reference
inside the common Personal source boundary. Parent, child, sibling, another device,
profile, or incarnation cannot satisfy that equality. The compatibility Project
routing string encodes all reference fields; it grants no repository membership.
Raw and derived evidence, current source lookup, and graph inspection use the same
boundary. Explicit unresolved corrections suppress original Folder matching.

The authorized Folder inventory endpoint projects exact source-selected
Conversations into separate Desktop Folder rows. It preserves recorded Git
provenance and source bindings. Timeline requests carry the full Folder reference
and narrow to the selected physical Session. Desktop Ask pins the Folder before
retrieval and forwards its selection to every search and expansion. It does not
reuse previous answer text as current evidence or discover an ambient repository.
Like named Project inventory, this view reports an error above 5,000 Conversations.
Complete enumeration uses the separate bounded selection APIs.

## Git Anchor inclusion rules

A Git Anchor rule independently retains one selected Git Anchor.
Migration `0048_personal_project_model` creates `personal_project_rules` and
extends the owner journal with repository inclusion revisions. Each rule stores
its own identity, target, version, revision head, and removal timestamp. The
canonical scope key is constrained to the recorded Git target. Adding the same
active anchor from a matching clone is an idempotent operation; re-adding a
removed rule retains its identity and replaces its prior revision head.

Rule mutations use the same owner journal lock, active-owner check, Project lock,
and optimistic Project version as direct inclusion. They write organization
records only. They do not update Sessions, captured context, Capture Policy,
embeddings, or Team access. Project deletion makes retained rules inactive through
the Project tombstone. Verified synchronization retains these records.

The common Personal source predicate now admits a Conversation to an active named
Project through either a direct logical Conversation inclusion or an active Git
Anchor rule. Rules compare the effective recorded Git identity under the existing
anchor equality rules. Portable anchors match across clones and worktrees;
device-local Git stays bound to its originating device. Paths, display names,
additional remotes, aliases, and unresolved context cannot broaden membership.
Existing and future Conversations are evaluated at read time. Rule removal leaves
direct inclusions and independent Git recall intact. Raw evidence, summaries,
Curated Memory, expansion, graph inventory, source lookup, and named Project Ask
all retain the common source boundary and its live hydration checks.

The Personal Project API exposes owner-authorized rule listing, preview, addition,
and removal. Preview selects the Git Anchor directly, without including other
members of the named Project. It returns bounded matching Conversation identities
and names. It validates the inspected Project version, while the subsequent write
also rejects a stale version. Inventory returns each matching rule as a separate
inclusion reason and retains the Conversation's original Git provenance.

Desktop contract version 13 carries rule records and explicit preview/add/remove
commands. The main process maps every command to a fixed endpoint and method.
The transfer card supports discovered checkouts with no current Conversations
and requires a matching backend preview before addition. It replaces the earlier
separate Git Anchor and Folder inclusion dialogs; future matching captures are
included through each retained rule. Removing a rule preserves direct
inclusions. Conversation controls distinguish a Git rule from direct inclusion.
The shared inventory helper reports an explicit error above 5,000 Conversations.
Complete cursor enumeration uses the bounded selection APIs.

## Exact Folder inclusion rules

A Folder rule retains one exact originating Folder target.
Migration `0048_personal_project_model` adds recorded Folder display context and
allows Folder inclusion revisions in the owner journal. The rule's scope key
contains the owner, originating deployment, device, profile, directory incarnation,
and Folder identity. A database check binds that scope and any display reference
to the target and owner. Existing Git rule identities and revisions are preserved.

A native Folder addition accepts a full reference, never a directory path.
It resolves established owned source facts or the Project's retained rule context.
Unknown references are rejected, and a foreign owner is rejected before source
lookup. Display provenance comes from recorded Folder facts, including the
normalized and originally captured path. Neither preview nor mutation reads the
receiving filesystem or uses the import worker's directory to supply history.
Retained rule context permits re-addition after the original source is deleted.
Removal retains the rule identity and causal revision chain.

`personalProjectRuleMatchesSql` is shared by live membership and the bounded
inclusion-reason reader. Folder rules compare the entire effective known Folder
reference. Parent, child, sibling, another device or profile, a replacement
incarnation, and unresolved context cannot match by path similarity. Git remains
an independent fact. Future Conversations from the same originating Folder join
at read time even if their selected Git Anchor differs. No source assignments or
embeddings are rewritten. Removing the Folder rule preserves direct inclusions
and independent Folder recall.

Project inventory now obtains all direct, Git Anchor, and Folder reasons through
one owner-scoped database reader. It uses the common owner, lifecycle, and matching
predicates in inspection mode, deduplicates the physical source query, and omits rows that
no longer have an eligible inclusion. Display code does not infer a Folder reason
from the working directory or Git root. The same reader supports membership
explanations, exclusions, and the bounded change-cursor contract.

The authorized preview and rule API accept either an established Folder reference
or a Git Anchor under strict, distinct inputs. Desktop contract version 14 adds
Folder preview and addition commands. Shared controls provide separate Git Anchor
and Folder dialogs, require an authorized matching preview, show recorded Folder
provenance, and state that only the exact originating Folder is included and
subfolders are separate. The main process uses fixed preview/add/remove paths;
client-supplied display metadata is not an authority input.

## Membership explanation and Project exclusions

An exclusion retains one owned
Project and one logical Conversation. It has a stable identity, version, and
revision head. A clear revision leaves the row in place. Source deletion does not
remove this organization history. Physical Project or account deletion retains the
existing cascade policy.

The owner serializes organization changes through the existing journal lock.
Each change requires the reviewed Project version. The active exclusion takes
precedence over direct, Git Anchor, and Folder inclusions. Removing an inclusion
or rule does not clear the exclusion. Changing another Project does not clear it.
The common source selector applies this boundary before retrieval limits and again
at hydration. Raw evidence, recursive derived evidence, Curated Memory, graph
inspection, and expansion use the same boundary. Independent Git, Folder, Global,
and other Project selections do not apply this exclusion.

The explanation operation locks the owned Project and active source. It returns
all matching inclusion reasons and the current exclusion without source bodies.
Its internal metadata query ignores the exclusion to explain the blocked reasons.
Public selections cannot request that exception. The explanation reports effective
membership from the current reasons and exclusion together. Inventory continues
to return one logical Conversation with all eligible reasons.

The strict Personal API provides explanation, exclusion, and Add-back operations.
Desktop contract version 15 maps each command to a fixed API path. The renderer
shows the current reasons after direct removal and offers explicit exclusion.
Add back uses the reviewed Project version and exclusion revision head. A stale
head returns 409 even when the caller supplies a newer Project version.

Add back clears the exclusion and ensures a direct inclusion in one transaction.
This restores membership even when all matching rules were removed. An active
direct inclusion keeps its identity. A removed inclusion returns with its retained
identity and a new revision. Ordinary direct addition cannot clear an exclusion.
Native organization changes use recorded source provenance only. They do not
infer source origins from the receiving deployment or its working directory.

## Reviewed source corrections

Git and Folder corrections remain separate. A Project cannot be a correction
target. The strict contract accepts an established Git Anchor or exact owned
Folder reference. It also accepts explicit unresolved state and reset to the
recorded original. The API resolves display context from owned recorded facts.
Caller-supplied paths do not establish an identity.

Git retains its original automatic identity and independent assignment version.
Folder retains its original fact and independent revision. A correction changes
only its selected context. Explicit unresolved state suppresses the original
until reset. Reset restores the original, including unresolved historical facts.
The source lookup distinguishes missing live Git evidence from unresolved history.
Legacy source identities remain available in the native columns and audit record.
They cannot become new Git correction targets unless they identify a Git Anchor.

Migration 0053 adds retained review and audit tables. A review binds the owner,
native Session, logical source, context, expected version, proposed change, and
Project effects. The review contains metadata and no Conversation bodies.
Preview creates a hypothetical Session record within the query. It does not
write the proposed source context. The shared rule predicate computes inclusion
reasons before and after correction. Direct inclusions and active exclusions
retain their effects. The preview records the current owned Project catalog,
versions, and matching inclusion revisions.

Apply locks the owner journal and source. It checks the reviewed source state,
independent version, Project catalog, and membership effects. An intervening
change returns 409 and requires a new preview. The transaction changes the
selected source context and appends one audit revision. It does not rewrite
Project memberships, rules, exclusions, embeddings, or Team Share Grants.
Retrying an applied review is safe while its resulting source state remains
current. Replaying it after another correction returns 409.

Migration 0054 stores the Git correction head on the native Session. It also
backfills matching heads from the retained audit. Native replacement capture
inherits the latest version of each independent context and its correction head.
It preserves original facts. Legacy assignment writers clear a superseded head.
A new native logical identity does not receive direct inclusions merely because
its external provider identifier matches an earlier Session. Verified canonical
source binding and cross-device transport preserve that separation.

The Personal API provides source-context lookup, correction preview, and reviewed
application under the owned Session. Desktop contract version 17 adds a separate
source-context command. Preload validates each request. The main process uses
fixed API paths and checks that responses address the requested source and review.
Desktop displays original and current facts, independent correction controls,
and the reviewed effect on Project membership. Changing a selection clears its
preview. A stale application clears the preview and requires another User action.

## Source-context transport

The source-context contract now defines signed snapshots with separate Git and
Folder histories. Each history has one complete causal head. Validation rejects
cycles, missing parents, duplicate revisions, and changes to original provenance.
Corrected assignments identify their causal revision. These structural checks do
not authenticate a publisher. The existing package signature and current device
authority checks still apply.

New closed-session format 5 and checkpoint format 6 carry this snapshot inside
the encrypted origin manifest. The secure publication path now requests these
formats after capability negotiation. Legacy builders and readers retain formats
3 and 4. Old signed package bytes remain available. New format validation
binds context to the origin and logical Conversation. It also checks the narrow
Git projection that internal compatibility adapters use. Named groupings cannot
enter that projection. Explicit wire codecs represent counters as decimal strings
because Personal Device Sync canonical JSON rejects numeric JSON values.

A separate configuration capability service stores signed protocol flags.
Migration 0055 adds this relay metadata. Advertisement bodies accept only protocol
features and expiry times. Source paths, Project names, and organization records
stay outside the capability service. A client checks the signature, current
certificate, authority head, epoch, and expiry for every intended recipient.
Missing support produces a retryable compatibility result. Negotiation runs
before opening the publication transaction. Signing checks the cached proofs
again for expiry, and the transaction checks the current authority head and
epoch. The worker refreshes capability support before uploading a queued new-format
package. An older relay without this service does not block legacy receipt.

Verified source bindings retain immutable context revisions. A binding retains the signed origin and opaque logical Conversation
identifier separately from the receiving Session UUID. Its retained package
records the signed logical identifier and encrypted-context hash. Receipt checks
these values before accepting the snapshot. The authenticated Personal group
permits translation to the local owner. Original signed bytes remain in the
encrypted archive. An equal provider identifier or receiving path cannot establish
this binding or grant local filesystem acceptance.

Both checkpoint and closed-package receipt now carry the snapshot into the local
database. Closed receipt applies context after checking the raw source for
conflicts. Sources with pending bodies stay outside Personal evidence queries.
Git and Folder revisions merge by causal edges. Missing history remains pending;
multiple heads remain a conflict. Later source receipt retains local correction
revisions. A reviewed correction replaces the exact visible frontier. Desktop
shows conflicting candidates and prevents correction while the source or history
is pending. Database guards permit verified projection and reviewed correction
while preserving raw-source immutability.

First adoption retains the native correction audit. If a later legacy edit no
longer matches that audit, receipt stays pending for explicit repair. A retained
Project source reference is never silently replaced with different provenance.
New references use an available verified source binding when one exists.

The origin snapshot preparer reconstructs complete history from the native audit
and pins original facts. It refuses legacy edits without proven ancestry. Source
publication calls this preparer under the same owner journal lock. Histories are
bounded without discarding ancestry. A receiving Session retains its original
source identity and cannot become a new origin merely by exporting its raw rows.

Migration 0058 adds a separate encrypted configuration journal and delivery
outbox. Migration 0059 adds pending-application retry state. Each configuration record has a stable content identity and a device
signature independent of its transport. The existing encrypted Personal package
transport delivers source-context records without a new capture. The worker
checks current member authority, group head, epoch, sync policy, and delivery lease.
Recipient rotation requeues delivery. Archives retain signatures and encrypted
payloads after acknowledgement; delivery replay does not rewrite context history.
The existing Git-anchor selection journal is unchanged.

A correction received before its source body stays encrypted and pending. Its
reference can wait for a native binding, but cannot pin original facts or install
context revisions. Once an authenticated source body establishes those facts,
pending application checks them before merging the correction. Receipt and
pending replay recheck active device authority. Disabling Personal sync prevents
configuration application. Publication pause prevents outbound delivery.

The worker advertises source-context support independently of direct peer routes.
Every intended recipient must advertise current signed support before a new source
or correction package is sent. Missing support leaves the operation pending.
Configuration reconciliation failures do not stop legacy source receipt. Graph
notifications are emitted when the effective context frontier changes. Duplicate
local snapshots reuse their retained record without repeated encryption or wakeups.
Native corrections wake the local sync worker. Pending application becomes eligible
when its verified source is available. Durable retry deadlines prevent missing
capabilities or invalid pending records from causing a tight retry loop.

## Project configuration history

The membership transport foundation defines a complete causal history for one
Project entity. Project catalog entries, direct inclusions, rules, and exclusions
have distinct entity kinds. A Project's name is a value. Its portable identity
remains stable across rename and deletion.

Direct inclusion identity uses the Project identity and the signed source's
origin and opaque logical identifier. It excludes the receiving User UUID,
provider identifier, and path. Two devices adding the same verified source to
the same Project address the same inclusion. Exact Folder identity includes its
origin, profile, and directory incarnation. Repository rules use the canonical
repository scope. Names and equal paths cannot merge independent entities.

Snapshots retain all causal branches and removals. Their wire codec represents
version 1 as a string for Personal transport canonical JSON. Validation rejects
mixed Projects, changed selectors or entity kinds, missing ancestry, duplicate
revisions, and cycles. The current-device witness and historical author roles
follow [ADR 0060](adr/0060-current-device-witnesses-for-personal-configuration.md).

Migration 0060 adds membership entities, immutable revision history, and retained
resolution reviews. Portable identities and native UUID view pointers occupy
separate fields. Database guards bind an available view to its retained revision
and check any source pointer against the owned canonical source. The storage
helper translates the owner only after group authorization, preserves revision
bodies on replay, and computes a pending, available, or conflicting frontier.

Private projection helpers map portable identities and revision frontiers into
native UUID views. A missing catalog can have a diagnostic placeholder; it never
becomes a User-authored catalog revision. An unavailable direct source creates
no Session or inclusion row. Existing direct intent survives a missing body,
while common recall guards require the owned verified Session pointer. Pending
or conflicting catalog and inclusion revisions cannot widen named Project
recall. Native edits reject unresolved catalog and inclusion conflicts.

The local journal freezes exact portable parents when a User edits an existing
synced entity. Consecutive offline edits can refer to their preceding native
journal revisions. Private catalog and direct bridges retain these native audit
links before an incoming snapshot can replace a view. Historical author and
witness proof stay unchanged after the first portable freeze. Catalog candidates
include empty and deleted Projects and require active device authority and
publication policy, independently from capture.

A direct bridge requires an exact owned source binding. It can establish that
binding for an active local captured source through the existing source-context
preparation path. It cannot invent an origin for an old replica. An unavailable
or ambiguous legacy origin requires repair. A first portable freeze can prove a
canonical source alias through the exact native logical identity, retained
binding, and immutable inclusion audit. The original native source reference
remains unchanged; later edits accept that alias only with the same proof.

The configuration payload union now carries signed Project membership histories
as well as source context. Migration 0061 extends the encrypted record journal's
payload check. Receipt verifies the active signed witness and independently
checks the receiving private runtime's device and key. It freezes local catalog
and direct edits before merging a received graph. An unprovable local origin
keeps the encrypted record pending. A complete graph can apply while its source
body remains pending; it creates no source or native inclusion in that state.

Migration 0062 retains private local device attribution for User edits. Native
commands update their causal view in the same transaction, including offline
re-adds after a synced removal. This retained attribution survives unpairing and
grants no network authority. Every publication still checks active group
membership, key, epoch, authority head, and publication policy.

Catalog and direct candidate pages run independently from capture. Retained
entities without native inclusion rows have a separate bounded cursor so pending
references and removals can be forwarded. Worker publication checks the relevant
feature for each payload; a peer missing source-context support cannot block an
otherwise supported Project record. Periodic owner-authorized reconciliation
rebuilds membership views when verified bodies arrive and can run while outgoing
publication is paused. It preserves local edits before rebuilding a view.

### Reviewing Project configuration

`GET /v1/personal/projects/:projectId/sync` returns the owned catalog state and
up to 100 membership entities. `nextEntityId` continues that inventory through
`afterEntityId`. Each entity exposes its retained heads. Direct references show
whether the actual owned source is ready; an unavailable source has no local
Session identifier. These metadata reads do not add recall eligibility.

`POST /v1/personal/projects/:projectId/sync/reviews` takes the entity, current
Project version, exact expected heads, and the intended change. Catalog choices
set a name or delete the Project. Direct choices include the retained canonical
source or remove its inclusion. The caller cannot retarget a direct reference.
A removal can be reviewed before its source body arrives. Including a source
requires an active catalog; removing an inclusion can narrow pending catalog
state.

The retained preview fixes the new revision, author attribution, operation,
parents, and effect. `POST /v1/personal/projects/:projectId/sync/reviews/:reviewId/apply`
accepts the expected version and no replacement change. Apply checks the native
Project version, catalog frontier, entity frontier, relevant source readiness,
and local device attribution again. A changed review returns a conflict. An
already applied review is idempotent and does not replace newer revisions.

Migration 0063 links a local reviewed revision to its exact applied User review.
The database guard checks the owned entity, revision, parents, operation, and
complete previewed revision. This proof works without a fabricated Session,
native inclusion, or signed transport receipt. Other local edits retain their
native audit proof; remote snapshots retain their verified signed witness.

Desktop contract 18 adds the typed sync command through preload and the main
process. Project **Sync details** shows conflicting catalog choices and pending
source references. Users preview and apply an explicit choice, reload stale
state, or remove a pending inclusion. Available source titles come from the
actual matching Session in the existing inventory. Source identities remain
inspectable when a title is unavailable. Deleting a Project through review
returns to the Project list.

### Delivery and portable selection

Project configuration delivery uses signed capability proofs, outbound record
leases, PDS encryption, and verified packages. Unsupported peer capabilities block
membership publication. Project delivery remains independent from source-context
publication support.

A pending direct reference creates no Session or native inclusion. Staged source
bodies remain unreadable until verification. A review becomes stale when body
readiness changes. Reconciliation creates an owned inclusion only after verified
source arrival. An unrelated local Conversation with an equal provider ID remains
independent.

Portable Project and revision identifiers can be opaque strings. Native UUIDs
remain owned storage views. The common selection predicate resolves either the
portable identity or its owned native view through the retained catalog mapping.
Competing native and portable aliases fail closed. An opaque catalog can be
renamed and deleted through the native UI boundary while retaining its real
portable parents. Forwarding to another owner alias preserves original identity
and authorship. Old packets and newly signed rewrites of known revisions cannot
restore deleted membership. Personal configuration changes preserve Team grant
authority and source context.

## Rule and exclusion synchronization

The private rule projection helper decodes the retained canonical selector into
an owned native target scope. Git scope identity excludes display paths; Folder
scope includes its full origin, profile, incarnation, and Folder identifier,
with the receiving owner alias applied locally. A native rule UUID is a view
pointer. Adopting an existing native rule requires its retained local audit.
Pending, removed, or conflicting rule state cannot create an active rule view.
Folder display context comes from retained owned observations or the existing
rule context; the projection does not invent a path or local filesystem
association.

Rule and exclusion snapshots now use the same authorized receipt, causal history,
local audit bridges, and encrypted publication path as catalog and direct
membership snapshots. Each family has separate native preparation and retained
entity export cursors. Retained removals and references without a native view
remain publishable. Local audit intent is bridged before received state rebuilds
the Project view.

An exclusion blocks its exact verified source through the common selection
predicate even before a native exclusion row is rebuilt. Pending or conflicting
exclusion heads deny every inclusion reason. The predicate joins the retained
binding to the actual owned Session; it never predicts a Session UUID. Membership
explanations expose this blocking state without inventing a native exclusion.
Source correction previews use the same guard.

Desktop contract 19 extends exact-frontier review to rules and exclusions. A
removed rule can restore a retained selector. Review follows each causal branch
to its closest inclusion and requires an explicit candidate when different
selectors remain. Candidate display order cannot choose a winner. Clearing an
exclusion does not promise inclusion: an underlying reason and verified source
are still required. Direct inclusion previews account for exclusions, and any
change to the reviewed exclusion state makes apply stale.

The complete receiver advertises `project_membership_v1`, `project_defaults_v1`, and
`source_context_v1`. Outbound publication still requires verified peer support.

## Capture Policy independence

Project creation, membership, rules, exclusions, renaming, and deletion do not
select a Capture Target or change a Capture Pause. Current capture controls and
source-context corrections remain separate. The branch-only legacy Project
upgrade and its preserved-target repair screen have been removed.

Normal capture and recall use the current schema immediately after server startup.
No per-profile Project activation or catalog handoff is needed. Retained SQL
migration history and defensive source validation do not expose an upgrade flow.

## Bounded Personal selection consumer

### Public MCP Project and Folder selection

`memory_answer` accepts `recall_target` for an explicit Personal Project or exact
Folder. Project targets use `{kind: "project", project: {ownerUserId, projectId}}`.
Folder targets use `{kind: "folder", folder: <PersonalFolderReference>}` with the
full recorded Folder identity. Paths alone cannot select a Folder.

Do not combine `recall_target` with `search_domain`, `project_id`, `session_id`,
`team_workspace_id`, or `team_backend_id`. The runtime checks the authenticated
owner before acceptance and persists one versioned selection. It does not
discover a checkout or use a caller-to-Team mapping for these explicit targets.
Blocking, non-blocking, and remote Personal submission use the same boundary.
Every search and expansion receives the accepted selection and rechecks current
membership and source eligibility. Existing Git, Session, and Global selectors
retain their supported legacy request form.

Migration `0048_personal_summary_changes` extends the source journal to LCM node
creation, updates, invalidation, and deletion. A summary can complete after the
last captured turn, including when a manual title prevents any Session update.
These events tell the consumer to refresh selected source data through its
authorized read APIs. They contain no summary text and grant no Team authority.

Owner-authenticated metadata APIs expose bounded enumeration and changes. They do
not create a Team grant, publish to a Workspace, authorize source-body reads,
or change capture. A portable source reference identifies evidence; it does
not confer authority to share it.

| Operation                                | Request                                                                                              | Result                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /v1/personal/selections/enumerate` | An explicit Project, Git Anchor, exact Folder, portable Conversation, or actual local Session target | At most 100 source/reason entries and a continuation cursor, or a final change cursor |
| `POST /v1/personal/selections/continue`  | The opaque enumeration cursor                                                                        | The next bounded page of the same selection and snapshot                              |
| `POST /v1/personal/selections/changes`   | A final baseline change cursor or a change-page cursor                                               | At most 100 metadata events and a continuation cursor, or the next checkpoint         |

Requests accept no owner override, Workspace, inferred default target, Global
selection, database snapshot, or caller-selected page size. Each call checks the
signed-in User and cursor owner. A cursor freezes its selection; callers cannot
supply another target while continuing it. Cursors survive a service or
connection restart and expire after 24 hours. An enumeration and each unfinished
change window retain their original expiry.

Each enumeration entry contains the actual local Session ID and logical ID,
a verified portable reference when available, Git and Folder context versions,
one inclusion reason, and the current Project version where applicable. The
same source can occur several times. A consumer combines entries by local
Session ID and combines Project reasons by inclusion ID and revision ID. It
must finish every page to obtain all reasons. A direct inclusion, Git rule,
and exact Folder rule can all select the same Conversation.

A source without proven origin remains `local_only`, with a null portable
reference. Enumeration never assigns the current device as its historical
origin or predicts a native UUID from an opaque source identifier. The local
reference remains usable on this database across restarts. A portable
Conversation target resolves only through its exact available binding to an
owned native Session. A local Session target uses the actual owned ID. Pending
or stale replica bodies and invalidated or deleted sources are excluded using
the existing selection and replica-readiness boundaries.

`snapshotVersion` identifies this complete enumeration attempt. It is stable
across its pages and changes when a new baseline starts. It is not a per-source
content hash. Context versions describe source context; reason revisions
describe membership. Neither replaces the obligation to refresh selected
source data after a source-change notification through separately authorized
read APIs.

The local journal records source, membership, source-context, and availability
changes from native writes and sync-applied views. Its rows contain identifiers
and categories, without Conversation text or tool payloads. Public events expose
only an event ID and category. Notifications conservatively cover the owner;
an unrelated source can therefore require re-enumeration. They never add that
source to the frozen selection. A consumer replaces its membership baseline
only after a complete successful enumeration.

Continuous Git Anchor and exact Folder sharing also check previously known members through
`POST /v1/personal/selections/evaluate-members`. The request carries a completed
Git Anchor or exact Folder checkpoint and at most 100 exact local Session and logical Session
ID pairs. It cannot supply an owner or change the checkpoint's selection.
Any intervening selection change requires a fresh complete enumeration.

The check distinguishes a matching source, a confirmed mismatch, an explicit
retained deletion, and an unresolved source. Missing rows, mismatched logical
IDs, unavailable replicas, invalidated sources, and unresolved Git facts do
not prove removal. Folder checks use the full Personal Folder reference, including
its originating device and directory incarnation, rather than a local path or
Git identity. A confirmed result carries both Git and Folder context versions and a
context hash bound to the source; an unresolved result carries neither.
The response contains no source content or local path. It does not authorize
Team publication or remove sharing itself. The publisher must retain unknown
members until it has conclusive evidence and deliver any removal against the
current rule and member versions.

Journal IDs are page keys, not commit watermarks. Each change window pins the
transactions visible before and after the window. A writer that allocated a
lower ID but committed late remains eligible in a later window. PostgreSQL's
`pg_current_xact_id()` supplies the top-level transaction ID, including inside
savepoints, and `pg_visible_in_snapshot()` checks it against the stored
visibility set. PostgreSQL documents these functions and the subtransaction
restriction in its [transaction snapshot reference](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-TXID-SNAPSHOT).
Database snapshots stay inside owner-bound cursor records. No database snapshot
is held open between API calls. The metadata journal is retained; cursor expiry
is an observation boundary, not permission to silently discard unseen events.

A consumer follows this procedure:

1. Start an enumeration for an explicit target. Build a provisional map from
   all pages, merging repeated source/reason pairs. Keep the old committed map
   until this new baseline completes.
2. Store the final change cursor with the completed map. Polling may stop and
   resume without relying on a live notification stream.
3. Read every page of a change window. Deduplicate repeated event IDs when
   retrying a page. Save the next checkpoint only after the entire window has
   been processed. Any event requires a new bounded enumeration; source events
   also require refreshing selected source data through its read boundary.
4. If an enumeration returns `selection_enumeration_stale` (409), discard its
   provisional pages and restart. Changes committed during pagination cannot
   silently shift an offset or skip a source. Retry when capture settles if
   repeated concurrent writes prevent a complete baseline.
5. If a cursor returns `selection_cursor_expired` (410), obtain a new baseline.
   An unavailable Project or Conversation returns `selection_unavailable`
   (404); remove that selection's old consumer state. A cursor belonging to
   another owner also returns 404 and provides no data.

The consumer APIs reuse the central Personal selection predicate and the same
inclusion-reason SQL used by current membership explanations. They use keyset
pagination over actual source and reason IDs. Current Desktop Project and Folder inventory adapters consume this bounded
contract. Named Project membership does not write source assignment or select a
Capture Target.

Cursor metadata belongs to the same PostgreSQL transaction history. An Operator
performing a logical restore into a new database must discard
`personal_selection_cursors` and let consumers start new baselines. Cursors are
not portable Personal sync artifacts. The ordering and retention trade-off is
recorded in [ADR 0061](adr/0061-personal-selection-cursor-visibility.md).

## Current Personal model

Desktop contract 24 adds direct inclusion records to the Project inventory,
including retained direct reasons whose Conversations are currently excluded.
The owner-authenticated inventory uses the existing membership reader and keeps
logical Session identities separate from local source bindings. The main process
passes these records to the transfer card without expanding selection or access.
The source browser, versioned batch writes, exclusions, Undo, and scroll behavior
are documented in [Desktop Project setup](desktop-ui.md#named-project-setup).

Desktop contract 24 exposes current Project inclusion, source correction, and
Personal sync operations. It no longer exposes Project upgrade or legacy
Capture Target preservation commands. The API has no `/v1/personal/project-upgrades`
routes. Projects are usable as soon as the normal server schema is installed.

Owner inventory and recall use the same bounded selection contract. Existing
source, task, sync, and Team authorization boundaries remain in force. SQL
migrations already applied locally are retained unchanged, including unused
historical upgrade tables. They do not require an interactive transition.

Native Session replacement retains its existing Git and Folder
correction history only when the retired Session has no removal reason, Personal
deletion, legacy Project target, or independent Capture Target binding. It does
not transfer Project membership to a new logical Session. The implicit Capture
Target key must remain equal, and no policy may be bound to the retired Session
ID. Otherwise replacement could drop a policy or Capture Pause. A deleted source or an
invalidated source with a retained Capture Target requires a new Conversation;
capture cannot silently choose a replacement policy key.

## Automatic default Project convergence

The current automatic Project layer extends the existing membership history with explicit initialization and retirement provenance.
Equivalent automatic roots can resolve to one available view while retaining all original heads and authors.
Real User operations supersede an unobserved automatic root. Concurrent User operations still require review.
The database guard checks the selected retained revision and rejects hidden concurrent User intent.
See [ADR 0063](adr/0063-default-project-identities-and-automatic-provenance.md) and [Personal inventory](personal-inventory.md) for the identity rule.

The encrypted configuration payload union also carries `project_default` source decisions.
The `project_defaults_v1` capability authorizes their publication through the existing transport.
These managed, retired, and suppressed decisions prevent automatic recreation without editing User membership or source facts.
The payload check and membership view guard enforce these decisions.
Owner, witness, device, policy, and source-readiness checks remain the same as other Personal configuration.

# Team continuous sharing validation

The User authorized the fourteen Package 2 tickets on 20 October 2026 and
requested that tests run only when necessary. Validation is performed after a
slice is implemented, before dependent work relies on it. The User chose to
omit the recommended minor changeset. Subsequent development and test Team
Backends use the local Docker daemon, as requested by the User. No push, merge or deployment is implied.

Current local status: P2-01 through P2-08 are complete.
On 21 October 2026, the User approved the smaller operational alpha in the
[current tickets](../tickets.md). P2-09 is deferred with partial implementation.
P2-10 through P2-14 and the combined full-package gate are also deferred.
ALPHA-01 through ALPHA-05 are locally complete for the internal alpha trial.
The native trial verified Conversation sharing, later Memory Events, completed
LCM Leaves reaching the teammate, privacy masking, existing and future Git
membership, pause/resume catch-up, independent sharing reasons, final-stop
denial, and restart recovery of a reviewed, queued stop. The User accepted
that recovery scope; fresh offline-stop initiation remains deferred.
This is alpha trial readiness, not completion of the full Package 2 matrix.
Historical evidence below retains its original scope and does not establish
alpha readiness.

## P2-01 owner sharing explanation

Locally complete on 20 October 2026. Direct reasons have durable identities
bound to existing consent and approved repository snapshots. Owner list/detail
responses and Desktop explain fixed snapshots, active updates, pause, stop,
expiry and pending publication. Conversation Source Access remains separate.
Management metadata survives Workspace removal without restoring content
access. Team read DTOs do not serialize owner reason metadata.

The current schema was applied to a new, disposable PostgreSQL 17 instance.
The existing application database was not used. Seven focused repository cases
passed: durable explanations and removed-owner denial, the Pending Share
lifecycle and consent replacement, privacy-worker/revocation fencing,
continuous advancement, encrypted Team reads and semantic expansion, current
access gates, and one logical grant per source/destination. Existing test cases
were extended to verify stable reason identity through pause, consent
replacement and stop. Remaining unrelated repository cases were not run.

Focused Desktop checks passed 82 tests, the sharing adapter passed 51, and the
realtime suite passed 64. Shared Memory HTTP route checks passed the existing
29 cases plus the new owner-only explanation case. The new case covers browser
and scoped-device ownership, Personal-only API Token denial, another reader's
denial, and absence of reason/consent identifiers in Team reads.

Native Electron inspection used the built Desktop and synthetic source-based
sharing fixtures. Active, paused and fixed-snapshot explanations rendered
correctly. At 1280 by 800 there was no horizontal overflow and the snapshot
content preview retained 292 pixels of height. Pause and revoke refresh owner
metadata from the backend; they do not infer consent state from local labels.
Native inspection artifacts are temporary and remain uncommitted.

Workspace TypeScript compilation, Desktop typechecking, targeted ESLint,
Drizzle snapshot checks and diff whitespace checks passed. The full test-source
typecheck reported an existing possibly-undefined access at
`packages/db/tests/personal-selection-consumer.test.ts:483`, which this slice
does not modify. Changed test files are checked separately. The initial
realtime run could not bind loopback listeners inside the sandbox; the rerun
with local network access passed. Full package and staged deployment gates
remain outstanding.

Boundary documentation: [Shared Memory owner workflow](shared-memory-owner-workflow.md#owner-explanation-for-direct-sharing-p2-01).

## P2-03 Git Anchor sharing review

Locally complete on 20 October 2026.

The owner opens a recorded Git Anchor in Desktop and chooses **Review sharing**,
then explicitly selects a Team, Workspace and detail. The review follows every
bounded Personal enumeration page, merges repeated source/reason records and
shows eligible and unresolved Conversations. Future matching Conversations are
described before any publication authority exists. Refresh preserves the exact
scope; cancellation publishes nothing.

The current-code Docker Team Backend runs as the isolated local Compose project
`koed-package2` at `http://localhost:3341`, with separate PostgreSQL and Redis
volumes. It reuses the existing local Docker Embedding and Privacy services.
The existing Team Backend on port 3331 was preserved. Source/runtime consistency
checks rejected an early attempt to overlay changed compiled files onto the old
image; the accepted development image rebuilds both together. The temporary
native PostgreSQL instance used for P2-01 was stopped.

Focused API tests passed 64 cases covering the new review service, candidate
inspection, command registry, HTTP authority and route inventory. The adapter
case also passed: its Team requests contain only destination policy reads,
without a Git Anchor, local path, private label, source body or local source ID.
Existing consent, grants and publication work remain unchanged. Three Desktop
cases passed for incomplete pages, source/reason merging, stale-page discard,
exact refresh and cancellation of a running review. Source candidates use an
exact Session lookup rather than an unrelated 500-source inventory. Review
inspects current summaries without creating missing LCM work. Owner headers are
read in a bounded batch, avoiding repeated candidate reads for empty sources.

Native Electron inspection passed through the actual Git Anchor header and
review dialog. Two pages produced one eligible and one unresolved Conversation;
the repeated source was merged, future matching scope was visible, cancellation
closed the dialog and no publication command was issued.

Live Docker acceptance reviewed 102 selected Conversations in two pages, with
two eligible and 100 unresolved sources. An unrelated source was excluded.
Editing a source after the first page invalidated that review; a fresh complete
baseline passed. Browser and scoped-device owners received HTTP 200. The removed
Workspace reader and a valid Personal API Token received HTTP 403. Grant,
consent and Conversation Source Access counts were unchanged by review.

Workspace TypeScript compilation, changed-test typechecking and targeted ESLint
passed. The whole-repository test typecheck limitation recorded under P2-01
remains separate. Full package and staged deployment gates were not run.

Boundary documentation: [Git Anchor sharing review](shared-memory-owner-workflow.md#git-anchor-sharing-review-p2-03).

## P2-02 authority checkpoint (in progress)

This is partial implementation evidence, not ticket acceptance. Migration 0050
adds continuous Conversation rule authority, independent rule reasons and exact
reason-publication bindings while retaining one source/destination Share Grant.
The internal creation transaction preserves an existing direct snapshot. Owner
metadata distinguishes that snapshot from the new rule awaiting publication.
The public confirmation command and durable Desktop delivery remain
unfinished. The lifecycle follow-up below records subsequent internal controls
and automatic catch-up work. The publication follow-up below
records the subsequent backend integration.

On 20 October 2026, three focused repository cases passed against the complete
rebuilt Docker image and a fresh test database:

- Independent continuous rule consent alongside an existing snapshot, one
  grant, stable retry identity, rejected intent changes and separate owner
  explanations.
- Paused semantic access through an exact publication; deleting that binding
  denies direct reads, Workspace listing, semantic scan/search, candidate
  expansion and requests using a previously frozen recall boundary, before
  decryption.
- Existing direct reason explanation and removed-owner content denial.

The owner-only HTTP explanation case and six Desktop explanation cases passed.
Typechecking, targeted test typechecking, lint, formatting and migration metadata
checks passed. Tests were limited to the changed authority boundary and affected
explanation contract.

The isolated backend at `localhost:3341` is healthy after applying the migration.
The full synthetic fixture truth matrix and base semantic-readiness check passed
again: all 10 active items retain stored vectors across all four representations,
with Bob's Personal artifacts unchanged. Broader launch suites were not run.
These checks do not prove new rule delivery or the remaining P2-02 acceptance
criteria.

The subsequent publication checkpoint adds migration 0051's reason-specific
grant authority view, durable preparation bindings and sanitized titles on exact
representations. Three focused Docker cases passed with current source and a
fresh database: direct continuous publication after synchronization, independent
rule publication alongside a snapshot, and paused exact-publication recall.
The independent-rule case publishes all three Memory layers at revision 1,
publishes a later turn and summary at revision 2 through the target-sync hook,
retains one Workspace entry, and leaves the snapshot fixed at revision 1. A
wrong publisher fence is denied before source decryption. After revision 3 is
prepared, fixture transactions simulate pause and stop: obsolete publication is
denied, paused access retains revision 2, and stopping the rule leaves only the
snapshot's original content and title. No revision 3 representation appears.
These transaction simulations verify publication guards; they do not prove the
unfinished lifecycle commands or automatic resume catch-up. The later turn and
summary were delivered together, so delayed summary-only delivery remains to be
demonstrated.

The passing focused run selected three tests and skipped 92 unrelated cases.
PostgreSQL JIT was disabled only in that disposable correctness-test database;
the live backend retained its normal settings. Earlier failing attempts exposed
a Privacy read still using primary consent and an incomplete Workspace title
projection; both were corrected before the passing run. Typechecking, targeted
test typechecking, lint, formatting and migration metadata checks passed.

Independent detail-policy preparation, direct fidelity replacement, companion
discussion and realtime authorization still require integration before P2-02
acceptance. This checkpoint does not certify those boundaries or all ticket
requirements.

The complete image was rebuilt and migration 0051 applied only to the isolated
Docker backend at `localhost:3341`. Its readiness endpoint returned HTTP 200.
The fixture truth matrix and base semantic-readiness gate passed again with the
backend's normal PostgreSQL settings: 10 embedded items across four
representations, with Bob's Personal artifacts unchanged. The broader automated
launch suites remain `not_run`.

Fresh seeding then caught a product regression in the title-storage change:
David's **Agent Collaboration Rooms** title in **Electron Team App** appeared as
plaintext in a representation row. The existing fixture guard was preserved.
Migration 0052 restricts the row to a fixed encryption marker or null, and titles
now use Team-encrypted companions bound to the exact source revision hash.
Authorized detail and index reads decrypt those companions only after checking
current representation and Privacy authority.

After that correction, the direct continuous and paused-read cases passed, and
the independent-rule journey passed in a separate final run. Its assertions
include the decrypted index title, absence of source text in representation
routing rows, and preservation of the snapshot's title after rule stop. An
intermediate test-only SQL alias error in the storage assertion was corrected;
it is not counted as a passing run.

A fresh encrypted-title fixture seed and validation passed: seven Users, three
Workspaces, 14 Memory records, five collaboration threads and 20 fixture checks.
All 11 seeded representations have exact encrypted title companions. This fresh
database used JIT-free query planning for correctness checks; embedding readiness
was not claimed before running its Worker. The running backend's normal-setting
fixture and 10-item semantic-readiness gate passed again with unchanged Personal
artifacts. Disposable validation databases were removed afterward.

Boundary documentation: [Continuous Conversation authority](shared-memory-owner-workflow.md#continuous-conversation-authority-p2-02-in-progress).

## P2-02 internal lifecycle and durable catch-up checkpoint

Migration 0053 stores reconciliation requests and deadlines on continuous rules.
Owner-only pause, resume, stop and retry bind reviewed rule and Share Grant
versions, advance rule/consent/grant versions together, and deduplicate exact
mutation intent. Pause and stop remain available after Workspace sharing
permission is lost. Resume and retry revalidate current Workspace, publisher,
consent expiry and Privacy authority before committing.

The existing Privacy worker prepares due rules through the same authoritative
source, Privacy and publication pipeline. Resume survives repository restart
without another source-sync event. Delayed source readiness and temporary
failures retain bounded retry deadlines; repeated failures remain visible to the
owner and continue retrying. Pause and stop clear the schedule. Captured obsolete
work cannot publish or overwrite a later control.

A focused final Docker database journey passed on 20 October 2026. It verified
one rule beside an independent snapshot, later publication, pause during queued
preparation, retained revision 2 while paused, resume catch-up to revision 3
without a new sync event, and snapshot revision 1 after stop. Non-owner,
malformed-action, stale-version, changed-intent and expired-publisher controls
were rejected. Resume without Workspace permission failed before owner source
decryption. A repeated pause after resume returned current state without
reapplying pause. A failed catch-up after publisher expiry exposed
needs-attention metadata and a durable future retry; restored authority recovered
automatically at that deadline. Stop during a queued retry canceled the work,
and a delayed retry replay did not revive the stopped rule.

The final journey used the complete current Docker image and a fresh disposable
database. The latest test assertions were mounted read-only; runtime source was
not overlaid. JIT was disabled only in disposable correctness databases. Three
focused worker cases also passed: stale-preview preflight, exact cached
classification, and deadline-triggered rule preparation before Privacy targets.
Unrelated repository and worker tests were skipped.

The isolated backend at port 3341 was rebuilt, migrated and reported ready.
Its normal-setting fixture passed the full truth matrix and base semantic gate:
10 embedded items across four representations, with Bob's Personal artifacts
unchanged. Full launch suites remain `not_run`. Typechecking, changed-test
typechecking, targeted lint, formatting, migration snapshots and whitespace
checks passed. Both disposable lifecycle test databases were removed.

This is internal backend progress. Public reviewed commands, durable Desktop
delivery and owner control buttons, independent detail-policy preparation,
and the remaining Package 2 gates are still outstanding. The companion/realtime
follow-up below records subsequent integration. No P2-02 acceptance box is marked complete.

Boundary documentation: [Continuous rule controls](shared-memory-owner-workflow.md#continuous-conversation-rule-controls-p2-02-backend-checkpoint).

## P2-02 companion and realtime checkpoint

Companion discussion access and realtime events now use exact published reasons
instead of the Share Grant's primary consent. One shared SQL predicate checks
the published representation's own consent, current representation-policy caps,
reason state and publication version/fence binding. Existence checks retain one
thread row when reasons overlap. Concrete representation events cannot borrow
another reason's authority. Stopping the last permitted reason emits the
existing scope-bound revocation event to invalidate cached Shared Memory;
another permitted publication instead retains the ordinary lifecycle refresh.

Six focused Docker cases passed on 20 October 2026. Four existing policy cases
preserved cumulative fidelity, independent Curated Memory caps, immediate
restrictions and cross-Workspace denial. Removing exact publication bindings
while grant and consent stayed active denied thread access, events and replay.

The extended rule lifecycle journey verified retained encrypted discussion
history through a paused rule while the primary snapshot consent was revoked in
the fixture. Direct reads, message history and a one-entry thread list remained
authorized without duplication. The paused rule's exact revision event remained
authorized; the revoked snapshot's event did not. After the last rule stopped,
thread and message reads, writes and old representation events were denied
before Team decryption. The scope-bound revocation event remained deliverable.
Restoring the fixture's independent snapshot demonstrated retained history and
snapshot events without reviving stopped-rule events. This fixture manipulation
does not add a product restoration operation.

The existing asynchronous Pending Share companion creation and repair case also
passed, preserving its narrow owner-only activation path before Team access.
The final checks used complete consistent Docker images and fresh disposable
databases, with JIT disabled only in those correctness databases. An earlier
source-revision-view implementation was replaced by the narrower physical
publication/consent lookup; its unfinished lifecycle verifier was stopped and is
not counted as a pass. No runtime source overlays were used.

The refreshed backend at port 3341 reported ready. Its normal-setting fixture
passed the full truth matrix and the 10-item, four-representation semantic gate,
with Personal artifacts unchanged. Broader launch suites remain `not_run`.
Typechecking, changed-test typechecking, targeted lint, formatting and whitespace
checks passed. No schema migration was needed for this checkpoint. Disposable
validation databases were removed.

P2-02 remains incomplete: public reviewed commands, durable Desktop delivery,
independent detail-policy preparation, the explicit delayed-summary-only
demonstration and remaining package gates are still outstanding.

Boundary documentation: [Companion and realtime authority](shared-memory-owner-workflow.md#companion-and-realtime-authority-across-sharing-reasons).

## Independent detail and source preparation identity checkpoint (P2-02)

On 20 October 2026, focused Docker checks verified three independent-reason
combinations: a detailed snapshot beside a summary rule, a summary snapshot
beside a detailed rule, and a continuous summary direct share beside a detailed
rule. Existing consent limits and snapshot revisions stayed unchanged when the
owner ceiling expanded. The narrower continuous reason continued publishing
within its original bound policy. Direct-share replacement preserved the rule's
representations and semantic work. Stopping the rule retained the independent
direct summary. Explicit source-wide restrictions still rejected obsolete
queued publication before source decryption.

These checks exposed two preparation-identity defects. Artifact identity now
includes the selection scope, and preview identity retains its linked artifact
identity. Encrypted selection and stored routing metadata must agree. A pure
hash check verifies the foreign binding and excludes only generated self IDs.
The corrected Snapshot setup helper carries the actual reviewed mode and source
capabilities. Earlier failing attempts are not counted as passes.

The final runtime image passed the continuous-reason journey and three existing
policy/rollback cases in one Docker batch. A subsequent test-file-only mount on
the same unchanged runtime image passed both corrected snapshot cases. The
reviewed policy-expansion description check also passed. A fresh disposable
fixture verified all 11 encrypted representation titles and selection-bound
source artifacts. The refreshed backend at port 3341 passed the complete
fixture truth matrix and the 10-item, four-representation semantic-readiness
gate. Bob's Personal embedding rows and vectors were unchanged; broader launch
suites remain `not_run`.

Validation ran sequentially with the existing embedding and Privacy services.
No extra model instances were loaded. JIT was disabled only in disposable
correctness databases; the live fixture retained its normal settings. No new
schema migration was needed. P2-02 remains in progress with no acceptance boxes
completed.

Boundary documentation: [Selected detail and the owner policy ceiling](shared-memory-owner-workflow.md#selected-detail-and-the-owner-policy-ceiling).

## Whole-grant revocation and direct restoration checkpoint (P2-02)

On 20 October 2026, six focused Docker repository cases passed. Both an active
rule and a paused rule were stopped by whole-grant revocation, with revoked
consents, advanced authority and publisher fences, and no scheduled catch-up.
An exact revocation retry left those versions unchanged. A separately approved
direct snapshot restored its own access while the old rule stayed stopped.
Queued rule publication and an attempted resume were rejected before source
decryption even when the caller supplied current versions. The old rule's
representations remained invalidated, with one structural revocation audit.

Existing cases also passed for concurrent exact retries, transactional rollback
when retention policy is unavailable, companion-history restoration, and replay
after revocation outbox pruning. Restoration uses a new consent-bound
representation and retains the prior representation as invalidated. The older
expectation of reusing that representation's ID was corrected. The initial run
also exposed a test-only bigint expectation mismatch; its failed cases are not
counted as passes.

The final batch used a fresh disposable database and the unchanged complete
runtime image with only the corrected test file mounted read-only. It selected
six cases, skipped 94 unrelated cases, and completed in 85.65 seconds. No new
schema migration or model instance was needed. P2-02 remains incomplete.

The refreshed backend at port 3341 reported healthy and passed the normal-setting
fixture truth matrix and all 10 embedded items across four representation
types. Personal embedding rows and vectors were unchanged. The broader automated
launch suites remain `not_run`.

Runtime image build, changed-test typechecking, targeted lint, formatting and
whitespace checks passed. All seven disposable databases used by the independent
detail and revocation checks were removed; the live fixture was preserved.

Boundary documentation: [Whole-grant revocation and later direct sharing](shared-memory-owner-workflow.md#whole-grant-revocation-and-later-direct-sharing).

## Reviewed Team rule-control API checkpoint (P2-02)

On 20 October 2026, the Team API gained owner-authorized pause, resume, stop and
retry for one Conversation sharing rule. The request and Action Grant bind the
exact rule, reason, Share Grant, destination, action, mutation identity and
reviewed authority and grant versions. Native review names the Conversation,
Team, Workspace, selected detail and consequences. Execution uses the existing
transactional control and Action Grant receipt path.

Ten focused API cases passed: four action-review and request-binding cases,
four route-forwarding cases, credential and strict-input rejection, and native
Action Grant admission. Three route-contract cases verified the exact inventory
and explicit session-or-device security for the new endpoint. The new native
admission test initially expected `pending`; it was corrected to the existing
`review_required` public state. The inventory expectation was extended for the
new route. These failed attempts are not counted as passes. Corrected test files
were mounted read-only on the unchanged complete runtime image; no runtime
source overlays were used.

One focused repository case passed in a fresh disposable Docker database. It
verified owner-only review, exact source/destination/version bindings, valid
actions in active and paused states, denial after sharing permission loss,
continued owner authority to stop, and wrong-destination rejection before
mutation. Review did not decrypt owner source or publish through the rule. Its
independent direct snapshot remained separate. The check selected one case,
skipped 100 unrelated cases, and completed in 22.24 seconds.

The refreshed backend at port 3341 reported healthy and passed the normal-setting
fixture truth matrix, encrypted-content checks and the 10-item,
four-representation semantic-readiness gate. Personal embedding rows and
vectors were unchanged. No extra model instance was started. Validation batches
ran sequentially. JIT was disabled only in the disposable correctness database;
the live fixture kept its normal settings. Broader launch suites remain
`not_run`. No schema migration was needed for this API checkpoint.

The consistent runtime build, source and focused test typechecking, targeted
lint, formatting and whitespace checks passed. The disposable validation
database was removed; the live fixture and existing backend/model services were
preserved.

P2-02 remains incomplete. Public rule creation, local durable delivery,
pending-versus-acknowledged Desktop state, owner control buttons and the remaining
acceptance demonstrations are still outstanding. No acceptance checkbox was
marked complete by this backend checkpoint.

Boundary documentation: [Continuous Conversation rule controls](shared-memory-owner-workflow.md#continuous-conversation-rule-controls-p2-02-backend-checkpoint).

## Retained Team embedding gate

The isolated Docker fixture initially reported
`SharedMemoryPersonalEmbeddingReuseConflict` for **Removed Member Deployment
Note**. The retained contribution's owner has no current Workspace sharing
permission, which the Personal-vector reuse path requires.

Personal reuse discovery now requires current owner, membership, Workspace
write and sharing authority before reading Personal embeddings, and locks that
authority through the embedding handoff. The reuse commit also locks its
permission checks. Without Personal reuse authority, the existing worker
computes from the authorized sanitized Team derivative instead.

On 20 October 2026, the rebuilt Docker backend at `localhost:3341` processed
the fixture's failed item through the normal embedding workflow: one processed,
one embedded, zero failed. A before/after digest confirmed Bob's Personal
embedding rows and vectors were unchanged. No Personal vector was invalidated.
The full fixture truth matrix and base launch semantic-readiness check passed:
10 embedded items covering Memory Events, LCM Leaves, LCM Rollups and Curated
Memory. Bob remained denied Cloud Workspace reads; authorized readers retained
access. This base check reports the broader automated launch suites as
`not_run`; it does not certify the unimplemented Package 2 tickets.

Seven focused repository cases passed in a separate fresh Docker database:
Workspace removal, read-only access, removed sharing permission, disabled Team
membership, disabled owner, revocation after claim, and revocation during the
authorized embedding handoff. Each permission-loss case first proves the exact
Personal artifact eligible, then rejects its queued reuse hint after permission
changes, computes from the Team derivative, and verifies the Personal row and
vector remain intact. Typechecking, targeted test typechecking, lint, formatting
and diff checks passed. The initial Docker setup timeout and corrected test
setup attempts are not counted as passing runs.

## Durable local rule-control delivery checkpoint

On 20 October 2026, the local control path gained an encrypted delivery journal
and Desktop pause, resume, stop, and retry controls. Migration 0054 adds the
journal. Native review supplies the exact Conversation and destination labels.
Desktop keeps the current Team state visible until the Team returns a receipt.
A pending stop explicitly warns that Team access can remain.

One focused database case passed against a fresh disposable database on the
existing local Docker PostgreSQL service. It proves encrypted credentials and
labels, restart recovery, exact retry after custody expiry, conflicting request
rejection, owner isolation, worker lease fencing, receipt matching, and credential
removal on enrollment revocation. The case needs no Memory fixture or model.

One focused API case passed. It accepts an approved control without a Team
request, simulates a lost response, restarts the controller, and recovers the
receipt with the original request and token after approval custody expires.
Local grant records stay unchanged. Three command-registry checks also passed.
Initial test failures involved cancellation-signal comparison and an incorrect
fixture baseline. The corrected passing run compares the exact wire request
and preserves the existing grant baseline.

Two focused Desktop and broker checks passed. A queued stop disables duplicate
controls while the active Team state remains visible. Local delivery status
reads retain the backend identity without requiring a fresh Team capability
response. Current credentials and enrollment remain required.

The consistent Docker runtime build, source typecheck, focused test typecheck,
targeted lint, formatting, and whitespace checks passed. The broad fixture matrix
was not repeated for this local delivery change. The rebuilt isolated Team Backend
at `localhost:3341` reports ready with migration 0054 applied and a current source
fingerprint. The disposable database was removed. The live Team fixture and the
other backend were preserved. Existing model services were reused. No additional
embedding model was started.

These checks establish local delivery behavior. They do not establish the full
P2-02 journey. Public rule creation, direct-reason stop, later completed-summary
publication, and the complete native Desktop demonstration remain outstanding.
Native review still needs Team access before local acceptance. Offline-first
review and extended interruption recovery remain unresolved.

Boundary documentation: [Local delivery of approved rule controls](shared-memory-owner-workflow.md#local-delivery-of-approved-rule-controls).

## Reviewed Conversation rule creation checkpoint

On 20 October 2026, reviewed creation gained an encrypted local delivery path
and the existing Pending Share publication workflow. Native review binds the
Conversation, preview, destination, grant version, policy hash, and new rule ID.
The local worker recovers the original acceptance receipt before it hands source
preparation to the existing worker. Desktop distinguishes a local request,
Team acceptance, and content preparation.

Nine focused API checks passed. They cover native review and stale scope denial,
exact creation and control receipt recovery, temporary source-handoff failure,
and the current command and route inventories. Two database journal checks also
passed. Creation credentials and labels remain encrypted. Exact mutation reads
retain earlier receipts when later controls target the same rule.

Two repository journeys passed in a fresh disposable Docker database. Both use
LCM Rollup detail while the provider offers broader capabilities. They prove
acceptance, independent consent and rule creation, pause before publication,
resume catch-up without a new source event, later revision publication, and stop
while another revision waits. With an existing snapshot, stopping the rule
preserves that snapshot at its original revision. Without another reason, the
reader loses access. Personal source records remain intact. Owner explanations
list only the selected detail. A new companion discussion remains unreadable to
a teammate before published Memory authorizes it.

The journeys found an owner-only companion staging gap for empty active rule
grants. The staging check now matches the exact Pending Share, rule, consent,
source, and destination. Normal teammate reads still require published Memory.
Other failed attempts involved an incorrect owner resource lookup, an assertion
that discarded retained publication history, and reuse of a test database that
requires a fresh deployment identity. Those attempts are not passing evidence.

Four focused Desktop and broker checks passed. They prove queued creation before
Team acknowledgment and accepted source preparation afterward. They also cover
exact rule control through an activated Pending Share, retained active state
while a stop waits, and local status reads without a fresh Team capability response. A corrected
test baseline supplied the expected grant version for the Pending Share case.
An existing mode-switch check also passed. Choosing a snapshot after continuous
preview still uses the explicit snapshot sharing path.

The consistent Docker runtime build, source and focused test typechecks, targeted
lint, formatting, and whitespace checks passed. Existing model services were
reused. The broad fixture matrix and native Electron journey were not run for
this checkpoint. This evidence does not complete P2-02 or the package gate.
The isolated Team Backend at `localhost:3341` is healthy with migrations 0055 and
0056 applied. Its source runtime check reports the current build. The disposable
validation database was removed. The live Team fixture, other backend, and
existing model services were preserved.

Actual approved-device HTTP execution, other detail and Curated Memory cases,
delayed summary-only completion, and the remaining control boundaries still need
acceptance evidence. The User requested omission of the changeset.

Boundary documentation: [Reviewed creation of a Conversation rule](shared-memory-owner-workflow.md#reviewed-creation-of-a-conversation-rule).

## Curated Memory and Privacy reason isolation checkpoint

Curated reconciliation now reads independent reasons instead of the primary
consent on a grant. Rule preparation retains its captured rule, consent,
publisher and Privacy authority. Ineligible evidence invalidates only the
matching consent's Curated representation and semantic items in the same
transaction. Other conflicts preserve retained content. Reconciliation inside a
Curated edit inherits the transaction that owns the edit.

Privacy completion and failure now update pending operations through the exact
consent, including a pending fidelity replacement. An initialized pending rule
can coexist with another reviewed rule on the same grant. New-grant creation
remains serialized until its initial reason is recorded.

Focused verification covers direct Curated sharing, a Curated rule attached to
a snapshot grant, rejection of invalid encryption boundaries without content
invalidation, nested Curated transaction ownership, and a Privacy failure with
two independently reviewed pending reasons. All three cases pass against the
consistent Docker image `0d60cb2d2709`, using a disposable database and the
existing services. The final Curated rule rerun mounted only its corrected test
file; runtime source and compiled output came from the image.

The first run exposed the pending-rule creation guard and two test assumptions:
a reused temporary trigger function and an invalidation count for rows already
invalidated by database triggers. The next run passed direct Curated sharing
and Privacy isolation. Its remaining Curated rule failure occurred before
reconciliation because the test requested rollup material from a Curated-only
encryption setup. The corrected case passed separately, including reconciliation
inside an existing transaction. The full test-source typecheck, targeted lint,
formatting and diff checks also pass. The isolated backend on port 3341 now runs
this image with a current source fingerprint and a successful readiness check.
The disposable database was removed. Existing model services and the live
fixture database were preserved. These checks do not establish full P2-02
acceptance.

## Public enrolled-device execution and delayed summaries checkpoint

A real HTTP journey against the isolated backend on port 3341 now passes for
summary-level continuous sharing. It uses the public enrollment challenge and
browser approval routes to issue a disposable device credential with canonical
source provenance. The device obtains its candidate preview through the public
route, reads the exact rule review, and approves the native Action Grant.
Execution before approval and execution with a changed grant version both
return `403`. The approved request returns `202`; repeating the same request
returns an identical response. The database confirms a consumed Action Grant
and a stored execution receipt with status `202`.

This proof uses a new synthetic source with metadata only. It proves admission,
approval, execution and receipt recovery, not source upload or publication.
The retained fixture supplies the owner and destination access expectations;
its source records are not changed to bypass current provenance checks. The
new pending operation and device credential are revoked after the proof. The
existing fixture grant version remains unchanged.

Preparing this proof exposed validation setup errors rather than additional
runtime changes: retained fixture sources lack current sync material and device
provenance; a new source requires its own enrolled identity; browser and device
candidate authority cannot be interchanged; and receipt lookup must join the
public client reference through its confirmation. Cleanup now tolerates the
real worker advancing the pending operation's version.

The focused repository creation journey also passes with a delayed completed
summary. Revision 2 first arrives without summaries and cannot publish a
revision-2 rollup. A later summary-only sync package keeps both cursors at 2,
contains no event changes and retains the same Memory Event. Scheduled rule
catch-up then prepares and publishes revision 2 for the teammate without a
second source-advancement call. The journey continues through stopping queued
revision-3 work and confirms that Personal Memory remains intact.

The delayed-summary check ran only the no-snapshot variant on the current Docker
image, with the changed test file mounted read-only. The disposable database
was removed. Focused test-source typechecking, lint and formatting pass. No
runtime rebuild or additional model instance was needed. The complete native
Desktop journey and the remaining P2-02 boundaries are still outstanding.

## Policy contention checkpoint

Owner, Team and Workspace policy edits now try to lock affected active consent
and grant rows without waiting while the current policy row is locked. Busy
sharing work produces a conflict and rolls back the entire policy edit. A retry
after that work finishes uses the current policy version. Preview admission
also locks policies in owner, Team, Workspace order, matching preparation.

Six focused Docker cases pass: each of the three policy scopes is edited while
a separate transaction holds either its grant or its consent. Each rejected
edit leaves the grant active, the consent active and the policy audit absent.
After the competing transaction releases its lock, the same edit succeeds,
advances the policy version, pauses consent and makes the affected grant
unavailable. Test-source typechecking, targeted lint and formatting pass.

The isolated backend now runs the verified image `db33888dc61e`, reports a
current source fingerprint and returns `200` from readiness. The disposable
database was removed. Existing model services were reused.

## P2-02 local acceptance

Locally complete on 20 October 2026. The checkpoints above record incremental
work; their earlier outstanding-item notes describe that checkpoint's state.

| Ticket requirement                                                                                 | Local evidence                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review one Conversation, destination, detail and future scope; preserve snapshots                  | Public enrolled-device creation review and approval, rejection before approval and on changed versions, Desktop creation flow, and independent snapshot/rule creation journeys.                                                 |
| Reuse publication and lifecycle with exact reason authority and one grant                          | Exact reason/preparation/publication bindings, grant uniqueness, independent detail and Privacy checks, encrypted delivery and current-policy rejection.                                                                        |
| Current content, later turn, delayed completed summary, pause/resume and stop during retry         | Repository journeys through actual encrypted publication and teammate reads, delayed summary-only sync with scheduled catch-up, and preservation of independent snapshot access.                                                |
| Pending versus acknowledged Desktop state, durable retry, stale-work rejection and read boundaries | Desktop flow checks, encrypted journal restart/lease/receipt recovery, actual HTTP consumed-receipt replay, obsolete publication rejection, semantic/direct/companion/realtime authority checks and policy contention rollback. |

This closes the feature slice on its local API, repository and Desktop flow
evidence. It does not claim that the complete native two-owner, two-Workspace,
two-device journey has run. The ticket file explicitly assigns the combined
selector/control matrix and native UI run to the separate package gate, which
remains open. Detail-amendment receipt recovery belongs with P2-08; extended
interruption and device takeover remain P2-13 and P2-14. Independent direct-share
stop was an investigation follow-up, not a P2-02 acceptance criterion.

## P2-04 implementation started

The Git Anchor review now carries an encrypted confirmation handoff only on its
final page. It binds the local owner, enrolled upstream owner, backend, exact
selection and destination, enumeration snapshot, visibility-safe change cursor
and expiry. The confirmation resolver rechecks current destination policy and
selection changes. It neither grants publication authority nor installs a
membership baseline. Desktop rejects a final page without this handoff.

The rule schema now separates the selector from its source memberships. A
Conversation rule retains its exact source binding. A Git Anchor rule can bind
several owned sources, each with its own context evidence, consent reason and
catch-up deadline. Publication and read checks require the exact present
membership. Source failures back off independently. Migration 0057 backfills
existing Conversation memberships and moves their scheduling fields; it has
not been applied to the development backend.

The membership removal transaction checks the current publisher, fence, rule
version and member version. It records an immutable mutation receipt, fences
queued work, revokes only the member's consent and invalidates its
representations. Independent reasons survive. Removal is permitted while the
parent rule is paused; an explicit source revocation remains an owner veto.

The bounded Personal member evaluation API checks known source pairs against
an unchanged Git Anchor checkpoint. It distinguishes confirmed mismatches and
retained deletions from unresolved or unavailable sources. Only conclusive
results carry context evidence. A regression case has been written for source
identity, owner isolation, missing context, deletion and stale checkpoints, but
has not run. Focused TypeScript and ESLint checks passed. Drizzle metadata
checks passed; no new runtime tests, Docker builds or model processes ran for
this implementation step.

The Team API now has a separate Git Anchor rule review and creation operation.
Its Action Grant explicitly covers existing and future matching Conversations.
The reviewed request binds the selector, destination, detail, Curated Memory
choice, destination policy versions and hashes, Privacy policy hash, and the
completed Personal review reference. Detailed sharing requires step-up approval.
Creation accepts only an enrolled publisher through atomic high-risk execution
and checks the exact approved request before recording authority. The private
selector and approval context use owner-private encryption. The original native
decision time is retained for subsequent admission checks; execution time must
not override a newer source-owner restriction.

This operation creates an empty rule authority record. It does not publish a
source or substitute one-use source approval for ongoing membership authority.
Native review and creation commands now connect this operation to the existing
encrypted local delivery journal and acknowledgment worker. The local record
retains the full Personal selector. Its Team request contains only the approved
path-free descriptor and policy scope. A local proof check prevents substituting
that selector after native approval. New approvals require a fresh complete
review; an already approved queued request can recover its original receipt
after the observation cursor expires.

The journal distinguishes Conversation creation, Git Anchor creation and source
controls without inventing a source grant for an empty Git Anchor rule.
Migration 0058 adds this operation discriminator and preserves existing queued
controls. Both new migrations remain unapplied. Regression cases cover private
selector binding, observation expiry, encrypted restart recovery, wrong receipt
rejection and exact retries; they are written but have not run. Focused
TypeScript checks passed. The development Docker backend still runs the
previously verified build.

Team source admission now uses the same Pending Share transaction and Privacy
worker as Conversation sharing. The companion record distinguishes creating a
Conversation rule from admitting a member to an existing Git Anchor rule.
Admission binds the current publisher and fence, rule version, member version,
Personal snapshot and Git context evidence. Its acceptance receipt remains
bound to the original mutation across later activation, removal and retries.
Replaced uninitialized work is canceled before a newer member version is queued.

Activation creates independent consent and a reason under the existing source
and Workspace grant. It does not convert existing direct consent. A later
explicit owner-policy restriction can block expansion under an older rule
approval. Consent-driven ceiling activation is recorded separately from an
owner-policy edit, so an independent summary share does not implicitly restrict
another approved reason. Missing policy provenance is treated conservatively.
Removing a member also cancels its Pending Share work. Canceling an unpublished
admission records an owner veto that automatic admission cannot clear.

Migration 0059 renames and generalizes the companion table; migrations 0057
through 0059 remain unapplied. The new HTTP regression case is written but has
not run. No runtime tests or Docker rebuilds ran for this backend step.
Bounded current-member inspection and member context/removal endpoints now
support the local publisher. Inspection accepts at most 100 exact source IDs.
Positive context refresh keeps consent and advances only the member version;
it cannot resume a paused rule or revive a removed or revoked member. Removal
uses the existing reason-specific transaction and remains available while
paused. Replays return the original receipt rather than reapplying an old
context. The HTTP regression case for bounds, publisher scope and path identity
is written but has not run.

The local membership journal and bounded reconciliation consumer are now
implemented. Creation acknowledgment seeds progress in the same transaction.
The existing delivery worker drives complete enumeration, staged membership
comparison and atomic baseline installation for the active Desktop owner.
Unresolved source checks retain an unresolved goal rather than proving removal.
Per-source request leases preserve the exact outstanding mutation across newer
goals; receipt handling cannot mark a newer goal delivered. Enrollment revocation
fences leases and clears the encrypted payloads. Migration 0060 adds these local
tables and remains unapplied, alongside migrations 0057 through 0059.
This work has not yet received runtime validation.

Automatic member delivery is now connected to the existing worker. It verifies
current native source eligibility before creating a direct candidate preview,
journals the exact admission request, and queues existing Pending Share source
work only after acceptance. Context refresh and reason-specific removal use the
same journal. Receiving replicas remain unresolved rather than acquiring an
invented local origin.

An exact mutation settlement endpoint now serializes cancellation with all three
member write paths. It returns an existing accepted receipt or retains a private
audit record that rejects late execution. The local worker preserves the original
request when settlement is unavailable and never acknowledges a newer goal from
an older receipt. Regression cases for new admission, unavailable sources, lost
responses, cancellation and publisher-only HTTP access are written but unrun.
No new migration is required for settlement; it uses the existing private audit
store.

Source and test-source TypeScript checks and targeted ESLint passed for this
delivery step. No runtime test, Docker rebuild, migration application or model
startup ran. These static checks do not prove source publication or recall.

Group controls are now connected through native review, exact request binding,
the encrypted delivery journal and the Team API. Pause and stop do not depend on
the recorded publisher being available. Resume checks that publisher and the
unchanged approved policies. Stop immediately ends parent authority; bounded
worker cleanup revokes each member's reason using the existing removal pipeline.
The local work epoch prevents an older source receipt from clearing catch-up
requested by a newer group control. Migration 0060 was regenerated while still
unapplied to include that bookkeeping and group control delivery scope.

The creation dialog now enables explicit future-member sharing after a complete
review and lists existing rules, including empty rules. It routes creation and
controls through native approval and displays pending Team acknowledgment.
Focused UI and source-delivery cases passed. Native action-definition checks
passed, including all four new group-control actions. A new test initially
expected version changes to alter the operation scope hash; it was corrected to
check the request hash, which binds the versions and fence. The destination still
changes both hashes. The corrected four cases passed. Source and test-source
TypeScript checks passed. The Docker backend remains on the preceding verified
build; migrations 0057 through 0060 remain unapplied.

At that checkpoint the actual Git Anchor publication, native lifecycle and
access-boundary journeys were unverified. The subsequent acceptance follows.

The connected Docker image built successfully. Its source/runtime consistency
check passed. Migrations through 0060 applied successfully to a new disposable
Docker database. The encrypted Git Anchor creation journal case passed there,
including restart recovery, partial-baseline isolation and payload erasure on
enrollment revocation. That database was removed after the check. The retained
fixture database and the running backend on port 3341 still use the preceding
verified deployment. No additional embedding model was started.

The focused Git Anchor repository journey passed on 21 October 2026 against the
rebuilt Docker image and a fresh disposable database. It executes real native
Action Grant approval for future-member creation and group controls, and direct
device Action Grants for candidate preparation. Existing and future sources use
authentic synchronized source revisions, Pending Share admission, stored Privacy
classification results, and the separate ready-publication worker. Deterministic
384-dimensional vectors exercise actual authorized Git Anchor search and
expansion without starting another model.

The journey proves shared grant identity alongside a direct snapshot, retained
paused detail alongside a newer direct summary, reason-specific removal while
paused, resume and future-source admission, reader and outsider denial,
accepted-request recovery, cancellation before late admission, and stop fencing
already prepared later work. Bounded cleanup revokes only the rule's consent;
the direct summary and Personal source rows remain intact. An empty rule can
still be paused and stopped from another approved owner device after its
publisher expires; positive resume is denied. The Conversation creation
regression also passed in the preceding focused run. These are repository and
native-operation proofs; they do not replace the combined native UI journey.
At that checkpoint, the bounded Personal removal-evidence case and
complete-baseline/old-receipt journal checks remained outstanding. Their
subsequent acceptance is recorded below.

## P2-04 local acceptance

Locally complete on 21 October 2026. The focused publication journey above
passed. The extended encrypted journal check also passed with real Personal
selection checkpoints: complete baseline installation, source-context correction,
old acknowledgment after a newer goal and group-control epoch, verified native
source identity, invalidated-source denial, partial replacement isolation,
restart recovery, owner isolation, and enrollment-revocation erasure.

The conclusive removal-evidence case passed for matching and mismatching Git
Anchors, retained deletion, invalidation, unavailable context, wrong source
identity, another owner, and a stale checkpoint. Three HTTP boundary checks
passed for bounded inspection, context refresh/removal, exact mutation settlement,
and publisher-only admission. Focused TypeScript checks passed. No additional
model process was started. Disposable acceptance databases were removed.
The retained development backend still runs the earlier verified image; the
combined native UI and full package checks remain outstanding.

## P2-05 implementation started

Exact Folder sharing reuses the Personal Folder reference already defined by
Package 1. Its full identity includes the originating deployment, device,
profile and directory incarnation. Equal paths, parent folders and subfolders
do not establish membership. Local paths remain private.

The bounded known-member evaluator now accepts completed Folder checkpoints
and uses Folder assignment revisions and exact reference matching. It retains
unresolved or unavailable sources instead of inferring removal. A focused case
has been written for exact matches, children, parents, another device, a
replacement directory incarnation, unresolved context, invalidation and retained
deletion. It has not run.

Folder selection now connects to complete review, exact approval binding,
encrypted creation delivery, member admission, context refresh, publication
checks, group controls and Desktop owner explanations. The Personal Folder
header opens the review with its local path; that display value does not enter
the Team request. The Team descriptor is an opaque digest of the complete
Personal reference. Both context axes are required by the current member
contract, and native source verification checks their current versions.
Migration 0061 permits Folder parent rules.

The shared owner reason response now identifies Conversation, Git Anchor and
Folder rules. Conversation views send dynamic-selector controls to whole-rule
approval rather than attempting a Conversation-only control. Pending group
receipts keep the current Team state visible and prevent duplicate controls.
Focused tests are being extended across both dynamic selectors. Runtime Folder
acceptance remains outstanding. The development Docker image has not yet been
rebuilt for these changes.

The connected Folder image built successfully and its source/runtime check
passed (`sha256:e5d511d3ff854a114baf4094ffacb3db2ed292bbd667deb43dc956773ec3e8f3`).
Source and full test-source TypeScript checks passed. Fifty focused host cases
passed for review, Folder identity substitution, opaque Team descriptors,
creation and unavailable-publisher UI, reason explanations, native approval,
source delivery and API bounds. Migration metadata checks passed.

Four focused Docker cases passed after migrations through 0061 applied to a
fresh disposable database. They cover Git Anchor and Folder encrypted journals,
real native identity and correction, stale acknowledgments across newer goals
and control epochs, partial replacement isolation, enrollment erasure, and
conclusive membership evaluation. Exact Folder evaluation excludes parents,
children, another device at the same path and a replacement directory
incarnation, while retaining unknown or invalidated sources.

The two-selector publication journey reached successful publication for both
selectors, then stopped on a new owner-explanation assertion that used the
original grant lookup instead of the canonical activated Pending Share owner
record. The corrected lookup preserves and checks the same grant identity.
Its subsequent lifecycle and recall acceptance is recorded below.

## P2-05 local acceptance

Locally complete on 21 October 2026. The corrected two-selector repository
journey passed for both Git Anchor and Folder rules. It proves native creation,
existing and future publication through Pending Share and Privacy, canonical
owner explanations, pause with no source advancement, an independent later
direct summary, paused reason-specific removal, resume, retry, positive context
refresh and exact replay, Git-scoped Team recall and expansion, denied callers,
late-admission cancellation, stop fencing already prepared later work, bounded
cleanup, and unchanged Personal source rows. Empty rules still permit pause and
stop from another owner device after publisher expiry, while resume is denied.

Together with the fifty focused host cases and four membership/journal cases
above, these checks cover the new selector and all currently implemented
sharing controls. The Folder membership test uses the exact Personal reference;
Team publication retains independently authorized source Git context and does
not create a Folder organization node. Source and test-source TypeScript,
targeted ESLint, formatting and migration metadata checks passed. No additional
embedding or Privacy model was started. Disposable validation databases were
removed. The combined native UI and full package gate remain outstanding.
The retained development backend still runs its preceding coherent deployment;
this acceptance used the rebuilt isolated Docker image.

## P2-06 local acceptance

Project sharing must keep its reason while any inclusion still selects the
Conversation. Removing a direct inclusion must not change the source's Git or
Folder context. Project exclusion applies only to that Project; Workspace
exclusion remains a separate destination-wide operation. Personal Project names
and membership structure stay private.

The bounded known-member result now carries both Git and Folder context versions
for conclusive evidence. The local reconciliation journal preserves that exact
pair, allowing Project membership to depend on either inclusion axis without
mislabeling a Folder revision as a Git revision. The current alpha contract was
changed in place and its callers updated.

Project evaluation, opaque rule descriptors, approval, publication gates and
Desktop controls are now connected. Personal inventory and its Desktop adapter
carry the authenticated Project reference. The Project header opens a review
with its local name while Team operations contain only the opaque descriptor.
Owner explanations distinguish Project rules and use whole-rule controls.
Migration 0062 permits Project parent rules.

The internal sharing consumer can install a complete empty baseline for a
confirmed retained Project deletion. Public enumeration keeps its existing
404 behavior. Known-member evaluation checks Project graph readiness and the
context axes used by remaining rules. The new cases cover overlapping direct,
Git and Folder inclusions, direct-only sources with unresolved context,
exclusion/add-back, deletion, signed Personal sync receipt, encrypted journal
recovery and private labels. A pending graph entry affects removal evidence only
when its immutable selector can affect the source. A verified different portable
source cannot hold another source's sharing reason open. Sources without a
verified portable identity remain unresolved while relevant receipt is pending.

Source and test-source typechecks and targeted lint passed after the
source-specific refinement. The four focused review, delivery, review UI and
owner-reason suites passed all 46 cases. The native review, member HTTP boundary
and Personal inventory checks passed 20 focused cases.

The coherent Project image built and passed `source-runtime:check` with source
fingerprint `sha256:1a899ecf1663d8dbaca2d3ea778f3abc621132b1160f1febc4c0bf8cf222ec1b`.
Migration metadata checking and applying the schema to fresh disposable local
Docker databases passed. The three known-member cases cover Git, exact Folder
and Project; encrypted journal recovery passed for all three selectors. The
Project journal's synthetic partial page initially used an invalid generic
reason. Reusing its actual baseline reason corrected the test; that Project
case then passed against the same runtime with a read-only test-file mount.

Actual signed two-device membership receipt passed, including an unbound source
remaining unresolved while receipt is pending and a verified different source
becoming conclusively outside the Project despite that unrelated pending body.
The first full Project publication journey found premature semantic source
deduplication across independent publication records. Direct reading remained
authorized, but semantic hydration could lose its selected record. The merge
now preserves representation identity until authorization. Source typechecking,
test-source typechecking, targeted lint and formatting passed. The rebuilt
runtime passed source checking with fingerprint
`sha256:06dcd40e634650e3916ac598f9c2b5d397c3ded2a65f1a29b5363c077030b6fb`.
The Project journey passed with deliberately higher-ranked competing records,
so the regression check does not depend on random candidate IDs. Its 210-second
workflow uses actual native Action Grants, member admission, Pending Share,
stored Privacy output and ready-publication processing. It verifies current and
future members, pause/resume/retry, separate direct summary and paused detail,
independent Git/Folder/other-Project reasons, current-context refresh, replay and
cancellation fencing, teammate semantic recall and expansion, outsider denial,
cached-candidate denial after the final detailed reason ends, queued work after
stop, unchanged Personal content, and empty-rule owner controls after publisher
expiry. Fixed vectors exercise the actual retrieval boundary without starting
another embedding model. The final test changes used read-only test mounts;
runtime source and compiled output came entirely from the verified image.

P2-06 is locally complete. The combined native two-owner, two-Workspace,
two-device journey remains a separate required package gate; these focused
checks do not satisfy or waive it. Retained Team data and the running backend
were not migrated during this acceptance.

## P2-07 local acceptance

Adding a destination requires separate review and must preserve existing
destinations' detail, policy, progress and lifecycle, including paused or stopped
rules. The Conversation modal now prefers an unshared writable destination and
starts a fresh continuous review. Existing destination management already lists
individual Workspace records and rule controls.

The add-destination UI checks passed with and without another writable Workspace,
alongside the exact native-receipt creation check (three focused cases). They
verify that an existing Pending Share is preserved, the unshared destination is
selected, no existing rule/detail/revocation action is issued merely by opening
the review, and creation remains pending until its exact Team receipt. Source
and test-source typechecking, targeted UI lint and formatting passed. All five
disposable P2-06 databases were dropped after acceptance; the existing model
services were reused.

The focused Engineering/Design journey uses a single shared source, separate
device previews and native-reviewed rule approvals, different detail, and a
paused Engineering baseline with an independent snapshot. It compares stored
rule, grant, consent, policy and publication state before and after adding
Design, then checks future revisions, destination-specific publication denial,
stop and retry. The clean corrected journey passed in 71 seconds. Engineering's
rule, grant, consent, policy references and publications remain unchanged while
Design is added. Engineering retains revision 1 while paused as Design reaches
revision 2. With only Design's publication permission withdrawn, Engineering
resumes and reaches revision 3; Design retains its authorized revision 2.
Stopping Engineering's rule leaves its independent revision-1 snapshot and
Design's access intact. After permission is restored, Design's native retry
catches up to revision 3 without restarting Engineering's stopped rule. The
current owner list returns both destinations by logical Conversation identity.

Initial attempts corrected test setup rather than weakening runtime checks:
device approval requires a device-authorized preview, and the current owner
list uses `history:false` and logical identity. The corrected current-list query
was first verified directly against completed journey state, then the complete
case passed from a fresh database. The combined native two-owner, two-Workspace,
two-device package gate remains open.

The current coherent image is
`sha256:a2e308f4cf93bdc5f95dc52f29ed850fe5bf5dd48a96bf5defd0bf485b964b67`;
source checking passed with fingerprint
`sha256:74026fe7ac7f65f895f0583fd8f22cdb7622ae28b064b90bea1b28d69aa01e81`.
The test-only updates use a read-only mount. No runtime overlay or additional
model process is involved. Test-source typechecking and targeted lint passed.
All four disposable destination databases were dropped after the accepted run.

## P2-08 implementation started

The rule-detail review contract separates proposal and lifecycle and binds the
review to rule authority, publisher fence, policy versions and current member
authority. The owner-bound repository review runs under a consistent read-only
snapshot and returns hashes of private member bindings rather than those
bindings. The initial source typecheck passed.

Migration 0063 adds a read projection that retains exact publication policy
bindings for rule reasons; current caps still apply. Direct reasons retain
their original consent binding checks. The relevant representation read,
semantic-index, recall/expansion and companion predicates now use that projection.
These changes have not been runtime-validated. The backend amendment transaction,
stable completed-operation receipt, native action definition and protected Team
review/mutation endpoints are now connected. Original creation approval remains
in the encrypted selector payload alongside the accepted scope. Local selection
progress has a scope recorder and effective-intent accessor; its delivery epoch
advances without discarding an outstanding source mutation.
Publisher inspection now supplies accepted amendment metadata, checks it against
the current rule, and permits monotonic scope adoption after exact identity and
selector checks. Content preparation waits for a renewed lease. The review
counts owner-cap expansions so that a nominal cap reduction cannot conceal a
permission increase relative to a newer owner restriction.

Source typechecking passed after the Team API and scope foundations. Targeted
lint and migration metadata checks passed earlier in the slice. Test-source
checking identified new repository methods missing from one API fixture; those
stubs are added. Local delivery acknowledgment, pending-publication handling,
Desktop amendment controls and runtime acceptance remain outstanding. Expired,
revoked and removed member consents are not widened by the amendment loop.
No runtime
tests have been run for P2-08, and the retained Docker backend is unchanged.

## Remaining package work

P2-08 through P2-14 and the combined package acceptance checklist remain
outstanding. P2-01 through P2-07 are locally complete. Snapshot conversion and
the remaining controls remain in their named tickets.

## P2-08 initial detail amendment checks (in progress)

This is partial evidence, not ticket acceptance. The current Docker image builds
source and runtime together and passes the source/runtime consistency check.
Fresh disposable PostgreSQL applied migrations 0063 and 0064. The retained Team
database was not changed, and existing model services were reused.

One focused repository journey passed through real native Action Grants. It
proves that accepting a reduction blocks detailed reads before replacement work,
retains permitted older summaries, supports a later increase and source revision,
returns the same completed receipt on exact retry, rejects a stale review, and
keeps paused and stopped lifecycle unchanged. A paused increase exposes only the
previously published exact revision, even after a newer Personal revision exists.
Three Desktop component cases passed for whole-rule scope and owner expansion
review, exact confirmation, refreshing after failure, and cancellation without
changing authority. The run passed four cases in 123 seconds.

Workspace and full test-source typechecks passed. Detail changes across all
selector kinds, independent overlapping reasons, queued-work races, pending
publication, HTTP/native integration and the broader acceptance boundaries still
need evidence. P2-08 and the combined package gate remain open.

Further focused Docker checks passed for Git Anchor, Folder and Project local
journals. Each persists the encrypted detail request, rejects a mismatched
receipt, acknowledges the exact accepted scope, recovers its receipt after
restart, and derives the new effective detail while keeping the original
creation intent unchanged. Existing source correction, old-request recovery and
owner-disconnection checks in those journeys still pass. The three Desktop
review cases passed again with the corrected React test environment. These six
selected cases passed in 21 seconds. No implementation source or compiled files
were overlaid; only updated test files were mounted read-only against the
separately verified Docker runtime.

Targeted lint, migration metadata checks and diff whitespace checks passed.
The disposable databases from both runs were removed. These journal checks do
not yet prove Team publication and read behavior for amendments across all
selectors; that remains part of P2-08 acceptance.

Further P2-08 checks passed eighteen focused HTTP, native approval and local
adapter cases in 6.4 seconds. They cover all four rule kinds, review freshness,
approval tiers, owner-permission expansion counts, exact destination and request
binding, Personal API Token denial, device-only amendments, and stable delivery
after a lost response and expired local approval custody.

The expanded selector run exposed expensive SQL planning and was interrupted;
it is not acceptance evidence. Repeated source-binding view expansion was
removed. Ordinary direct reads now bound the publication query to the requested
Share Grant before joining the remaining authorization checks. Locked mutation
reviews retain their existing lock behavior. On the same small disposable data,
the final built query planned in 921 milliseconds rather than 7,118 milliseconds;
execution took 42 milliseconds rather than 31 milliseconds. These are diagnostic
measurements, not a general performance guarantee. The rebuilt runtime passed
its consistency check. The fresh Conversation, Git Anchor and Folder journeys passed. The unfinished
Project journey exposed a second expensive planner path and was interrupted;
Project acceptance remains open.

The semantic indexing claim query planned for 106,078 milliseconds and executed
in 89 milliseconds on the overlapping Project dataset. Bounding its publication
lookup to the exact selected representation reduced planning to 658 milliseconds
and execution to 73 milliseconds on the same data. Both diagnostic runs returned
zero claim rows because the existing items were already indexed; the final
Project journey must still prove indexing and recall with fresh rows. The same
bounded relation is used for unlocked semantic readiness, reuse, search and
expansion queries. Grant-locked hydration keeps its original relation and locks.

A detail-only review now rejects a changed Privacy policy binding. It cannot
adopt a new content policy through a detail confirmation. Content-policy changes
require P2-09's explicit review. New focused cases cover this guard, completed
receipt recovery after independent owner-policy expansion, unresolved admissions
across all three selectors, and the Desktop rule flow through an activated
Pending Share. Source and test-source typechecks and targeted lint pass; these
new runtime checks and final Project acceptance remain open.

The final rebuilt runtime passed the three unresolved-admission cases. A queued
member whose detail changed before activation creates no consent or grant from
its old request. A fresh narrower admission retires that request, and an exact
old retry returns only its original receipt without reviving work. All three
selectors publish the approved summary and deny the obsolete detail.

Completed amendment recovery also passed after another rule expanded owner
permission, including stale-proposal rejection and preservation of the original
direct snapshot consent. The policy-drift guard passed. That test now stops its
rules and runs the production Privacy worker's stale-derivative invalidation
phase before later global publication scans. Earlier combined runs exposed that
test-order interaction; their incomplete Project case is not accepted evidence.

Both Desktop owner-flow cases passed in 2.93 seconds. They exercise pause and a
reviewed detail change through an activated Pending Share, bind the exact rule
and Workspace, show queued Team acknowledgment, and preserve direct consent.
The overlapping Project journey is the remaining P2-08 runtime acceptance check.

## P2-08 local acceptance

Locally complete on 21 October 2026. The User can review and change a Conversation,
Git Anchor, exact Folder or private Project rule's detail. Native confirmation
binds the exact rule, destination, policies, members and current versions. Active
rules reprocess eligible history and follow future content. Paused and stopped
rules keep their lifecycle. Only this rule's live consents change. Independent
sharing reasons retain their permissions and exact publications.

Accepted reductions close direct reads, recall and cached expansion before
replacement work finishes. A paused increase restores only the older detailed
revision actually published under that reason; it cannot borrow a newer summary
from another reason. Existing and future selector members, preparing Shares and
unresolved admissions all follow the acknowledged amended scope. Obsolete
Privacy work cannot publish. Exact completed receipts survive later independent
owner-policy expansion without executing an old policy proposal again.

The final Project journey passed in 241 seconds, including independent Git
Anchor, Folder and second Project reasons, actual indexing and Team recall,
cached expansion, later summaries, active and paused amendments, pending
publication and stop fencing. The corrected policy-change case passed alongside
it; the two-case run completed in 296 seconds. Conversation, Git Anchor and
Folder journeys passed earlier, as did all three unresolved-admission cases,
all three encrypted local-journal cases, the three review-component cases,
eighteen HTTP/native/delivery cases and both Desktop owner-flow cases. Earlier
interrupted and failed runs remain diagnostic history, not accepted evidence.
Their assertions were preserved; test cleanup now follows normal owner stop
controls and the production Privacy invalidation phase.

Workspace and final test-source typechecks, targeted lint, migration metadata,
formatting and diff whitespace checks passed. The final Docker source/runtime
consistency check passed. Disposable databases were removed, and existing Team,
Personal and model services were preserved. The User's changeset omission remains
in effect. Boundary documentation is in
[the owner workflow](shared-memory-owner-workflow.md#change-a-rules-shared-detail-p2-08).
P2-09 through P2-14 and the combined two-owner, two-Workspace, two-device native
journey and package checks remain open.

## P2-09 focused runtime progress

P2-09 remains in progress. The first focused Conversation history case passed
against the coherent local Docker image on 2026-10-21. It verifies restrictive
and broader content-policy amendments while paused, immediate denial under the
old policy, exact retry receipts, rejection of stale confirmation, unchanged
owner fidelity records and restoration of revision 1 while revision 2 remains
unpublished by that reason.

The case passed in 95.405 seconds (109.70 seconds for the filtered process).
The image was `sha256:1c92b3b35d2bea20823d3b18033f2035e53c05718f785bad13ff80e11684c807`;
its source/runtime check reported current fingerprint
`sha256:9f2ce726112ca6ed3bd3f1dd5ad253e414d98bf5f6bb83dd86c65e2ec111c8e5`.
The test used a disposable database, which was removed after completion. The
retained fixture database and existing model services were not restarted.

This case uses controlled classification results. It does not prove actual
category masking, overlap across independent reasons, current-cap reductions,
all selector types, the native HTTP/delivery/editor journey, or downstream
indexed recall after these amendments. Those focused checks and the combined
package gate remain required. No P2-09 acceptance criterion is marked complete
on the strength of this case alone.

### Current detail-limit reductions

Three additional focused Docker cases passed after fixing recovery of grants
made unavailable by a detail-policy change:

- Owner limit reduced to LCM Rollups: 58.172 seconds.
- Team limit reduced to LCM Rollups: 59.096 seconds.
- Workspace limit reduced to LCM Rollups: 61.123 seconds.

Each case publishes revision 1, pauses the rule, captures unpublished revision 2,
reduces the current limit, and performs restrictive and broader content-policy
amendments. The current Rollup is readable after reprocessing; higher detail
stays denied. The rule remains paused, fidelity policy records are unchanged by
the content amendments, and this reason never publishes revision 2.

The filtered process passed all three cases in 192.67 seconds using image
`sha256:3793211434c195222ccca5189cb9354c4bb667a870b9cc7f07394b7fa238b73b`.
Its source/runtime fingerprint was current:
`sha256:cca19699e84dd81e16393d8df872c3c7ed530b224cc3a40bec70b94371b7defe`.
The disposable database was removed after the process completed. Existing model
services and the retained fixture database were not restarted.

Actual masking, overlapping reasons, all selector types, native delivery/editor
behavior and downstream indexed recall remain required for P2-09 acceptance.

## ALPHA-01: Disable unfinished content-policy editing

The alpha removes the content-policy editors from both Desktop placements,
covering Conversation and Git Anchor/Folder/Project controls. Static inspection
finds no remaining editor imports. The renderer contract remains decodable for
stored requests; HTTP and native entry points reject new edits before execution.

A focused source-based run passed eight cases in 19.16 seconds on 21 October 2026. It covers both disabled HTTP endpoints; new approval admission; pending
native and browser approvals; native review/amend commands with no queue write;
and an existing queued edit moving to `needs_review`, with no remote request or
acknowledgment. The same run retains successful owner detail review, durable
detail delivery with lost-response recovery, and another User's activation denial.

Command:

```sh
pnpm exec vitest run apps/api/src/shared-memory/routes.test.ts apps/api/src/high-risk/shared-memory-action-definitions.test.ts apps/api/src/high-risk/routes.test.ts apps/api/src/local-edge/collaboration-action-grant-control.test.ts apps/api/src/local-edge/collaboration-shared-memory-control.test.ts -t 'disables alpha content-policy|reviews rule detail for its owner|delivers an approved rule detail amendment|does not let another User inspect or decide' --no-file-parallelism --maxWorkers=1 --reporter=dot
```

No database or model process was started for these checks. They prove the changed
entry-point behavior using controlled dependencies. The native walkthrough and
matching compiled builds remain ALPHA-02 and ALPHA-03 work. Existing stored
restrictions, approval records, and publication/read gates were not changed.

Test-source typechecking, targeted ESLint for all changed alpha source/test files,
and formatting checks passed. Lint required two syntax-only corrections to the
unavailable handlers (a synchronous throwing HTTP handler and an explicit
resolved Promise for admission). No permission or stored-state path changed in
those corrections. Whitespace checks passed. Runtime build and native evidence
remain open under the next tickets.

## ALPHA-02 build and startup progress

The current native Desktop and source runtime build successfully, including the
sandboxed preload check. The first build exposed a Node-only digest import in
shared sharing schemas. Those schemas now use a browser-safe canonical SHA-256
helper. Four focused cases prove the same digest and derived UUID as the existing
server implementation, including Unicode and nested input. The server's original
native hash implementation remains unchanged.

The Desktop setup model gate now checks the configured Embedding and Privacy
services in external dependency mode. It does not require or install local model
files in that mode. Two focused checks passed, targeted lint passed, and the
native setup screen marks the model stage complete using the existing services.
Bundled-local mode retains its model installation requirement.

Current built Team image:
`sha256:b278386cede5b00d2e8b1a73512492803adef7283aa2690eccca750465b556e7`.
Its running source/runtime check reports current fingerprint
`sha256:290ab5410b31f30a32dea8c2085168c5df6c66d1be2f52ece33a84bab5bc1f9e`.
The native Personal source/runtime check reports current fingerprint
`sha256:c64a6ba2f6551eaa5166be6219fb39dfd5d0e749064abfe221162a24dd6314d0`.
The fingerprints include platform and Node major version: Docker uses Linux/arm64
with Node 22; the native build uses macOS with Node 24. Calculating the native
source inputs with the Docker platform and Node version produces the exact
running Docker fingerprint above. Both builds
use the current sharing source and dependency lock, without runtime overlays.

The Team Backend runs at `http://127.0.0.1:3341`, using an isolated copy named
`koed_operational_alpha_20261021`. The original fixture database remains intact.
The Personal API runs at `http://127.0.0.1:43300`. Both readiness endpoints return 200. Personal status reports healthy database, Embedding Service, Privacy Filter
Service, Local AI Runtime, local credentials, and MCP artifacts.

The existing Personal profile had an incompatible unreleased migration history.
After the User authorized overwriting it for the demo, its folder was preserved
as `~/.koed.before-alpha-20261021` and a fresh `~/.koed` demo profile was created.
The demo reuses the existing Docker model services through localhost-only
forwarding. No additional model process or model download is required. Historical
transcript watchers are disabled for the demo, so they do not import unrelated
Conversations. Native owner sign-in and Workspace selection are now observed;
publisher delivery and the walkthrough remain open. This is partial operational
evidence, not trial readiness.

Native core setup and verification completed through the app. The external model
stage completed without installation. The optional Codex setup reports MCP
Recall, Local Synthesis, and Managed Conversation ready, but automatic capture
remains unknown and its setup action reports that capability as not ready. This
is an unresolved trial requirement; it does not establish the later-turn capture
or LCM Summary walkthrough. Native Team connection work is next.

The native main screen now opens after removing a root shared-package import
from the Git Anchor review component. The browser contract entry point avoids
the Node-only privacy hash initializer. All nine focused Git Anchor review cases
passed. The User completed browser sign-in and device approval; native Team
preferences report Connected. Workspace loading remains under validation.

Two copied-fixture problems were corrected only in the isolated alpha database.
Alice and Bob now use the recorded disposable demo passwords; both login
requests return 200 on port 3341. Five Personal collaboration fields had been
seeded with the Team encryption provider. They were re-encrypted with the
Personal provider in one transaction, with identical plaintext verified after
each write. Team fields and the original fixture database were unchanged. The
fixture builder now supplies separate Personal and Team providers.

The next native load exposed a contract omission: the remote navigation parser
rejected `curated_assertions` as an active representation, discarding the Team
catalog. That supported value is now accepted. Two focused composition cases
passed for Memory Events and curated assertions. A refreshed runtime build and
native Workspace selection are required before this fix counts as operational
walkthrough evidence.

After the corrected build, native Desktop shows Koed Fixture Team, Alice Morgan
as Owner, and the Managed Knowledge Ingestion Workspace. This Workspace is the
selected trial destination: Alice already has sharing permission and Bob has
read access. No Workspace permission was expanded for the trial.

The local Docker environment had inherited the developer deployment profile.
The User explicitly approved correcting only port 3341 to `team_self_hosted`.
The recreated backend reports that profile, readiness 200, and a current runtime
fingerprint matching the normalized native source inputs. The original backend
on port 3331 remains running separately.

The first Conversation launch found a separate Desktop handoff error: the
navigation group's ID was passed where the managed runner needs the local
checkout ID. The launch composer now prefers the selected local Project ID.
Two focused Project launch checks passed with distinct navigation and checkout
identities. Native Conversation capture, sharing, and delivery remain unproven
until the updated Desktop completes the walkthrough.

The next managed prompt exposed a repository-composition bug before provider
turn dispatch: local AI Client catalog reads were sent to an authority adapter
that does not implement them. Those two reads now remain on the execution
device and use its local owner. One focused check proves that a remote
execution can use the local catalog while an expired snapshot is rejected.
Targeted lint and the runtime build passed. No uncertain prompt was retried.

A fresh native Conversation, `Cedar alpha trial ALPHA-CEDAR-R2-20261021`, then
completed through Codex. Desktop displays the synthetic User message and the
AI Client reply as two Memory Events. Both record a 17-minute Cedar review
window and Bob Rivera as checklist owner. Native sharing review displays those
exact two items for Managed Knowledge Ingestion, with continuous updates
selected. Creation is waiting for browser approval; no Team acknowledgment or
teammate access has been claimed.

## ALPHA-03 native Conversation and teammate evidence

ALPHA-02 is locally complete. The running native build connects as Alice to
Koed Fixture Team and publishes to Managed Knowledge Ingestion. Bob's existing
read access is unchanged. The running image and source fingerprints are above;
local launch/stop instructions and non-secret endpoints are recorded in the
uncommitted operator handover artifact. No source overlay is used.

The User approved continuous sharing of the selected R2 Cedar Conversation in
the browser. The durable creation record reached `acknowledged` in one attempt.
Content activation then encountered PostgreSQL serialization failure `40001`.
The backend recorded needs-attention rather than claiming content was active.
The User-facing Shares list was initially blocked by two old fixture grants
with missing companion records. Those two records were repaired through the
normal authorized repository path in the isolated database. The owner then
used Modify → Retry in native Desktop. The selected Share became Active and
its Team initial view returned 200 for Bob.

Bob's session-authenticated Team recall and Memory Answer evidence endpoints
both returned 200 with evidence attributed to the selected grant. Candidate
expansion returned 200 and an authorized expansion. The owner added a later
turn through Desktop, changing the review window from 17 to 23 minutes. The
owner's native view shows four Memory Events; Bob's Team view and Evidence
Bundle contain the 23-minute update. Team content masks Bob's name, while the
owner's Personal view retains it. This is observed privacy masking, not proof
of every privacy label or boundary.

The first alpha attempt remains in uncertain-delivery state and was never
retried automatically. The successful R2 Conversation is the trial source.
LCM Summary propagation, Git Anchor membership, pause/resume, overlapping
reasons, final-reason denial, and restart recovery are still open.

### ALPHA-03 automatic Git admission correction

The native Git Anchor review inspected one eligible existing Conversation in
`example.invalid/koed/cedar-alpha` and no unresolved sources. Alice approved
the selected synthetic rule in the in-app browser for Managed Knowledge
Ingestion. A second matching Conversation was captured after rule creation.
Publication acceptance remains open until both members can be read by Bob.

The first automatic admission repeatedly stopped before its preview approval.
Its internal Action Grant intent omitted the required `commandRequestId`.
The delivery now generates one preview request ID and binds both the approval
intent and preview command to it. A focused execution of the normal delivery
path obtained an Action Grant, prepared the preview, and received HTTP 202
for the existing member admission. No approval requirement was bypassed.
The temporary diagnostic callback used to identify the failure was removed.

Cedar's AI Client-generated LCM Leaf was also received by the Team Backend.
It covers six of the source's eight events. Current publication requires
complete coverage of the authoritative revision, so that partial summary
correctly remains unavailable as a Team representation. Completing the
remaining summary coverage, then checking Bob's access, is still required.

The corrected native runtime build completed in 21.168 seconds with fingerprint
`sha256:e080ebc2296cd9af10b7752f5aceac7f1a7c2cf56f17a3877ad965e4f26c5b30`.
The running Docker image is
`sha256:12e6652b270ba012510a60512f4511bebbb704a82dee1233a09a0dbb2d621fb1`;
its runtime check reports current fingerprint
`sha256:b664ce92f6c8a71851e45900231673ceac4eb87439b3918623c778cb72da5934`.
Targeted formatting and lint checks passed. This API correction did not require
a Desktop source change.

Both existing and future Git memberships were admitted. The future member's
activation encountered PostgreSQL error 40001; Desktop's existing Retry action
completed publication. Bob then received HTTP 200 for its Memory Events and
semantic recall containing the Thursday 16:30 checkpoint. The existing member
still needs its activation retry and teammate read verification.

Alice paused the Git rule through Desktop. A later synthetic amber-lantern
review step was captured as two more Memory Events. While paused, Bob's read
returned HTTP 200 and the earlier Thursday checkpoint, without the new step.
Resume and catch-up remain unverified. The existing valid Personal API Token
also returned HTTP 200 for Personal recall and HTTP 403 for Team Workspace
recall, which required a browser session or scoped device credential.

Bob subsequently read both Git members with HTTP 200: the existing member
contained its Tuesday checkpoint, and the future member contained its Thursday
checkpoint. Exactly those two logical sources were admitted to the Git rule;
the independent Cedar Conversation was not a member. After resume, the
existing worker published revision 14 without a new sharing approval. Bob's
next read included the previously withheld amber-lantern step. The native Git
membership and pause/resume acceptance items are complete within this scope.

Before sharing the new direct-first overlap Conversation, Bob's Team recall
returned no violet-compass content and no entry for its logical Memory
`8464a812-d16c-521e-b990-1101b3aa6d17`. Its two Memory Events remained visible
in Alice's Personal view while the Git rule was paused. Combined with the
observed Team privacy masking and Personal API Token rejection above, this
completes the alpha privacy/unshared/token check within the selected scope.

The first overlap attempt added a direct snapshot after Git had created the
destination grant. Its first activation encountered 40P01; Retry then reached
the existing one-grant-per-destination conflict. The unactivated Pending Share
was stopped through Desktop. The alpha walkthrough is using the supported
direct-first order. Support or explicit prevention of the opposite order is
recorded in TODO.md, and must be included in the trial limitations.

Repeated preview preparation conflicts also occurred while admitting the
direct-first source to the Git rule. The preview-owned transaction now retries
40001 and 40P01 at most twice, reloading all authority on each attempt. It does
not retry other errors or caller-owned transactions. Four focused repository
cases passed in a new empty database in 11.61 seconds (3.34 seconds test time):
serialization recovery, deadlock recovery, authorization-error propagation,
and the three-attempt limit. The other 124 cases were skipped. Targeted lint
also passed. This is a trial workflow fix, not a general retry framework.

The direct-first source completed publication at revision 16 on the corrected
build. Its direct and Git reasons shared grant
`9e99d732-7c65-4cba-a936-2941243a26a4`; both reasons independently published
Memory Events. Bob's read, recall, Evidence Bundle, and expansion returned
HTTP 200 before stopping the rule.

For the brief-disconnect check, Desktop first displayed the exact Git stop
review. A transaction then held only that synthetic rule row to keep the stop
in flight after approval. The stop was durably queued locally as
`a0630e08-d79f-4e5c-a4ad-97edaf6b4c22`. The isolated alpha backend was paused
and the temporary row lock was released with rollback. Desktop displayed
“Stop requested here. Waiting for Team acknowledgment. Team access may remain
until acknowledged.” The same queued ID and remote-unavailable state survived
quitting and reopening the app and Personal supervisor. The backend was then
unpaused. Its audit contains one applied stop, and the overlapping source
still has one destination grant. Local receipt collection is still pending
the interrupted delivery lease.

After the stop, Bob's Git-only source read returned HTTP 403, while the
independently authorized direct snapshot returned HTTP 200 with the
violet-compass signoff. The overlapping-reasons acceptance item is complete.
The final direct reason has not yet been revoked.

The interrupted stop was acknowledged locally on its third delivery attempt
at 11:16:03 UTC, after its existing five-minute lease recovery. The same
retained pre-stop publication authority (rule version 5, publisher fence 1)
was rejected with SharedMemoryConflictError. Cleanup had already removed its
preparation row; the negative check used the exact scope retained before stop.
The backend has one stop audit record and one destination grant for the
overlapping source. Its direct read still contains exactly two items.

This interruption began after online review and local queueing, before remote
acknowledgment. It proves recovery of that reviewed stop across restart. It
does not prove initiating a fresh approved stop while fully offline; online
action review is currently required. ALPHA-04's stricter initiating-offline
wording remains unresolved pending the User's scope decision.

Final revocation then found a local projection gap: activated Pending Shares
can expose a current grant ID without populating the authority-store grant
record required by revocation. The local control now hydrates a missing record
through the existing owner-detail read, then repeats the same scope and
version checks before using the approved action. Two focused cases passed in
4.03 seconds: successful hydration and rejection of a different Workspace
before sending a revoke. The other 56 cases were skipped. Targeted lint passed.
Final live revocation and stale-access checks remain open until this build runs.

The live owner-detail request also exposed why hydration initially failed:
the owner list deliberately shows a Pending Share instead of a second grant
entry, and the detail lookup reused that list without resolving its grant.
Exact grant lookup now resolves that owner-visible Pending Share to its
owner-scoped grant. The existing activation case verifies the owner lookup
and denial for another user; this single focused case passed in 8.68 seconds.
The list still shows the original Pending Share. Targeted lint passed.

Final stop was completed through native Desktop for the selected direct
snapshot. The grant advanced from version 4 to version 5, revoked. Bob's
fresh direct and Git-only reads and retained source-item read returned 403.
Both ordinary and retained-boundary candidate expansion returned no content.
Fresh and retained-boundary recall and evidence excluded all three stopped
grants. The independent Cedar share remained readable (200). These ten live
checks passed. Retained boundaries limit the candidate scope; current grant
authority still applies, so an empty 200 response is a valid denial of content.

Desktop subsequently showed Sharing stopped and REVOKED while retaining the
owner's two Personal Memory Events. Its first response briefly showed a
generic error because the local revoke parser expected companionScope, which
the owner-safe revoke endpoint omits. The client now uses the existing owner
grant parser and scope reconstruction, with unchanged grant identity,
destination, lifecycle, and version checks. Two focused revocation cases
passed in 5.97 seconds against the actual owner-safe response shape; the other
56 cases were skipped. Targeted lint passed. No broader suite was run.

The final native runtime was rebuilt and passed the source-runtime currency
check with fingerprint
`sha256:7c68f041237eb842b6ef2d4016853732124fcb4c663f29523def294834cbf5cf`.
After reopening it, the selected revoked source still contained its two
Personal Memory Events. Shares showed both reasons stopped and the grant
REVOKED. The durable Git stop remained acknowledged on attempt 3, with no
failure code. Only starting the stop fully offline remains unresolved in
ALPHA-04; the observed interruption, restart, acknowledgment, denial, obsolete
publication rejection, and unrelated-sharing checks are recorded separately.

The matching final Team Backend container is running on port 3341 with image
`sha256:b53ac78e5d827a035f6d82497141e467829ecf68b93c502f9234c851a54df7ed`.
Its source-runtime check passed with fingerprint
`sha256:2825c92b31f70b7653db08597fe79c178c08b20f9de33383e8486133485c9dfe`.
After replacement, the selected final grant was still revoked at version 5.
The original database and unrelated services were preserved.

The handover-wide Prettier check reported formatting differences in the
migration journal and 18 generated snapshots. This is recorded as deferred
metadata formatting cleanup in TODO.md; application and documentation files
were not reported by that check. No schema or runtime behavior was changed
to address formatting.

Final handover checks: full workspace ESLint passed. Test-source TypeScript
checking passed after removing an unused representation property from a
preview-retry test input; runtime code did not change. Targeted Prettier
checking passed for changed authored files, excluding generated migration
metadata. Native and container builds and source-runtime currency checks
passed as recorded above. No functional suite was rerun for the type-only
test-input correction. The full formatting check remains limited by the
recorded generated-metadata differences.

The User approved summarizing Cedar's remaining two synthetic events and
accepted reviewed-stop recovery as ALPHA-04's scope. Its first acceptance item
now states the observed ordering: online review, queued delivery, then a brief
backend interruption before acknowledgment. ALPHA-04 is locally complete
within that scope. Fresh offline-stop initiation remains outside this alpha.

The approved final Cedar summary cycle submitted one two-event leaf through
the configured Codex AI Client, with no failed summaries. The selected source
now has completed six-event and two-event leaves. The existing background
service also completed their eight-event rollup. The summary-sync outbox
completed on its first attempt, and both leaves and the rollup reached the
Team Backend. Team read acceptance remains open until publication is observed.

For this small demonstration, the live-capture tail was explicitly finalized
through the existing compaction function with its live-capture work class;
then the ordinary claiming and summary submission workflow ran. The ordinary
preview preparation did not finalize that work class. This is a trial limit,
not evidence of automatic tail finalization. No publication gate was weakened.

### Final alpha handover

Cedar's eligible LCM Leaves were published under the existing sharing consent.
Bob's ordinary Team read returned HTTP 200 with two leaves, the 23-minute
window, and masked person references. The unmasked name was absent. The native
Personal preview showed the six-event and two-event summaries. No additional
sharing approval or permission expansion was needed.

Larger CPU classification batches initially retried under the default
30-second service timeout. The isolated alpha backend now uses the existing
120-second Privacy service timeout setting. Its pending LCM privacy work
subsequently became ready and published. Policies and classification gates
remain unchanged. This operational override does not change the built image
or source-runtime fingerprints recorded above.

ALPHA-03 is complete. ALPHA-04 is complete within the User-accepted reviewed-stop
recovery scope. ALPHA-05 is complete: the local native app and Docker backend
are running, the local launch and stop guide is delivered, and limits are
recorded. The full-package matrix, Workspace exclusion, content-policy editing,
extended outage recovery, and publisher transfer remain deferred. The manual
live-tail finalization step and generated metadata formatting are recorded
as follow-ups. No changeset, commit, push, PR, or release was created.

### Shares completion refresh follow-up

The User's new checkpoint snapshot reached privacy filtering, recovered from
a transient Privacy service error, and activated. Bob's read returned 200
with its two Memory Events. Desktop initially kept a stale pending/error view.

Shares now retains its immediate realtime updates and adds a status-read
fallback while a Pending Share is preparing. It reloads five seconds after a
completed read, stops when no preparing share remains, and cancels on leaving
the view. Retryable status-read failures recover with capped backoff, while
access denials remain errors without automatic retries. This does not submit
a new share or force privacy filtering.

Five focused Desktop cases passed in 3.77 seconds: completion without an event,
completion after a retryable read failure, timer cleanup on leaving Shares,
no retries after access denial, and existing realtime/control focus behavior.
The other 79 cases were skipped. Targeted ESLint, formatting, and the Desktop
package build passed. The build includes source typechecking and preload
verification. No backend or model change was needed.

Test-source TypeScript checking also passed for this follow-up. The rebuilt
Desktop renderer was loaded into the open alpha app. Backend code, pending
operations, consent, and the running model services were unchanged.

### Git admission after an earlier snapshot revocation

A newly approved Git Anchor rule repeatedly received a conflict when admitting
a matching Conversation whose earlier destination grant was revoked. Inspection
found the matching source and revoked grant, but no rule membership or Pending
Share had been created. This was an admission failure before privacy filtering.

Repository-member admission now permits reuse of that grant only when the
rule's original approval postdates its revocation. Activation repeats the
version and approval checks. A fresh rule reason and consent replace current
root authority while the old direct reason, revoked consent, and invalidated
publication remain stopped. Pending retention cleanup is canceled through the
existing retention path; a started purge prevents reactivation.

Three focused DB regressions passed against a disposable database: existing
Git admission, rejection of an old rule followed by fresh-rule admission after
revocation, and rejection when revocation occurs after enqueueing. The other
127 cases were skipped. The reactivation case checks fresh-consent reads,
preservation of the old direct reason and invalidated snapshot, and canceled
cleanup. DB and test-source typechecking, targeted lint, and formatting passed.

With User approval, Docker Desktop was restarted and the fixed alpha backend
image was built and loaded. Existing databases and volumes were preserved.
The embedding service was restored using its existing installed model.

The existing Git rule automatically admitted both previously revoked matching
Conversations. The checkpoint's first activation encountered PostgreSQL 40001
and entered Needs attention. One use of the app's Modify → Retry control
resumed it. Both new Pending Shares then activated through the normal privacy
worker. The checkpoint published Memory Events at revision 18, with its old
direct reason stopped and the new Git reason active. Bob's authorized initial
view returned HTTP 200 and the Friday 15:00 UTC checkpoint. No fixture reset,
direct authority repair, or manual privacy-processing operation was performed.

The live retry also exposed a stopped status-refresh loop after Needs attention.
The Retry handler now restarts owner-list reconciliation. Three focused Desktop
cases passed (82 skipped), covering retry-to-completion and the existing
completion fallback with and without a transient read failure.
Desktop package build, targeted lint, and formatting passed for the retry
refresh correction. The updated renderer was loaded into the alpha app.
Test-source typechecking also passed. The app was left on the active checkpoint
row with zero Pending Shares, its direct reason stopped, and its new Git reason
active with revision 18 published.

### Continuous Shares source-preview revision follow-up

The checkpoint's Team representation had advanced to revision 20, while the
owner Shares preview still referenced its original revision 18 consent preview.
Owner listing now selects the newest published source preview under that
entry's current consent, with matching owner, source, destination, activation
representation, and fidelity. It falls back to the original consent preview
when no eligible publication exists. The existing Workspace-access check and
preview-binding verification remain in place.

Shares also reconciles while any sharing reason has updates active, so a
completed continuous share can update its preview without a Team owner event.
The existing five-second status-read interval, backoff, cleanup, and pending
activation behavior remain. Paused, stopped, and fixed-only entries do not keep
the refresh loop alive.

One focused DB regression passed (130 skipped), covering continuous revision
advancement, a separate fixed snapshot retaining revision 1, and Workspace
access loss. Four focused Desktop cases passed (82 skipped), covering active
preview invalidation, stopping refresh after pause, pending completion, and
refresh resumption after Retry. No broad functional suite ran.
DB and test-source typechecking, targeted ESLint, changed-file formatting, and
whitespace checks passed for this follow-up.
The backend image and Desktop package built successfully. Live owner detail
returned the original approval revision 18, latest publication revision 20,
and matching preview revision 20 with four items. No share mutation or manual
privacy-processing operation was used for this correction.
The updated Desktop renderer was loaded into the running alpha app.

### Project-member activation conflict recovery

The Project trial admitted two selected Conversations into Cloud Memory Platform.
One activated; the other entered Needs attention after PostgreSQL 40001 during
rule activation. A normal owner Retry published revision 14 but final status
recording encountered another serialization conflict.

Rule admission now retries its idempotent activation workflow up to three
attempts for 40001 and 40P01 only. Normal authority, policy, consent, membership,
and publication checks run again; no sharing boundary is relaxed. Exhaustion
still enters Needs attention, and existing failed operations require explicit
Retry. The underlying contention and direct-activation path remain follow-ups.

Three focused disposable-DB cases passed (131 skipped): recovery after both
conflict codes, a three-attempt limit for persistent conflicts, and immediate
failure for a permission error. DB typechecking, targeted lint, formatting, and
whitespace checks passed. No broad test suite ran.
Test-source typechecking also passed for the rule-activation retry correction.
The updated alpha backend image built successfully and was loaded without a
data reset. A normal owner Retry then completed the previously failed Project
member: activated, complete, no error, revision 14 published, and Project reason
active. No exhausted activation failure was logged after this retry.

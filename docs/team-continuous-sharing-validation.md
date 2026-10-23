# Team continuous sharing validation

The User authorized the fourteen Package 2 tickets on 20 October 2026 and
requested that tests run only when necessary. Validation is performed after a
slice is implemented, before dependent work relies on it. The User chose to
omit the recommended minor changeset. Subsequent development and test Team
Backends use the local Docker daemon, as requested by the User. No push, merge or deployment is implied.

The following alpha status records the accepted milestone. Current production
progress is tracked in the [current tickets](../tickets.md) and the later
production sections of this record. At alpha acceptance, P2-01 through P2-08
were locally complete. On 21 October 2026, the User approved the smaller
operational alpha, deferring P2-09 through P2-14 and the combined full-package gate.
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

## PROD-01: Activation contention

The local PostgreSQL diagnostic record identified a deadlock between preview
preparation and target sync: preview held a source row while waiting for the
shared device credential; sync held the credential while waiting for the source
row. Repeated 40001 failures also occurred at the rule/member/consent authority
query under a repeatable-read preview. Diagnostics were bounded to recent local
logs and SQL shapes; this record retains no credentials or source content.

The correction removes live source locks only from previews that own their
repeatable-read snapshot and verifies existing immutable revision bindings
without no-op rewrites. Inherited-isolation callers retain their locking path.
Read-only Team and Workspace policy checks use shared locks. Both direct and
rule activation have a three-attempt workflow limit for 40001/40P01. Generic
activation failures no longer enter automatic companion repair.

Simultaneous member admissions retain independent reasons on one destination
grant, including when neither initially saw a grant. An uninterrupted audit
sequence must prove additive admissions before an operation can recover across
a newer grant version. Revocation, control and policy version changes cannot
satisfy that proof. Every replay rechecks current authority. Exact candidate
revision checks and stale-review rejection remain intact.

A focused current-schema PostgreSQL 17 Docker run passed 25 repository cases
(117 skipped) in 53 seconds. It covers direct 40001/40P01 recovery, persistent
conflict exhaustion, immediate permission denial, credential revocation during
recovery, bounded preview retries, the repeatable-read source snapshot with
concurrent source-row updates, simultaneous rules against existing and newly
created grants, a later signed source update racing with activation completion,
both rules publishing revision 2 through normal reconciliation, revocation after
an additive admission, independent concurrent Team destinations, companion
creation, and six policy-edit lock-contention cases. No manual owner Retry was
used in the new recovery or concurrent-admission cases. The Docker database was
disposable and separate from the accepted alpha and its fixture.

This is focused local repository evidence. It does not establish the PROD-06
combined native journey, an external deployment, or a production release.

A final focused rerun passed all four concurrent-admission and snapshot cases
(138 skipped) after narrowing immutable-binding reuse to owned snapshot
transactions and checking current authority before an additive-version replay.
Database-package typechecking, test-source typechecking, targeted ESLint,
Prettier, and whitespace checks passed. No broad suite, packaged build or
changeset was added at this checkpoint. Continue with P2-10.

## P2-10: Workspace Conversation exclusion

Locally complete. The owner/source/Workspace exclusion has independent retained
state and versioned mutation receipts. Native approval binds the exact owner,
source, destination and versions. Desktop uses the existing encrypted delivery
journal, waits for Team acknowledgment, then clears cached Team views and shows
Excluded. Personal API Tokens cannot use the review or mutation routes.

Focused checks against a disposable native ARM PostgreSQL fixture passed:

- Exclusion after publication and after the owner loses Workspace Access,
  exact replay, stale decisions and another owner's denial; Personal event data
  remains unchanged and direct consent cannot restart publication.
- Exclusion while the activation workflow is creating the companion: no late
  activation or Team access survives the acknowledged exclusion.
- Project publication with overlapping Folder and Git rules: published reads,
  semantic recall and expansion of a previously returned candidate are denied.
  An unrelated source remains readable until separately excluded. New source
  admission is denied while the veto is active.
- Two destinations for the same canonical source: excluding one leaves the
  second Workspace readable and the owner-private replica active.
- Two encrypted journal cases cover exact exclusion receipt validation,
  restart/replay, owner isolation, encrypted credential/title custody, and the
  existing control lease fencing.

The final repository transaction rerun passed three cases (143 skipped), the
overlapping-reason case passed (145 skipped), and the two-destination case
passed in its focused run. Five focused HTTP/registry/Desktop cases and one
native approval binding case passed. The selector delivery suite passed all 21
small cases, including blocked admissions for Git, Folder and Project rules.
The publisher retains its existing goal for a bounded inspection after 60 seconds;
it neither prepares nor admits the excluded source.

Shared, database, API, Desktop and test-source typechecks passed. Targeted lint,
changed-file formatting and whitespace checks passed. No broad test suite,
packaged build, changeset or external deployment was used for this checkpoint.
This evidence does not complete P2-11 restoration or PROD-06's combined native
journey and full selector/control matrix.

## P2-11: Explicit exclusion removal and catch-up

Locally complete. Restoration has a five-minute reviewed authority binding and
requires native device approval in both HTTP and repository entry points. The
retained exclusion version, source/destination, root grant, current rules,
membership, consent and policies are rechecked under the existing transaction
locks. Exact receipts survive retries without reapplying the mutation.

Four focused disposable-DB lifecycle cases passed (145 skipped), using real
scoped native Action Grants: active rules catch up a later source revision;
paused and stopped rules remain unchanged and unreadable; no-rule restoration
leaves direct snapshot consent revoked and publishes nothing. The paused case
then explicitly resumes the rule without a new source revision and verifies
normal preparation and publication of that same revision. Native approval is
required even for an internal repository invocation. Stale decisions after rule
controls and conflicting mutation replays are rejected.

The combined selector case passed through native restoration (144 skipped in
its five-case run). Project membership removed while excluded stays removed;
restoring the source publishes nothing through that reason. Independent active
Folder and Git reasons catch up another source without duplicate grants or new
scope approval. Previously activated rule Shares return to active only after
current authorized publication. Exclusion denial of old semantic candidates
remains part of this same case.

Three encrypted-journal cases passed (21 skipped), covering exclusion,
restoration and existing rule controls across restart, exact receipt binding,
owner isolation and protected title/credential custody. Focused native approval
and registry checks passed. Three focused HTTP/Desktop checks passed (128
skipped): Personal API Token and missing device approval denial, mismatched
receipt rejection, and exclusion remaining visible during queued restoration
until Team acknowledgment. A no-rule acknowledged restoration keeps the old
snapshot unavailable.

The implementation reuses normal preparation, Privacy work, publication and the
existing encrypted journal. It adds no synthesis service, collection or delivery
queue. The combined native multi-device journey remains PROD-06 work; these
focused local checks do not establish release readiness.

At the P2-11 integration checkpoint, shared, database, API, Desktop and test-source
typechecks, targeted lint, formatting and whitespace checks passed. No changeset
was added. Continue with PROD-02; the production goal remains open.

## PROD-02: Normal LCM preparation

The explicit preview helper previously compacted only the default
`normal_embedding_lcm` class. Live captured sources use
`live_capture_projection`, so their eligible fresh tails were not finalized by
that request. Preparation now drains live, normal and historical classes for
the selected session, with one total 1,000-call limit. It wakes the existing
local summary service when it creates nodes. It does not close the captured
Conversation, project an unfinished turn, or synthesize on the backend.

The 13 focused candidate-preparation cases passed. Three disposable-DB boundary
cases passed (273 skipped): live/historical class isolation, an unfinished agent
turn remaining unsealed even under forced live-class preparation, and owner-only
Approval Activity remaining outside semantic Memory. Current source-runtime
preparation built successfully. A matching local Team fixture build and the
configured AI Client publication check are in progress; this is not PROD-02
completion evidence yet.

PROD-02 is locally complete. The current source runtime and matching native ARM
Team fixture image built successfully. The synthetic Cedar Conversation received
one idempotent later turn through its managed Conversation prompt API. Its
configured Codex client acknowledged the new 29-minute review window. The normal
Desktop candidate-preview command finalized the two-event live tail and woke the
existing local LCM Summary Service. That service submitted the new summary
through the configured AI Client. No direct database preparation, forced summary
submission script, new consent or publication workaround was used.

The ordinary summary snapshot synced on its first attempt. Bob's authenticated
Team `initial-view` returned HTTP 200 at source revision 22 with three LCM Leaves,
including the new 29-minute window. The previously masked owner name remained
absent from Team items. A read-only queue metadata check diagnosed progress;
it did not change preparation, leases, sharing state or publication.

The local embedding container was returning `LlamaServerError` during this run.
One restart of that disposable dependency restored HTTP 200 embeddings without
removing vectors or changing model, Privacy or permission settings. Some local
embedding attempts had already exhausted retries; this run establishes the
LCM preparation/synthesis/sync/publication path, not complete recovery of every
pre-existing local embedding job. The broader recovery gate remains P2-13 and
PROD-06.

Two focused publication-authority cases also passed (147 skipped): real Project
member LCM processing with pause, resume, stop and old-candidate denial, and
concurrent Privacy work fenced after revocation. The 13 preparation cases and
three database boundary cases remain valid. Source-runtime and fixture builds,
targeted lint, formatting and whitespace checks passed. No broad suite or
changeset was added. Continue with PROD-03.

## PROD-03: both creation orders and independent snapshots

Locally complete on 21 October 2026. A focused disposable PostgreSQL run passed
seven cases: rule-first snapshot creation, a stale destination rejection,
independent snapshot stop, the existing direct-first/native pending rule paths,
and fresh-rule behavior after older whole-grant revocation. Five creation-order
cases passed again after the final publication/replay fence changes. The new
Pending Share is created through a native Action Grant; exact repeated acceptance
returns the existing operation and does not duplicate the grant or contribution.

The rule-first check publishes a raw fixed snapshot at revision 1 beside a
rollup-only continuous rule, advances the rule to revision 2, and checks unchanged
rule authority. Stopping the rule preserves the fixed snapshot; stopping only the
snapshot denies its raw content and preserves the rule's revision-2 rollup.
Non-owner stop and stale review are denied. The publication transaction retains
the new representation as pending while the rule-created root remains active.

The focused Desktop confirmation check passed. Native binding/policy checks
passed (51 cases) and local-edge Action Grant mapping passed (21 cases).
Shared test typechecking, Desktop typechecking, DB typechecking, targeted lint
and diff checks passed. The general approval-policy catalog test exposed a
sample-matrix gap for eight rule/exclusion actions. A subsequent bounded catalog
update adds valid intents for all eight, retains exhaustive definition/schema
equality, and validates every sampled intent before resolving its protected
operation family. All 38 catalog cases pass. No broad harness expansion was added.

The native supervisor was stopped before refreshing runtime outputs. Current
source changes still require a managed source-runtime rebuild before live
combined acceptance. No release artifact or changeset was produced.

## PROD-04: accurate owner state

Locally complete on 21 October 2026. Fifteen focused Desktop cases passed:
failed preparation, Privacy filtering and publication each override an active
rule's general label; a stopped snapshot retains the active contribution;
existing terminal Privacy failure, refresh, transient-error recovery, selected
row focus and retry refresh remain covered. Detail copy distinguishes current
Personal preview, latest publication and fixed approval revisions, and explains
independent retained access and Team acknowledgment.

A focused repository case passed after giving the owned source a private title,
Project name and Folder path. The owner summary retains the original title;
Team representation reads exclude that private title and both metadata fields.
Removed Workspace access still denies the owner preview while the durable reason
remains inspectable. Targeted lint, formatting, Desktop typechecking and the
managed source-runtime build passed. The owner-state build checkpoint fingerprint was
`sha256:f4187b8e5d37a305d74b1c0d8d395b69c41680818c4f813b59d216c9170aa599`.
The disposable native supervisor restarted and ordinary `/ready` returned 200.
The existing Team Docker image has not yet been rebuilt for these source changes;
matching packaged/Team artifacts and combined live validation remain PROD-05/06.

An additional PROD-03 check also passed: a separately approved raw snapshot can
activate a broader owner policy beside a rollup-only rule without changing that
rule's authority, fixed publications or later updates.

Before PROD-05, Koed returned uncertain acceptance without a task ID. Its receipt was not
recoverable from the tool response. The initial text-based local lookup cannot
establish acceptance because task requests are encrypted. A subsequent metadata
lookup found the known previous receipt and no recent tasks for that same owner;
collection of the known previous receipt confirmed restored Koed access. The new
request initially remained unresolved. After a machine interruption, the User
authorized one fresh retry following runtime recovery. That retry returned a
task ID, was collected successfully, and found no relevant PROD-05 evidence.

Recovery restored missing workspace dependencies with the frozen lockfile and
rebuilt the source runtime. Docker required termination of a stalled backend
before relaunch. Duplicate PROD-05 services remain stopped; the retained fixture
uses one embedding service and one privacy service. Personal Memory and both
retained Team API readiness endpoints returned HTTP 200. The source-runtime
check passed with fingerprint
`sha256:515803b66ee6c2a57a55f6ca9b2715bdf69b98b6bd37faa2d5008c16d494abfd`.
These are recovery checks, not completion of packaged startup acceptance.

The catalog-only follow-up changes a test source after the owner-state runtime
checkpoint. Its 38 focused tests and targeted lint pass; production runtime
outputs are unchanged. The next managed build must refresh the checkout
fingerprint before another source-runtime restart.

## PROD-05: Reproducible build and fresh startup checkpoint

PROD-05 remains in progress. The following evidence is local development
evidence; it does not establish external deployment or release readiness.

The checked-in Team Dockerfile initially failed to compile `node-pty` on ARM64
with Node 22. It now installs Python, Make and G++ in a separate build stage.
The final service image excludes those tools. The actual API dependency resolves
and spawns a native terminal successfully. The corrected Team image is
`sha256:570a3d9b3ff58d71ca2151d0b9a68201daab2858e0231b32768b190d874c5dfc`.
The embedding image is
`sha256:c636510858159496b3520211f5cd422dee0c04d8c54432eb9543d881ad2aec48`.

Artifact comparison found 15 obsolete JavaScript modules in Desktop that were
absent from the clean Team image. TypeScript had retained outputs for deleted
source files. Source-runtime preparation now clears compiled output and build
state for its workspace closure after acquiring its lock and rejecting live
supervisor leases. Workspace builds run serially. Desktop packaging uses this
same preparation step. The deleted modules are absent after rebuilding. A
comparison of the current service runtime files matches across API, Worker,
server, database, Core, shared contracts, MCP Server, embedding and privacy
services, including browser approval assets and prompts. Applied migration SQL
and the journal also match. The comparison excludes type declarations, source
maps, TypeScript build state, OS metadata and schema-generation snapshots omitted
by packaging. It does not assert identical platform binaries or entire images.

The macOS ARM64 package uses an ad-hoc development signature. Its current
`app.asar` SHA-256 is
`8b70e96a655471e1ef4b9abc3e5e483682b7865b472a812fc711bece857d3e97`.
The local native asset staging used installed Homebrew assets. This proves local
operation only: it does not prove portable redistributable native assets,
Developer ID signing, notarization, or another supported platform. Those release
inputs were not supplied or published.

The standard server Compose file started against an isolated current-build
database with all 70 migrations applied. Its normal `/models` mount used the
verified Qwen3 0.6B model and the pinned Privacy Filter model cache. All services
became healthy without the alpha's temporary model bridge. The production
profile readiness check passed. Without WorkOS enabled, local authentication
remains advertised by the supported Team Self-Hosted fallback; this is not
evidence of verified WorkOS Team administration.

For synthetic sign-in checks, the same disposable stack switched to the
documented developer profile with the developer Team backend enabled. Keys and
database identity were preserved. The guarded fixture seed validated seven
Users, three Workspaces, fourteen memories and five collaboration threads.
Alice's password sign-in and authenticated navigation returned 200. Anonymous
navigation and an invalid password returned 401. After a clean Compose stop and
restart, the existing browser session and Workspace data remained usable, and
the fixture validation passed again. No historical database upgrade was tested.

Packaged Desktop's Set up Koed flow displayed the new bundled-local versus
external-service explanation. It completed normal model installation, started
native services, provisioned its local API Token and passed final verification.
API, database, queue, embedding, privacy, Local AI Runtime, API Token and MCP
Server all reported healthy. The native device proof remained verified. A clean
packaged CLI stop shut down native Postgres, embedding, privacy, API, Worker,
Local AI Runtime and supervisor. Relaunch resumed the same current-build profile
and `/ready` returned 200.

Enrollment used documented upstream registration, capability refresh, explicit
route policies and the exact local owner principal. The User approved the
fixture enrollment after automatic approval review required action-time
confirmation. Sign-in and approval ran in the in-app browser. Credential exchange
completed and the native enrollment state reports `exchanged` with a configured
credential. This is developer-fixture enrollment, not a WorkOS production proof.
A subsequent unattended packaged CLI stop and daemon restart preserved that
exchanged enrollment and configured credential. Core verification and `/ready`
passed again, and the verified device identity was unchanged. No Keychain UI
was used for this restart.

Native window validation exposed a synchronous macOS Keychain wait. Draft-store
provider selection is now deferred until use; missing draft reads and deletes
do not initialize the provider. A provider error still rejects writes without
falling back to weaker storage. The window appeared and setup completed, but a
later process sample still found the main process in `SecItemCopyMatching`.
Native UI automation then timed out. The User is away from the machine and
instructed unattended continuation without depending on Keychain approval. The
blocked GUI process was closed; the healthy packaged service runtime and
exchanged enrollment remain available for CLI/API checks. Rebuilt ad-hoc signatures may
request Keychain approval again; see Electron's
[signing guidance for safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
This remaining native UI issue is not counted as a production pass.

The bounded checks passed: thirteen source-runtime tests, seven draft-storage
and startup tests, targeted lint, Electron typechecking, and relevant formatting.
Existing setup-copy checks passed earlier. Drizzle generation now formats its
metadata through the normal generation command; parsed metadata hashes remained
unchanged by formatting, and migration consistency and formatting checks passed.
No broad suite or changeset was added for this checkpoint.

Reproduction follows the checked-in build and operation paths:

1. Install frozen workspace dependencies. Build Desktop with
   `pnpm desktop:package:mac`, providing native assets through the documented
   `KOED_NATIVE_RUNTIME_SOURCE_DIR` input when bundling them. See
   [native runtime assets](native-runtime-assets.md).
2. Generate and retain one environment file, install models in the normal
   `KOED_HOME` model directory, then use the checked-in
   [server Compose instructions](../examples/server-compose/README.md).
   Preserve all generated encryption and authentication values across restart.
3. Launch packaged Desktop with a fresh Koed profile and isolated Electron UI
   data, choose Set up Koed, and wait for final verification. Keep only one model
   service pair running at a time on constrained development machines.
4. Use the documented developer profile only for the disposable synthetic
   fixture. Provision disposable fixture passwords privately. Review enrollment
   in the in-app browser, exchange the approved credential, then stop and restart
   the same deployment without resetting its data.

At this checkpoint, native UI responsiveness and matching final artifacts
remained outstanding. The 22 October checkpoint below supplies the final
artifact identities. Native UI responsiveness remains open. WorkOS identity,
portable native release assets, signing/notarization and external deployment
evidence remain unavailable locally. The combined PROD-06 acceptance gate stays
open.

## PROD-05/06: Current-schema integration checkpoint, 22 October

After the integration fixes below, Desktop and Team artifacts were rebuilt
serially from the same current source. The
executable files for API, Worker, server, database, Core, shared contracts, MCP
Server, embedding and privacy matched across those artifacts. All 75 migration
SQL files and the journal matched, ending at `0074_yellow_nightmare`. The macOS
ARM64 development package passed strict signature and package-integrity checks,
and its bundled CLI help ran without accessing Keychain secrets. The embedding
image's service and Shared files match the same runtime checkpoint.

| Artifact                                          | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| macOS ARM64 `app.asar`                            | `fb6e7e8180045db9db3849e95352c807594c293a5e5e842c0799c4c87671d005` |
| Team image                                        | `bdb0346fad06d5ebf311881a7913c8eb4bc636c2879d7d1bf575668552c1b35c` |
| Embedding image                                   | `37f001d043cb73b2660642cfae385b56ebb7d9503fb9119f71583eaf5ce68cfc` |
| Combined executable-component and schema identity | `fa64fdc5472ff0f3080422d511e774e2d1c6ee1f346940e9095f0d834b1ce90d` |

These are local working-tree artifacts with an ad-hoc development signature.
The comparison has the executable/schema scope described in the earlier
checkpoint; it does not assert identical platform-native binaries. One embedding
build exhausted Docker's disk cache. Reclaiming 14.46 GB of unused build cache
allowed the normal build to complete. Images and data/model volumes were retained.

A fresh isolated deployment followed the checked-in server Compose configuration
with normal model mounts, new database volumes and one model-service pair.
Public Privacy Filter cache files were reused in the normal model volume; no
profile configuration, credentials or temporary model bridge were copied.
All five final services became healthy under the stock Team Self-Hosted profile;
readiness returned 200 and capabilities advertised that exact profile. The
documented developer profile and developer
Team backend switch supported the synthetic Users; this is local fixture
evidence, not verified WorkOS identity or external deployment evidence.
The guarded seed validated seven Users, three Workspaces, fourteen memories and
five collaboration threads. The ordinary Worker embedded all ten active
Team-visible representations. Alice and Bob signed in through HTTP and read
authenticated navigation. Anonymous navigation was denied. Existing HTTP probes
passed for browser-session and scoped-device representation reads, semantic
recall, answer evidence, candidate expansion and graph denial. Local-edge routing
remains unavailable without the enrolled local edge. Direct Personal API Token
probes denied Team search, answers, expansion and graph reads. The full advertised
Team Self-Hosted route inventory was tested separately under that profile:
all 118 authority routes rejected the token, with nine 401 and 109 403 responses.
The developer-profile inventory exposes only a smaller route subset and was not
used to claim the full production matrix. Responses did not echo credentials.

A clean shutdown stopped all five services successfully. Restarting the same
developer fixture configuration and retained volumes preserved both sessions
issued by this final build. Fixture integrity, authorized decryption, denial
boundaries and all ten dimension-matched Team embeddings passed again. The
standalone launch report marks backing tests `not_run` because those suites were
collected separately in the phased execution described below.

The existing encrypted backup helpers created and verified a same-build archive,
rejected verification with a different archive key, and restored it into an
isolated database with matching deployment encryption configuration. Comparisons
covered all 262 public tables. The final runtime was quiesced, so every original
row and value, including heartbeat timestamps, matched after excluding only the
helper's exact added synthetic restore records.
Original row identities and values matched, including eleven source consents,
eleven grants, eleven direct reasons, representations, revocations and twelve
retention policies, thirteen browser sessions and one Personal API Token created
by the final artifact. The restored fixture passed its authorized encrypted reads
and denial checks. This fixture has no selection-rule takeover or overlapping
rule reasons: restoration of those combined native states remains open.

The full launch command initially stopped on a stale assertion that migration
0047 must be latest. Its migration gate now explicitly selects current-schema
acceptance: apply the complete journal, verify the ledger and schema, create
current data, rerun migrations, and verify unchanged schema and data. The
75-migration check passed. Historical upgrade scenarios remain a separate command
and are outside this work package.

Realtime authorization fixtures also needed their current membership columns and
a publication view bound to their temporary relations. Temporary tables now get
explicit statistics because PostgreSQL autovacuum cannot analyze them. The
production companion/realtime lookup bounds the publication view to the exact
grant before joining its existing authorization predicates, avoiding multiplied
source-binding branches during planning. Its four existing cumulative-detail,
Curated Memory, downgrade and cross-Workspace cases passed in under two seconds
without increasing their timeout or removing assertions. The required full
collaboration suite also passed, including its 26 repository cases.

The encrypted Personal regression slice exposed another planning delay in LCM
inspection. The authorized event page is now materialized before linked-node
metadata hydration. Existing owner, source, recursive-node and cursor checks
remain intact. The disposable repository fixture also refreshes statistics after
truncation so estimates from earlier cases do not trigger excessive JIT work.
A timeout had let a still-running test restore its process profile during a later
case; isolated checks confirmed that the encryption assertion was a cascade from
that timeout. Five encryption regressions and five exact-node, provenance and
cursor-order regressions now pass under the unchanged PostgreSQL JIT defaults
and original test timeouts. JIT was disabled only for one diagnostic run.

The final API gate found an out-of-date endpoint inventory and incomplete test
environment isolation. The inventory now pins the twenty selector, publisher,
detail and content-policy endpoints added by this work. Disposable child tests
remove service encryption aliases as well as API-prefixed keys, so a test that
deliberately omits a provider cannot inherit the deployment's valid provider.
The parent fixture retains its own keys. The API, source-access, retrieval,
hosted-operations and workflow-performance gates then passed.

The server image intentionally omits Electron's binary payload. The existing
standalone Desktop scripts ran on the host instead. They exposed renderer
imports through the server-oriented Shared barrel, which evaluated Node-only
hashing and binary helpers in the sandbox. The sharing editors now import values
from the browser collaboration contract entry point; snapshot comparison uses
the existing browser-safe canonical digest. Server cryptography, classifier
identity, and secure credential storage remain unchanged. Nine focused browser
contract/editor cases passed. The Project workspace, Folder, transfer,
Conversation-card, collaboration and managed-preview scripts passed, including
privacy-safe Team reads, owner-only previews, revision publication, independent
controls, accessibility and stale-access purge. Assertions now use the accepted
explicit published-revision, privacy-stage and failure wording. This is
standalone synthetic renderer evidence, not the combined enrolled-device gate.

Full formatting and workspace typechecking passed at this checkpoint. A single
full lint process exceeded both the 1.5 GB and 3 GB heap limits. Bounded invocations
of the same ESLint configuration then passed all 1,779 repository source files in
23 batches with a 2 GB heap limit. The subsequently changed repository and
fixture files passed an additional lint check. Native
Desktop, the combined two-device journey, portable release assets,
Developer ID signing/notarization, WorkOS and remote staging remain unverified.
No Keychain approval, changeset, push, release or external deployment was used.

The remaining production dispositions are:

| Ticket          | Local evidence                                                                            | Remaining acceptance                                                                  |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| PROD-01         | Concurrent activation, retries and current-authority denial                               | Combined journey                                                                      |
| P2-10 / P2-11   | Workspace exclusion and reviewed restoration                                              | Combined retry, recovery and takeover intersections                                   |
| PROD-02         | Normal AI Client LCM preparation and later Team publication                               | Combined queued exclusions and controls                                               |
| PROD-03 / P2-12 | Independent creation orders and explicit snapshot conversion                              | Combined native controls and Source Access                                            |
| PROD-04         | Accurate owner labels, source titles, refresh and reason controls                         | Combined native explanations                                                          |
| P2-09A / P2-09B | Restrictive and explicitly approved broader policy changes                                | Combined native policy and exclusion interactions                                     |
| P2-13           | Interrupted history, restart, exact receipts and convergence                              | Combined native recovery                                                              |
| P2-14           | Native authority, publisher fencing, receiving identity and retained admissions           | Actual two-device transfer, former-publisher replay and source changes                |
| PROD-05         | Matching artifacts, fresh current-schema Compose operation, package integrity and restart | Packaged native responsiveness and current enrolled-device journey                    |
| PROD-06         | Same-build encrypted fixture restoration and applicable automated gates                   | Full combined native journey, restoration of combined rule state and release decision |

Reuse the accepted P2-01 through P2-08 evidence. OS-protected native approval
cannot be replaced by a browser fixture, repository test or weaker credential
store. The User is away and cannot answer Keychain prompts, so the combined
native gate remains unavailable unattended. WorkOS, remote staging, portable
native release assets and release signing require their actual deployment inputs;
local fixture success does not satisfy them. Production release-candidate
readiness is not asserted, and publication remains a separate decision.

## PROD-05: Resumed native installation, 22 October

The User returned to the machine and made interactive approval available.
The first resumed launches showed no Keychain prompt. Brief samples of the
native main process showed its normal event loop rather than `SecItemCopyMatching`.
The User subsequently confirmed approving a Keychain prompt. The earlier
unattended Keychain limitation does not describe this resumed run.

Native startup exposed a separate installation failure. Installed library links
pointed into the previous app bundle. The preceding service-only package replaced
that bundle without native resources, so `llama-server --version` failed to load
`@rpath/libllama-common.0.dylib`. The Embedding Service reached its startup timeout.

The packaged installer now preserves relative symlink targets when it copies
native assets into `KOED_HOME/runtime`. A regression installs a linked library,
removes its source component, and reads the installed library successfully. It
also proves that the installed checksum and status remain valid. All thirteen
packaged-runtime cases and targeted lint passed. No validation or credential
protection was removed.

Desktop was rebuilt through the documented native-asset input. The package
passed signature and integrity checks. Normal packaged installation restored
Postgres and llama.cpp in the disposable profile while retaining its database,
identity, credentials and models. The installed library link is relative, and
the native embedding model loaded successfully in about two seconds.
Automatic transcript discovery is disabled only in the synthetic test launchers.

The earlier trial profile's final check timed out in MCP diagnostics. Native
acceptance moved to three fresh synthetic profiles: two devices for Alice and
one for Bob. They have separate Personal databases, roles, generated encryption
configuration, Codex homes and Electron data. They share one model-service pair
through supported external dependency configuration. The test Compose override
binds dependency ports only to loopback. The Team fixture database remains intact.

Fresh external setup exposed a separate ordering failure. External embedding
readiness comes from the local API, but the model stage ran before that API
started. The external model stage now starts the normal managed local services
before evaluating their existing model and Privacy readiness results. It does
not install or start Operator-managed dependencies. Bundled-local model
installation keeps its existing path. Four focused checks pass, including fresh
external startup, rejected startup, existing local model installation and required
Privacy health. Targeted lint, package compilation and integrity checks pass.

The rebuilt Desktop `app.asar` SHA-256 is
`a51aa5d4c61e0747799732b0cc1c9ab18711435f0c2be8e56afa37085da2b18b`.
The matching Team image is
`sha256:3dcd39dcc61df31793fbc9487bf90a78b88fa0b008b3e44030cc8c2892a10037`.
All ten executable/schema components match again. The unchanged embedding image
still matches the Shared and embedding service files. All 75 migrations remain
unchanged. These identities supersede the earlier artifacts in this record.

The first fresh native profile completed core setup and final verification. Its
API, database, model services, Local AI Runtime and local API Token report
healthy; device identity reports verified platform protection. The external test
launcher supplies model-service credentials and the profile's API Token pepper
explicitly, keeping credential setup consistent with the running API. The native
Personal shell reports that Koed is ready. With the User's explicit approval,
the local fixture accepted Alice's first device enrollment, and the local edge
exchanged and validated its protected credential. Shutdown completed and the
enrolled profile was relaunched. Startup and local authentication are healthy
after restart. The native app recognizes Alice and the fixture Team, lists the
prepared Shared Memory in Electron Team App, and displays Bob's Memory Event
beside the two companion discussion messages. This completes the local PROD-05
packaged-operation criterion. The remaining native profiles and the combined
two-owner, two-Workspace, two-device journey remain in PROD-06.

Alice's second native profile also completed core verification and exchanged its
approved fixture credential. Its operator-provisioned migration schema needed
ownership by that profile's existing database owner. This correction was limited
to the disposable database; the runtime role received no global privileges.

The combined journey then exposed a pairing-service startup defect. A healthy
local Personal runtime using external dependencies did not start its owner-only
request control socket, so Devices incorrectly reported that Koed needed to
start. The supervisor now starts that service for local Personal runtime mode
with either dependency mode. External server mode remains excluded. The
private-interface listener still requires an explicit device request, and the
existing encrypted exchange and signed enrollment checks remain unchanged.
All 41 supervisor checks pass, including the real Unix control socket, shutdown
cleanup, and exclusion of external server mode. Targeted lint passes. The native
package was rebuilt and passed signature and integrity checks. Its `app.asar`
SHA-256 is `746789c88ab61d6a705532dfb828e6ae7a5df752fdec4d48b8ab9dcf06bf5ba2`.
The matching Team image is
`sha256:325a2fca8588b34ed0d4e5c240996144ccb6f269a53de866784a7f7e4227f7bd`.
All ten executable/schema components match. Only the server component changed;
the other nine, including the 75-migration schema, are unchanged. These identities
supersede the preceding resumed artifacts. The fixture services were restarted
without reseeding, and Alice's second profile was relaunched for the native
pairing retry. The combined gate remains open.

The rebuilt second profile's supervisor reaches healthy core startup in about
eleven seconds. Its owner-only pairing socket now responds with the expected
no-pending-request result, replacing the earlier unavailable-service failure.
The native main process subsequently waits in `SecItemCopyMatching` while the
macOS approval agent is running. The User is away, so no approval or native UI
pairing result is assumed. Protected identity and credential stores are retained;
the remaining native journey awaits that OS approval.

While the native approval is pending, the supported packaged daemon command
starts Bob's fresh profile successfully. API, current-schema database, models,
Local AI Runtime and local authentication report healthy. Under the User's
existing explicit authorization for all three fixture enrollments, a separate
synthetic Bob session approves his challenge through the fixture HTTP API.
The resulting credential is bound to the fixture's Bob account and is exchanged
and validated locally. This is API enrollment evidence; Bob's native UI has not
been tested.

Read-only checks verify three distinct server-confirmed device credential IDs.
The two Alice profiles bind to Alice and each receive three Workspaces. Bob binds
to Bob, receives two Workspaces and cannot see the Cloud Workspace where his
access is disabled. Alice's first profile also restarts as a healthy packaged
daemon on the rebuilt artifact. The original fixture data and all profile
credential lineages remain intact. These checks prepare the combined journey;
they do not replace native pairing, owner review or the outstanding combined-state
restore proof.

After Keychain approval, the second native app recovers and reports ready. Its
Devices flow creates a pairing request successfully. The request retains its
identity, waiting state and expiry through normal app shutdown and supported
daemon restart. The first native app creates an empty Personal Device Group and
reviews that exact request. Connection remains at the confirmation step pending
the User's separate approval for Personal device access.

The User then approved that test-device connection. The original ten-minute
request had expired and was refused. A renewed request for the same receiving
profile completed through the native review. Both profiles report the same
signed group head and epoch, with two active members; the native Devices view
shows Fixture Alice A and Fixture Alice B as paired. This proves enrollment,
not delivery of source content.

While that approval is pending, a bounded synthetic producer creates one source
in Bob's isolated Personal profile through the production Transcript Watcher.
The watcher ingests four source records without errors. The retained journal and
canonical cursor both reach all 950 source bytes; the Captured Session has
Personal visibility and a portable Git Anchor. Personal search uses semantic
vectors and returns the two synthetic source items from that Session. This first
fixture producer did not record a source-time Folder observation, so the original
Folder correctly remains unresolved. It is not evidence for Folder selection.
Subsequent synthetic sources use the normal capture-context observation function
before capture. The existing unresolved origin is preserved.

After pairing, three new synthetic Alice sources captured twelve records without
errors. Each has a distinct, known original Folder and the same portable Git
Anchor. Their completed turns exposed two integration defects before successful
replication could be claimed. The joining supervisor woke the worker before
binding its runtime to the local User. The wake now follows that binding, as in
the existing Desktop path; all eleven pairing-client checks pass and require that
ordering. A normal post-binding wake restored signed capability negotiation on
the existing test devices.

Codex records without provider item ids also lacked the stable source item id
required by Personal publication. The transcript adapter now retains its existing
deterministic record key as the fallback source id. It does not infer a provider
semantic identity or alter Projection eligibility. Eleven adapter checks pass,
including replay, segment boundaries, distinct repeated records and preserved
provider ids. All 62 watcher checks pass with normal filesystem access. The
sandbox run reached the filesystem watcher handle limit and is not counted as a
pass. Targeted lint passes. A native rebuild is in progress; replication and the
combined native gate remain open. Existing test records are retained as evidence
of the earlier failure and are not rewritten as a compatibility migration.

The next native run exposed connection starvation on the receiving API. Several
relay wake listeners remained leased while their durable mailbox checks waited
for database capacity. Disconnect handling was installed only after those
checks. The held-wake route now installs notification, disconnect and deadline
handling before the check and races it against those wake signals. All eleven
relay-route cases pass, including real loopback disconnects and notifications
while the mailbox check is deliberately pending. The existing signed request,
current membership and durable read checks remain required. The combined gate
remains open until this correction is packaged and exercised on both devices.

The corrected package materialized all three fresh sources on Alice's second
device. Each replica is ready with four source items and a distinct local
Session. Authenticated Session reads return 200 in milliseconds. Original Folder
identity and paths, signed originating owner and logical Session identity are
preserved; the receiving projection uses its own local User scope as designed.
This is delivery evidence, but final inbox acknowledgment remains open: an older
package can retry after a newer package has advanced the same origin cursor.
The worker now reads its authenticated recipient cursor and skips an unnecessary
backward write. Replica data planes expose only their requesting recipient's
signed cursor read, using the same current membership validation as cursor
writes. The server's backward-write rejection remains unchanged. Thirty worker
runtime checks and eleven relay-route checks pass, including out-of-order and
large cursor values, malformed cursor denial and replica read boundaries. The
final native retry and matching-artifact refresh remain outstanding.

Both profiles report healthy API, database, Worker and Privacy readiness on that
package. Personal semantic search on the receiving profile returns the synthetic
primary source using vector retrieval. Separate configuration inboxes exposed a
completion-state mismatch: verified non-source packages do not pass through the
source materialization transition, so their completion was rejected. The worker
now marks that verified non-source outcome explicitly after materialization and
ACK. Completion keeps the current worker lease and null source-retention binding;
source-package completion retains its original checks. All eleven worker service
cases pass. The real PostgreSQL reconciliation case also passes, including
unverified completion, wrong-worker and repeated-completion denial alongside
existing source materialization checks. Previously failed test inboxes are kept
as failure evidence; no quarantine or security check is reset to claim success.

After a further rebuilt-app Keychain prompt, the User approved macOS access and
the native UI resumed. A queued synthetic turn initially failed because Docker's
disk was full. Removing only unused, rebuildable build cache older than one hour
freed about 9.8 GB; database volumes and profile stores were retained. Retrying the
existing transcript consumed exactly its three queued records without appending
another turn. Both native profiles then reported healthy local services.

The native UI created the private Project `Synthetic release acceptance` and
included one current synthetic Conversation. A normal owner-scoped runtime wake
refreshed the recipients' expired capability advertisements. The later source
turn reached acknowledgment, and new non-source inboxes completed successfully.
Both profiles return the same Project catalog and revision. Receiving membership
uses its own local Session and preserves the signed original source reference.
These are native creation and encrypted configuration delivery results; the
manual wake does not prove idle recovery.

Idle recipients had no configuration-capability refresh until new work woke
them. New work could itself require a fresh recipient advertisement, leaving a
publication cycle pending. Configuration advertisements now refresh through the
existing one-minute peer-maintenance path, before checking whether a direct
endpoint exists. The same path is tested without a peer endpoint, with immediate
duplicate refresh suppressed and a later refresh after a minute. Thirty runtime
checks and eleven service checks pass, and targeted lint passes. Capability
expiry and signed current-membership validation are unchanged. Packaged idle
acceptance passes: after 203 seconds without a manual wake, a new synthetic turn
arrived on the second device through normal encrypted delivery. All three
Conversations retain their signed source identity and original Folder context.
A private Project catalog and its included Conversation also converge between
devices. The rebuilt Desktop and Team artifacts match across all ten runtime
components, with 75 current migrations; the local Team services were refreshed
without reseeding or replacing encryption keys.

The first native Shares load exposed incomplete stock fixture companions: two
Alice-owned fixture grants had no discussion, although the owner list reported
Workspace content available. Creating those two synthetic discussions through
the supported scoped-device API completed the fixture data; it did not reset
fixture state or weaken response validation. Combined native sharing and
takeover acceptance remains open. Alice's native candidate preview to Electron
was correctly denied because write access alone does not grant owned-Memory
sharing permission. A fixed Memory Events snapshot to her authorized Cloud
Workspace completed browser consent in the in-app browser. Source delivery
remained pending while Sync was disabled. The User explicitly approved adding
Sync to all three disposable profiles; normal replacement enrollment retained
their device identities and fixture principals and added only that family.
The accepted snapshot recovered through normal source preparation and became
active at its exact approved revision, with its source title restored. Native
Git Anchor creation then exposed a local binding defect: Team authenticated the
replacement device credential, but local enrollment validation checked only the
unchanged owner and backend. Local delivery still referenced the retired
credential and rejected the approved operation before any rule-creation request
reached Team. Enrollment checks now optionally require the server-confirmed
credential ID, and the native control path supplies it. A mismatch reuses the
existing verified enrollment-rotation path and retires previous local authority.
Sixty-five API checks, thirty-one real-database authority checks and targeted
lint pass. A missed API interface declaration was caught by packaging and aligned
with the database contract. The active snapshot also passes current-fixture
read and semantic-recall checks: Carol receives its new synthetic content, while
Bob's disabled Cloud membership and non-member Frank receive 403 without content.
The authorized response exposes no local Folder path or private Project name.
The rebuilt packaged API now reads the three owner Shares successfully with
one active local enrollment matching the server-confirmed replacement credential.
The previous credential is no longer locally bound; background startup had
completed rebinding before the explicit read. Matching Desktop and Team runtime
components and all 75 migrations were recorded again, and the local fixture was
refreshed without reseeding. A new rebuilt-app Keychain wait was confirmed by
a bounded native sample and cleared by the User. The same-build app restart
then reached healthy startup. Native Git rule delivery and combined native
acceptance remain open; a subsequent local connection reset is being diagnosed
while the direct fixture credentials continue to authenticate.

## P2-13: Expired and unavailable history checkpoint

The reconciliation catch path discarded a failed proposal but retained its
expired or unavailable change cursor. Every later attempt could fail on that
same cursor without starting a replacement baseline. Abandoning such a scan now
clears the retry cursor while retaining the installed generation and source
delivery state.

Six focused repository cases pass for Git Anchor, exact Folder and private
Project selectors, each with expired and unavailable history. Expiry uses a
25-hour clock advance. Missing history removes only the selected disposable
cursor. Immutable cursor records are not rewritten. Each case proves that the
old complete generation survives the failed scan, a new complete baseline can
commit, and an ambiguous remote request retains its exact mutation, request
hash and body through recovery and subsequent source changes. Existing checks
continue to fence obsolete source leases and recover the exact receipt.

Fresh stop initiation also has an explicit supported boundary. A new stop
requires the existing current online Action Grant review. An offline or
temporarily unavailable review now explains that the User must connect and
that Team access may remain until approval and acknowledgment. Four focused
renderer-client checks cover Conversation and selection-rule stops; no native
approval callback or execution command is issued after the failed review.
Previously approved queued controls keep their existing durable retry path.
This does not add fully offline approval.

A further combined encrypted-journal regression passes for a simulated 25-hour
outage with two Workspaces. It reconstructs the journal and reconciler, preserves
the committed baselines, retries an approved queued stop with its original intent,
and catches up one addition and one removal in the other Workspace. It also
retains two later Memory Events, preserves stopped versus active state, and
proves stable stop receipts and no duplicate source work after convergence.
This check uses validated synthetic Team acknowledgments: it does not prove
remote content publication or read-back of the later Memory Events. Targeted
lint and test typechecking pass.

The repository checks used their isolated test database. The current-build
CLI/API fixture journey below completes the actual publication and read-back
portion. Native UI acceptance remains in PROD-06.

## P2-09A: Active policy processing checkpoint

A focused repository regression now extends the existing paused-history checks
with an active rule. It prepares a later source revision explicitly, claims its
Privacy work, then applies a reviewed restrictive amendment through a real
native Action Grant. The old representation immediately becomes unreadable;
the old processing targets cannot be read or claimed. Exact amendment replay
returns the same receipt, while a changed mutation with the stale review fails.
Reprocessing publishes revision 2 under the restricted content policy. Merely
reviewing a broader proposal leaves the published policy unchanged. Executing
its fresh reviewed amendment restores the prior content policy without changing
active state or owner fidelity permission. Targeted lint and test typechecking
pass. This single test passed in 40.55 seconds with a bounded 60-second timeout.

This checkpoint uses the isolated repository-test database and synthetic Privacy
classification results. It proves authority and publication identity, not the
classifier's masking accuracy. Overlapping reasons, the complete HTTP/native/
browser/durable path and consistent owner entry-point enablement remain open.
P2-09 editing stays disabled while those slices are completed.

## P2-09A and P2-09B: Reviewed content-policy operation

The production path restores the owner-scoped HTTP review and device-only write,
current-state approval admission, native and fresh browser decisions, and the
encrypted durable delivery worker. The worker now handles the exact
content-policy receipt rather than falling through into Conversation creation.
Previous, required, added and effective masks are visible in approval. Broader
Memory Events disclosure requires browser step-up; other reviewed policy changes
use native review. Review identity includes the complete current rule, members,
destination, enclosing policy and expiry. API Tokens remain denied.

The active overlap regression passed with real repository publication and
semantic authorization. An independent paused rollup preserves revision 1 under
its own policy, while the amended rule cannot use that policy to expose Memory
Events or LCM Leaves. Restriction immediately removes richer detail from reads,
indexed recall and cached evidence expansion. Old claimed Privacy work is denied.
Fresh approved broader processing publishes revision 2 and a subsequent revision 3. A stopped rule stays stopped after an amendment and after replay of an older
accepted receipt; source preparation remains denied, while the independent paused
rollup remains readable. The paused-only regression also passes and retains its
exact published revision through restriction and restoration. These tests use
synthetic classification results and the isolated repository-test database;
they do not establish classifier accuracy or the combined native package gate.

Focused API checks pass for current-review and stale-review admission, approval
tiers, native/browser decisions, exact HTTP authorization, and durable delivery
recovery after a lost response and expired local custody. The full five-file API
run passed 205 of 206 cases; its sole failure was an outdated expectation for the
already-added nullable grant version. After correcting that expectation, all 44
HTTP route cases pass; the other four files passed unchanged.

The owner editor is restored in both Conversation and selector rule controls.
Two focused editor tests pass: initial policy discovery cannot submit a proposal;
required categories remain checked and disabled; confirmation submits the exact
reviewed scope; a failed approval or write requires another review. Delivery copy
shows pending Team acknowledgment, including retained access until restrictive
changes are acknowledged. Final Desktop integration, lint and type checks are
recorded with the completion checkpoint below.

Completion checkpoint: P2-09A and P2-09B are locally complete. The active combined
case passes with future publication and stopped-state checks; the paused case
passes in 23.97 seconds. These history cases have explicit 90-second caps.
The complete 91-case Desktop App run passed 90 cases and identified an old
owner-route fixture with no sharing reason; the corrected fixture now includes
its direct authority and the Excluded section, and that case passes on rerun.
All three detail-editor cases and both new policy-editor cases pass. Approval-policy
and Shared Memory admission suites pass all 91 cases. API and Desktop source
typechecks, targeted lint, and typechecking of the changed policy tests pass.
The combined native journey and final matching artifacts remain in PROD-06;
these local checks did not require Keychain approval.

## P2-12: Explicit snapshot conversion

The existing reviewed Conversation-rule operation now accepts one exact fixed
snapshot scope. It binds the selected reason and consent, consent version,
fixed revision, detail, Curated Memory choice and expiry to the existing source,
destination and grant-version proof. The approval refreshes this scope. No
selector rule or extra future member authority is created. New metadata lives
in `pending_sharing_rule_admissions.snapshot_conversion`; migration 0070 and
its generated snapshot pass the migration consistency check.

The same Pending Share source workflow prepares the continuous reason. Before
initialization, it locks source then root authority and verifies the selected
snapshot again. The snapshot stays readable until the new reason has an eligible
publication. Retirement of that exact snapshot consent commits with Pending
Share completion and one ordinary lifecycle notification. Independent reasons
and Conversation Source Access use their existing authority. No separate
publication engine or backend synthesis is introduced.

A focused repository case passes through real native Action Grants for preview
and conversion. It rejects stale snapshot scope without creating a rule,
recovers exact requests, preserves the fixed snapshot during Privacy preparation,
pauses and resumes before first publication, retires the snapshot at completion,
publishes later completed summaries, and denies queued work after stop. An
independent paused rule still serves revision 1, and an unrelated source in
another Workspace remains unchanged. Fresh review and a second request are
rejected after initialization, while the original request still recovers its
receipt. The conversion and ordinary snapshot-overlap cases pass together
(2 cases, 36.90 seconds) with per-case 90-second caps. Test data and synthetic
classification results remain confined to the isolated repository-test database.

Three editor checks pass for exact source/destination and unchanged limits,
explicit confirmation, rejection of changed snapshot authority, and fresh review
after failed approval or execution. HTTP, current approval-scope and durable
lost-response cases pass, including byte-identical retries carrying the selected
snapshot. The final three-file API run passes all 158 cases. Shared and database
builds, migration consistency, targeted lint and changed-test typechecking pass.
Final source and Desktop integration checks follow below. No Keychain approval
was required for this local evidence.

Completion checkpoint: P2-12 is locally complete. Final API source and Desktop
source typechecks pass. All 94 cases in the Desktop App and conversion-editor
run pass, and all 158 cases in the three-file API run pass. The final two
repository cases also prove one lifecycle notification at conversion completion
and that ordinary rule creation still leaves its independent snapshot fixed.
The combined native Source Access journey, final matching artifacts and broader
production gate remain PROD-06. No changeset was added.

## P2-13: Current-build Team outage and read-back

The local Team self-hosted fixture ran the current server image
`sha256:acc444199c2345e83228526b846f939966bc04b61f1b27b55436ac3dbedf3ad5`
with the original authorized publisher and one shared model pair. No credentials
were reactivated, operation families expanded, or Keychain approvals required.
All sources were isolated synthetic Captured Sessions; unrelated Personal
Conversations were excluded by a fresh unique Git Anchor.

Carol successfully read two synthetic publications in each of Cloud Memory
Platform and Managed Knowledge Ingestion. The stop was reviewed while online,
then durably queued while the Team backend was stopped. The publisher also
stopped. Only the two selected synthetic cursor records were removed. During
the interruption, one matching Conversation was added, one changed Git Anchor,
and two later turns were captured through raw-item ingestion and Projection.
Both publisher and backend restarted with the same identity and custody.

Recovery cleared the missing checkpoints and installed complete replacement
baselines. The queued approval expired before reconnection: its original exact
operation remained needs review, with no false stopped acknowledgment. A fresh
reviewed stop succeeded at authority version 8 and publisher fence 2. Replaying
that exact completed stop twice returned identical acknowledged receipts. The
expired approval was not extended or reused for new execution.

Carol's five final reads returned the expected results: both stopped-destination
reads and the removed member in the independent Workspace returned 403. The
remaining member returned 200 with both later-turn markers. The added member
returned 200 with its synthetic marker. Metadata checks found five destination
roots, exactly one per source and destination. Normal owner retry controls
settled two failed publication attempts without replacing their Pending Share
identities; both remaining members finish activated. The stopped rule finishes
stopped, and the independent rule remains active.

The initial ad hoc source setup was invalid: it omitted raw contributors, then
canonical contributor manifests and source timestamps. Publication and sync
rejected these incomplete sources. Those harness-only memberships were retired
through owner overrides. The accepted baseline used fresh timestamped raw items
and successful normal Projection before sharing. Temporary diagnostics existed
only inside the disposable container; it was recreated from the unmodified
current image before this outage journey. No production checks were relaxed.

The 25-hour duration and selector matrix remain covered by the focused
repository cases above. The actual fixture uses a bounded interruption and
unavailable history rather than waiting 25 hours. This completes local P2-13
acceptance, with expired uncommitted controls explicitly requiring fresh review.
It does not establish native UI or final packaged-artifact acceptance.

## P2-14: Publisher identity and verified source-mapping foundation

Owner-only rule and sharing-reason DTOs now carry the recorded publisher's
device identity and label. Authorization availability remains distinct from
connectivity. The focused expired-publisher repository case passes, including
reader denial of the owner's rule list. Shared and DB builds, Desktop
typechecking and targeted lint passed for this first slice.

Migration 0071 adds a nullable owner-scoped portable-source digest to rule
members, with a partial unique index per rule. Native admission binds this
identity once, verifies the original capture-sync identity against the current
publisher credential and canonical source root, and rejects a second logical
source claiming that member identity. It stores no plaintext portable origin
identifiers. The repository publication case passes exact replay, collision
denial and ordinary later-turn publication. Its additional source-lookup checks
pass for the owner, return no mapping for an unknown source, and reject another
owner or publisher.

The new device-only owner endpoint resolves an existing identity without
creating sharing or source authority. Its focused HTTP check rejects Personal
API Tokens, browser sessions, insufficient device scopes and a caller-supplied
publisher credential. Private repository failures remain redacted.

Receiving delivery uses an existing source only after fresh checks against its
authenticated Personal source binding, retained package, ready receiving
materialization, current selector and Git/Folder context versions. It cannot
fall back to a guessed native identity. Twelve delivery cases across Git Anchor,
Folder and Project prove that missing mappings, stale/unavailable evidence and
absent Team members remain pending without a new admission or upload. Together
with the existing delivery cases, all 33 tests pass.

The existing signed, encrypted two-device Personal source-context journey also
passes with real receiving-checkpoint assertions for Git Anchor and original
Folder selection. The original source is resolved; a local Conversation with the
same provider identifier and a stale context version are rejected. The real
receiving checkpoint also fails the native-source authorization check. Six journal
history cases pass with a native Personal origin in a distinct namespace from
the Team transport. Their source corrections use the reviewed causal path.
Native and receiving identities remain separate.

P2-14 remains in progress. The backend transfer protocol is now implemented and
focused PostgreSQL cases pass for active and paused rules. Each uses a real
receiving-device native Action Grant and exact receipt replay. They reject the
former publisher's reads/writes, unknown source identity, another owner, the
current publisher as receiver and ordinary unscoped mutation. Published revision
1 remains available; later source sync retains its original identity and publishes
revision 2 after active transfer or an explicit resume. Root grant IDs and consent
IDs remain unchanged. Removing the verified portable member binding prevents
preparation. Stale former-publisher preparation and a revoked original sync
credential also fail. These are API/repository checks, not native GUI acceptance.

The six-case selector/transfer regression initially exceeded the default
15-second test timeout. With a bounded 60-second timeout, Git Anchor, portable
source, Folder and both transfer cases passed; Project exposed a fixture leak
from the deliberate revoked-source denial. The test now stops that rule through
the ordinary reviewed owner control. Both transfer cases and Project pass together
after that cleanup. No production timeout or authorization behavior was relaxed.

The source continuation checks exposed two assumptions that the publisher must
be the source credential, in preparation and materialization. The reviewed
transfer path now requires an existing native-bound portable member and the
committed native transfer receipt before accepting that distinction. Current
publication authority, original source sync authorization, exact preparation,
Privacy and Workspace exclusions remain mandatory.

The focused HTTP, native approval, selector review and delivery suite passes 177
cases. Folder scope retains original provenance across local owner translation;
Project descriptor checks distinguish a portable identity from a local lookalike.
Shared and DB builds, API source and focused test typechecks, targeted lint,
formatting and whitespace checks pass after the continuation adjustment.

Receiving local availability review, baseline installation, durable owner controls,
Conversation identity binding and combined takeover acceptance remain unfinished.
Current packaged artifacts and fixture images predate this slice and must be
rebuilt for final acceptance. No changeset was added.

### Conversation rule origin retention

Migration `0072_familiar_gamma_corps.sql` adds a nullable validated origin digest
to Conversation Pending Share rule admissions. The native creation request binds
the optional Personal origin. Admission verifies the native authoritative source;
only the digest is retained in the pending record and activated member. Internal
activation must match that pending digest, and ordinary standalone rule creation
cannot inject a digest.

A real native-approved PostgreSQL case passes admission replay, changed-identity
replay denial, absence of plaintext origin in pending metadata, activated member
digest retention and an authorized second device's Conversation takeover review.
The existing explicit snapshot conversion case passes alongside it. The focused
native approval and HTTP suite passes 103 cases, including request-hash changes
when the Personal origin changes. Shared and DB builds, API and focused test
typechecks, and targeted lint pass. This is backend continuity evidence: local
first-party availability verification and owner takeover controls remain open.

### First-party Conversation origin verification

The local owner review now obtains an optional origin from the exact ready
native Personal source. The reader requires an available native binding and
resolved context state, rejects retained packages and PDS/Team receiving replicas,
and checks the canonical logical Team source. Approval mapping preserves that
origin, and approval preflight, new durable delivery and queued execution each
verify it. Unavailable source evidence leaves an explicit pending request. Both
owner creation placements retain the origin, including snapshot conversion.

The focused API local-control suite passes 82 cases. Added checks reject a
changed origin, an unavailable source or mismatched logical Memory before
approval, preserve the verified origin in the remote approval request, reject a
tampered origin before saving delivery, and defer queued execution without a
remote write when local source evidence is missing. The existing exact retry
case recovers after evidence becomes available.

A native signed-source journal case passes the new Conversation reader. The
existing signed encrypted two-device Personal source journey passes against a
fresh database pair and explicitly denies native Conversation origin resolution
for the receiving checkpoint. Shared and DB builds, API/Desktop source and
focused test typechecks, targeted lint, formatting and whitespace checks pass.
Publisher takeover controls and the fresh receiving baseline remain unfinished;
these checks do not stand in for the combined native takeover journey.

### Receiving takeover source and Project identity proof

The local journal now exposes a receiving takeover source reader. It accepts an
exact available native source or authenticated retained checkpoint with ready
materialization and resolved Git/Folder state. A selected Git Anchor, Folder or
Project must still match current Personal membership and exclusions. The reader
returns original Personal identity and current local context; it neither creates
a Team binding nor permits a new native source admission.

The focused native signed-source journal case passes. The existing signed,
encrypted two-device source-context journey passes in a fresh database pair and
verifies receiving Git Anchor and original Folder evidence, wrong-owner denial,
and continued denial of native source creation from receiving checkpoints.

The existing signed two-device membership journey also passes. A receiving native
Project view ID and its portable identity resolve to the same signed catalog
identity. A separate same-name local Project cannot substitute for that identity;
a wrong owner and conflicted catalog heads are denied. A Project alias is never
guessed from a name or path. DB build, focused test typecheck and targeted lint
pass. Owner takeover commands, exact local review integration and fresh baseline
installation remain open.

### Receiving takeover review boundary

The typed local review command and renderer client now request takeover review
for a chosen verified local source. The Team request excludes local source
pointers and private selector references. Its response must preserve the exact
rule, Team, Workspace, authority version, publisher fence, receiver credential,
original Personal identity and selector scope. The local intent and accepted
transition schemas enforce the same rule/destination relationship and exact
active/paused publisher transition without new consent.

Thirteen focused review cases pass across Conversation, Git Anchor, Folder and
Project scopes. They reject missing receiving authority, unavailable/local-only
source evidence and changed source, local owner, receiver, destination, version
or selector. The companion local evidence check accepts a newer context that
still matches the approved selector and denies missing evidence. Accepted-scope
checks reject wrong fences, credentials and state/catch-up transitions for both
active and paused rules. Existing command-registry and local sharing-control
checks pass alongside the review boundary suite. Shared build, API/Desktop and
focused test typechecks, targeted lint, formatting and whitespace checks pass.

This exposes review capability only. Local native grant request wiring, durable
transfer, fresh receiving baseline installation and interactive owner controls
remain open, together with the combined native takeover journey.

### Native takeover delivery and receiving history installation

The local publisher mutation now passes through receiving evidence preflight,
native Action Grant admission and protected custody, the encrypted delivery queue,
and exact Team receipt validation. The renderer client follows the same approval
and acknowledgment workflow as other rule controls. The Team request excludes
local source pointers and selector references. Each queued execution rechecks
receiving source evidence. When evidence disappears, only a read-only receipt
request is permitted until it returns.

Migration `0073_dear_yellowjacket.sql` permits the publisher-transfer operation
and the explicit source-unavailable retry code in the local delivery journal.
The latter fixes the constraint mismatch found while exercising missing evidence.
Transfer acknowledgment and receiving history installation share one transaction.
A transferred scope retains the exact approved Team selector and receipt, with a
local target and no fabricated creation-review token. Previous source/page work
is superseded, lease and delivery epochs advance, and generation, proposal and
consumer cursor start empty.

Three PostgreSQL cases pass for active, paused and first-time receiving histories.
They cover encrypted receipt retention, source-unavailable retry, wrong-mutation
receipt denial, former-lease rejection, empty initial history, new local generation
and checkpoint, no inherited remote source tuple, and exact delivery replay.
The normal local selection enumeration completes from the receiving database.
These are storage and current-selection checks; they do not prove full existing
Team member reconciliation.

The five focused API/approval/review suites pass 156 checks. The new integration
case uses the real local preflight and durable worker: unavailable evidence causes
no mutation request, a lost response retries the identical request, a wrong-mutation
reply is rejected, and the exact receipt settles without reacquiring protected
custody or creating Pending Share source work. Preflight initially rejected the
full local mutation envelope as extra review fields; it now projects the exact
review evidence before validation. API, Desktop and focused test typechecks,
Shared/DB builds, targeted lint, formatting and migration checks pass.

P2-14 remains open. A fresh receiving device has no prior source journal with which
to discover Team members removed from the selection before takeover. Existing
Team membership must be reconciled against verified Personal evidence before the
baseline can be called complete; unavailable and local-only sources must remain
pending. Interactive controls remain unexposed until that gap is closed, followed
by the combined two-device and offline former-publisher journey.

### Receipt recovery after source evidence disappears

Read-only receipt routes now recover a committed publisher transfer or Conversation
creation with the exact original Action Grant binding. They use the existing
atomic receipt executor. The unused-approval callback returns no result, so it
cannot consume approval or perform the mutation; an already committed operation
returns its original encrypted receipt. An unusable grant has no retry authority.
The worker retains valid uncommitted work as source-unavailable and sends unusable
approval to review. Source availability is never bypassed for a fresh execution.

The focused HTTP and durable-worker suites pass 108 checks, including evidence
loss before execution and after response loss, no mutation during receipt probes,
and wrong-mutation receipt denial. Two real PostgreSQL transfer cases also pass
unused-approval preservation and exact replay without a second mutation. A
further focused HTTP check covers an unissued grant returning no pending authority.

### Existing member discovery boundary

The current publisher can request at most 100 existing members per inventory page,
using an exact authority version and publisher fence. Keyset pagination returns
member and logical Memory IDs, state/version and the opaque owner-scoped origin
hash. Missing hashes remain visible; no local source binding is fabricated. The
endpoint exposes no source content, Personal origin identifiers or private paths.
Personal API Tokens, browser sessions and devices without publisher operation
families cannot use it. Repository authorization also denies another owner, the
former publisher and stale authority/fence values.

This is bounded discovery, not a historical membership snapshot or a completed
receiving baseline. Integration must resolve hashes against verified local
Personal evidence, finish the full paged scan before installing its replacement
baseline, retain missing evidence as pending, and revalidate current member
versions for each eventual mutation. Interactive takeover remains unexposed.

Focused HTTP checks pass for strict inputs, authenticated publisher dispatch,
pagination forwarding and redacted denial. Real PostgreSQL cases pass for active
and paused transfers, former-publisher and other-owner denial, stale scope denial
and retention of null origin hashes. A separate pagination check uses 101 members
and verifies a 100-entry first page, one-entry final page, strict ordering and no
duplicates. Its inert sources retain valid source bindings and receive no consent
or publication.

The local journal also exposes a paged verified Personal binding scan independent
of the selected Git Anchor, Folder or Project. It checks owner, exact native
pointers, authenticated receiving/native provenance and available source context.
It includes retained explicit deletions for later selection evaluation. It does
not infer selector membership or authorize removal. The existing signed,
encrypted two-device source journey passes receiving discovery and wrong-owner
denial.

### Durable receiving member reconciliation

Transferred histories now stage the Team inventory after completing their new
Personal enumeration and before installing the replacement source plan. Each
phase reads at most 100 Team members or verified Personal bindings. Matching
portable hashes are evaluated against the completed local selection checkpoint.
Conclusive nonmatching/deleted sources receive removal goals for existing Team
members. Unavailable sources remain unresolved, and missing bindings remain
counted as pending without fabricated native pointers or new source authority.

Inventory pages, binding cursors and unmatched member counts stay encrypted
across restarts. Pages retain their rule, destination, selector, authority and
publisher fence, with ordered unique member IDs and advancing cursors. Scope
changes restart the replacement baseline. Fresh writes pause during staging,
including attempts from previously claimed leases; outstanding requests can
settle. Transferred histories rescan even when their Personal checkpoint has no
changes, so later available evidence converges.

Three PostgreSQL storage cases pass for active, paused and first-time histories.
The fresh case scans 101 Team members, recreates the service between phases,
proves no delivery before complete installation, rejects changed destination/fence
and duplicate pages, removes a verified nonmatching source, and retains 100
unavailable/unmapped members. Later available evidence resolves one member
without a selector change, reducing the pending count to 99. Team inventory is
mocked at this storage boundary; actual publisher authorization and signed
two-device binding discovery are covered separately. The existing delivery/control
suites pass 94 checks. A transport check also verifies current scope discovery,
pinned pagination, device authentication, conflict restart and private-pointer
omission. Shared/DB builds, API/test types, targeted lint and formatting pass.
The combined native two-device journey and interactive owner controls remain open.

### Receiving Project rule discovery

The first-party rule list now supplies its Personal target to the local command.
The local edge verifies that target against the requested selector and resolves
a receiving Project view through available signed catalog identity. Only the
normalized selector and page controls reach Team. The response must retain that
selector. Missing or wrong-owner identity evidence fails before rule lookup.
The normalization reader reuses the signed two-device Project alias resolver
already exercised above; it grants no source or sharing authority.

A focused local-control case verifies normalized lookup, private native-ID
omission, missing/wrong-owner proof denial and target/selector mismatch denial.
The existing Desktop sharing review checks also pass with Personal targets sent
for Git Anchor, Folder and Project rule lists.

Re-entry remains an explicit P2-14 follow-up: a receiving checkpoint currently
defers a removed member instead of creating native admission or source-upload
work. Fifteen focused cases across the three selection kinds confirm the existing
authority boundary, including removed members. This is safe pending behavior, not
evidence that the complete re-entry journey works.

### Project identity at creation and queue admission

Creation review now resolves the same Project identity used for rule discovery.
The completed local review still binds the exact native target, owner,
destination and source snapshot. Its Team selector uses the verified portable
identity. Fresh queue admission resolves that identity again before validating
the completed review and acquiring protected approval custody. An altered local
target cannot reuse the earlier review token. The Desktop retains queued status
using the exact local target when its native view differs from the Team selector.

Locally created Projects remain supported before Personal sync is configured.
The resolver requires an owned active Project, its native creation history and
current native catalog head, with no associated received catalog. Pending or
conflicting received evidence cannot fall back to a local UUID. The stricter
takeover source resolver retains its existing signed-catalog requirement.

The three focused review/control/Desktop suites pass 84 checks, including
portable creation lookup, private native-target omission, missing evidence
denial, completed-token binding and queued UI status. One native PostgreSQL
Project case verifies sharing without Personal sync, refusal to fall back while
a pending catalog exists, and recovery when that pending evidence is removed.
Shared selector hashes in the renderer use the browser-safe canonical digest.
The complete native two-device journey remains open.

### Owner publisher controls

The Desktop now exposes publisher review on selection rule cards and Conversation
rule details. Selection choices use bounded Personal review pages, preserve native
receiving pointers and omit local-only identities. Conversation choices come from
local Personal navigation. The exact local review is checked against the current
rule, destination, authority, fence and selected source before native approval.
Returned normalized Project targets remain part of that reviewed local intent.

The control shows old/new device labels and preserved active/paused state. It uses
the existing protected native approval and durable transfer client, then records
queued delivery through the existing owner status and acknowledgment refresh.
Expired, mismatched and superseded reviews cannot request approval; busy controls
prevent duplicate confirmation. Scope changes and unmounts discard late results.

Fourteen focused UI checks pass, including paused-state preservation, one native
request before queued delivery, stale/expired review denial, private source choice
paging and the existing three-selector owner flows. Three focused owner-route
checks pass, including Conversation choices taken from local navigation without
an automatic approval request. Desktop/test typechecks, targeted lint and the
production renderer build pass. Packaged native acceptance remains open, along
with the combined two-device and synced-source re-entry journeys.

### Existing-source re-entry authority

A read-only repository helper now checks an existing member removed by selection
after a committed publisher transfer. It requires current owner/Workspace sharing
permission, unchanged approved rule policy, exact authority/fence/member/grant
versions, a native-bound portable source, and an active original sync credential.
The synchronized replica and cached Session must remain available. Current source
policy and previously admitted source capabilities must cover the unchanged rule.

Only automatic selection removal qualifies. Explicitly revoked members, other
consent revocation causes, Workspace exclusions, stale or foreign authority,
reduced source policy, missing identity evidence and revoked original credentials
are denied. Canonical Team identity is derived again from the original sync
credential and source Session; the receiving publisher creates no new origin.

One PostgreSQL case passes the positive and denial checks after real native rule
transfer and member removal. It verifies unchanged consent, Pending Share, source
binding, grant and membership state, with removed content still unreadable.
The read-only authority helper creates no preview, consent or source work.

Existing-source preparation now uses the current encrypted Team cache in an
owned repeatable-read transaction. It rechecks the exact retained authority,
original active source credential, source Session, source revision and current
owner-policy version. It cannot expand source policy or substitute the receiving
publisher's identity. Transient snapshot/deadlock failures have the same bounded
whole-transaction retry used by ordinary source preparation.

The candidate manifest is derived from current active original sync mappings,
using the same manifest reconstruction as Pending Share validation. Incomplete
mappings reject preparation. The PostgreSQL case verifies current content after
a later original-source revision, denies missing mappings and invalid authority,
and retains removed membership, revoked consent, unchanged grants and no new
Pending Share or source origin. Four selected PostgreSQL cases pass, including
existing repository, folder and Project admission after the shared manifest
reconstruction change. DB build, API/test typechecks, targeted lint and formatting
pass.

### Retained-source admission and delivery

The current publisher can now submit an exact retained-source admission for a
previously published member removed automatically by selection. The request
contains current selection context and portable source identity, with no source
bytes, native source IDs, candidate preview or client-supplied authority proof.
Team validates the existing binding and unchanged approved future scope, prepares
a current candidate from encrypted source cache, and records immutable retained
proof on the Pending Share. This proof retains the owner-scoped portable digest
and a digest of exact source authority, with no raw Personal origin identifiers.
Activation reconstructs the authority from current rows before comparing it.
Native source creation and binding are unchanged.

The background worker rechecks original active sync credentials, current source
policy, exact publisher/fence/member/grant versions and Workspace exclusions
before creating consent and activating membership. A retained candidate requires
its persisted proof. This path cannot expand source policy. It creates a new
consent under the approved future rule, preserves the old revoked consent and
reuses the destination grant. Exact receipt replay needs no source re-upload or
fresh candidate generation. Migration 0074 adds retained admission proof and the
server-created candidate authority marker; migration consistency checks pass.

Four focused PostgreSQL cases pass: source authority/preparation, revision-2
readmission and publication on the same grant, original credential revocation
before activation, and source policy reduction before activation. The latter two
create no fresh consent and publish no removed content. All 94 local delivery and
API route checks pass, including three-selector retained delivery, ambiguous
accepted receipts, replay after a newer removal goal, no receiving source upload,
and rejection of unauthenticated or forged source/authority fields.

### Stale retained-admission recovery

An unresolved member can now replace stale retained admission work only when its
latest accepted Pending Share carries the server-created candidate marker and
retained portable proof. Explicitly revoked operations cannot use this path.
The current owner, original source, policy, Workspace and native-approved future
scope are checked again before replacement. Revalidation happens before the old
pending operation is retired, and receipt replay retains the original result.
Healthy preparing work with unchanged source, publisher and selection context
cannot be replaced.

Owner-private member inspection indicates whether a retained operation needs
readmission. Local delivery uses this signal or changed selection context, and
leaves unsupported native pending sources unavailable. Accepted retained work
remains eligible for inspection every 30 seconds until Team initializes the
member. This uses existing durable delivery state, survives journal restart and
stops when the member is present. Ordinary native admission acknowledgment is
unchanged; an older receipt cannot acknowledge a newer removal goal.

A PostgreSQL recovery case verifies healthy-work rejection, later original-source
revision 3, obsolete-operation retirement, immutable old receipt recovery, no
consent for the retired operation and publication on the same destination grant.
The encrypted journal case verifies delayed observation after restart and clean
completion. All 54 local delivery cases pass, including healthy-pending deferral,
server-signaled recovery and changed-context recovery across three selectors.

### Unpublished native-admission continuation

A native source that was accepted but still unresolved at publisher transfer can
now continue under the current rule. Team verifies its original accepted native
candidate, native-bound portable membership, current original sync relationship,
current Workspace permission and unchanged approved future scope. The source
cache must have reached the revision accepted by the original operation. A
recorded continuation links retirement of that native operation to the new
retained operation; later activation reconstructs the same exact authority.

The destination may still be absent. In that case continuation reuses the native
operation's planned logical destination and creates one grant through the normal
activation path. An initial source policy is allowed only when no policy history
exists, bounded by the original candidate and current rule. Its identity remains
stable across preparation and activation. An existing reduced policy cannot be
expanded, and revoked native admissions cannot use this path. Missing original
source data remains unavailable. Canceled retained requests use bounded 30-second
retry scheduling; ordinary native cancellation keeps its existing schedule.

Eight focused PostgreSQL cases pass together. These include first publication
with no prior destination or source policy, explicit native-admission cancellation,
a later restrictive source policy, and the five retained admission/recovery
cases. The first-publication case verifies one destination grant, one initial
source policy and no consent for the retired original operation. Local delivery
covers continuation without an existing grant and no receiving source upload.

The combined native two-device journey and matching final builds remain
unverified; these repository and delivery checks do not establish packaged native
acceptance.

## Enrolled native selector and lifecycle checkpoint, 22 October

Matching Desktop r9 and Team artifacts completed the enrolled Alice journey for
Git Anchor, exact Folder and named Project sharing. The User approved each exact
synthetic scope. Git Anchor sharing targets Cloud Memory Platform; exact Folder
sharing targets Managed Knowledge Ingestion and excludes child Folders. Project
sharing targets Cloud Memory Platform and includes its one synthetic Conversation.
All use Memory Events with Curated Memory excluded. Personal Project names and
local Folder paths were absent from authorized Team reads. The fixture's Alice
Electron sharing denial was preserved; Workspace write access alone did not
permit sharing.

A later captured turn became readable in both approved destinations through
normal source synchronization and Privacy processing. Each destination retained
one logical contribution. The earlier direct snapshot retained revision 14
alongside the independent Git Anchor reason. Project pause retained its published
revision 16 while Git Anchor sharing published revision 51 for the same source.
Native resume caught the Project reason up to revision 51. Native stop removed
only that reason; the Git Anchor contribution remained readable. Encrypted
Personal replication retained the three current sources' origin identity and
original Folder context on Alice's second device. Earlier captures without
portable item identity remain explicit unavailable evidence rather than being
rewritten or guessed.

The owner Conversation Share dialog then exposed a response-contract mismatch:
the owner grant index deliberately omits companion scope, but the local reader
required it. Valid owner requests therefore failed with `permission_denied` even
though the remote index returned 200. The local reader now parses the existing
owner-safe grant contract and uses the same companion-scope reconstruction as
the owner inventory. Owner and logical Memory identity checks, pagination,
version checks and authenticated companion resolution remain in place. The
regression reproduces the prior failure with the actual owner-safe response;
all 67 focused local-control cases passed, including wrong-owner and wrong-source
denial. Packaged verification then found a second mismatch: companion creation
used the owner logical Memory ID where the Team route requires its existing
grant-scoped source ID. The local caller now uses that grant-scoped ID in both
the request and exact response validation. The test fixture follows the actual
Team contract. All 69 focused cases pass, including missing-companion recovery
and rejection of a raw owner ID in the Team response. Refreshed packaged
verification now passes for both affected Conversations through the actual
packaged API, preserving their existing grants and revisions. The packaged
profile is healthy after a normal service restart, and package signature and
integrity verification pass. The first rebuilt package failed the companion
check and was superseded; it is not counted as accepted evidence.

The combined native second-owner, publisher-transfer, exclusion/policy,
Conversation-rule and Source Access checks remain open. Earlier repository
checks do not substitute for those native criteria. The User is away from the
machine again; unattended work must not depend on another Keychain approval.

The matching Team build encountered Docker disk exhaustion. PostgreSQL stopped
and recovered through its normal WAL recovery after space was reclaimed. No
database repair, reseed, cursor reset or encryption-key replacement was used.
Unused build cache and four untagged superseded images generated by this work
were removed; current images, all databases/model volumes and the original alpha
environment were preserved. Disk headroom was checked before retrying the build.
This is an observed local capacity failure, not a product authorization failure.

### Refreshed artifact and restoration checkpoint

Desktop and Team were rebuilt after both owner-reader corrections. All ten
executable/schema component identities match. Desktop retains `app.asar`
`f9af0e54e41dd66be195b29179e0766f69b750bef09cacb4bfb3f2a53d054b22`;
the Team image is
`0ac96836a83fda272b9643f28fab0211262cde74ee66575dd4e106aa44b3eed9`.
The combined component identity is
`75332572fabab53109b5c8482f0a2c441a7b040d6a97e04f8989416b63177d9a`.
The schema remains 75 migrations ending at `0074_yellow_nightmare`. An unchanged
`app.asar` alone does not identify the service code packaged outside it.

All five services reached health after deploying the matching local image without
reseeding. Authorized synthetic reads and recall returned 200; disabled Workspace
and non-member reads and recall returned 403. Team responses contained neither
local Folder paths nor the private Project name. The later turn remained readable
through the active Git Anchor reason, while the Project reason remained stopped,
with one logical contribution.

A quiesced encrypted backup of this enrolled native state restored into an
isolated same-build database with the retained encryption configuration. Exact
row/value digests match across all 262 public tables, excluding only the backup
operator's documented target-only encrypted restore sentinel. This includes three
selection rules and nine memberships, independent reasons, grants, consent,
revocation and retention rows, encrypted representations and publication identity.
Normal archive verification and restore sentinel decryption pass; a wrong archive
key is denied. The strict stock-fixture thread inventory was not rerun because
approved native sharing intentionally extends it. This restoration does not yet
cover the unfinished native publisher takeover.

The restored database was then served by the same verified image with the same
keys on the fixture's loopback port while its source server was stopped.
Authorized read and semantic recall returned 200 with the expected synthetic
content. Disabled Workspace and non-member requests returned 403 with no content
marker. The restored active Git Anchor reason retained revisions 16 and 51; the
Project reason remained stopped with no published representations. The source
still had one logical contribution. The disposable restore-check container was
stopped and removed, and the fixture returned to its source database. All five
services are healthy. Native profiles remain stopped, and this checkpoint
required no Keychain approval.

### Receiving-device readiness and native approval limit

Alice B starts the matching package with its existing enrollment and paired
Personal data. Its packaged local control plane reports healthy. All three
current Personal replicas return 200 through the normal owner API, retaining
portable Git identity and original Folder context while Alice A is offline.

The packaged local owner API prepares exact publisher-transfer reviews for the
existing Git Anchor and Folder rules. Each review recognizes Alice B's current
credential, the original synchronized source, current active rule state,
authority version 1 and publisher fence 1. Project discovery resolves its
replicated private Project identity to the same stopped Team rule. These
read-only operations do not transfer publication, create consent or resume the
Project rule. The reviews expire and must be refreshed before approval.

The native UI stopped responding during this launch. A bounded one-second sample
found its main thread in `SecItemCopyMatching` and macOS SecurityAgent was running.
The User is away and cannot approve Keychain requests. Normal termination did not
end the blocked main process; only the disposable GUI was then terminated. The
protected credential store and local services were preserved. No OS approval,
insecure storage fallback or publisher transfer was performed. This is a real
limit on the remaining native journey, rather than evidence that takeover passed.

### Native Git Anchor publisher transfer

After the User approved the current Keychain prompt, the same receiving process
recovered. The User then approved the exact native Git Anchor publisher transfer
from Alice A to Alice B, preserving the active Cloud Memory Platform rule at
Memory Events detail with Curated Memory excluded and its Git selection unchanged.
The native action was acknowledged. Team authority and publisher fence advanced
to 2. All ten source/destination contribution identities and existing grant,
reason and consent identities stayed unchanged.

Alice A queued a later synthetic turn while offline, then drained it through the
normal Transcript Watcher after restart. The later revision was published under
Alice B's authority/fence 2. Its verified encrypted Personal checkpoint arrived
on Alice B through ordinary paired-device delivery, preserving original Folder
and portable Git identity. Both old-fence and current-fence publication attempts
by Alice A returned 403 without mutation audit rows. Its original source Sync
remained authorized. The six retained rule members survived, while Alice B had
only three verified local sources; missing local-only sources were not guessed
or removed. Authorized read and semantic recall included the later turn; disabled
Workspace and non-member requests remained denied without private context.

This completes P2-14's local native Git Anchor journey. The earlier encrypted
restore predates this transfer; final same-build restoration must include it.
Other combined native controls remain open under PROD-06.

### Native startup and post-transfer owner reconciliation corrections

A cold native launch left collaboration offline despite healthy API/database
services because its recovery gate depended on a stale saved verification result.
A regression reproduced the missing retry. Desktop now uses API/database
readiness for the existing bounded recovery; onboarding retains its full setup
checks. All 93 App cases pass, including offline recovery and nonretryable
permission denial.

After the transfer, the native source Share dialog exposed a second valid owner
read being rejected. The authenticated grant's update timestamp advanced while
its direct snapshot stayed at the same effective source revision. Reconciliation
had required both to advance. It now accepts a newer timestamp with an equal or
higher revision, keeping all authority fields identical. Both local API and
encrypted storage retain rollback and authority-change denial. The focused
regression failed before this correction. Packaged verification is pending.

The refreshed Desktop package passes integrity verification, and all ten runtime
and schema components match the refreshed Team image
`21b4ec86f9f91e684b7c0de266c34154890e67f7d544ce1876792920f5cf6158`.
The component identity is
`02f630aaba93955b5ef913c5aeac911cf91a1e80029926c048d0e51ec31422ec`.
The external renderer bundle identity is
`98c2d42529ea3c670fea0097945a3fea9f2babc36e4962ccf9d1fc8e38294dbf`;
`app.asar` remains unchanged because renderer assets are packaged separately.
Both APIs report ready after the normal same-key refresh. The actual packaged
owner reader passes for both affected Conversations, retaining the fixed snapshot
at revision 14 and the independent live destination at revision 53.

The native Alice process encountered another Keychain wait after rebuilding. The
User approved it. That same process recovered healthy service state, Team
navigation and Recents without a retry or renderer reload. The source Share
dialog now lists both destinations and their controls without the access error.
An extra default GUI opened by UI-tool selection was closed; observations from
that separate default window are excluded from acceptance evidence.

The 74 focused API and 32 PostgreSQL authority cases pass, as do all 93 App cases.
Production typechecks pass in both package builds. A full test typecheck exceeded
the 2 GB heap cap and is recorded as unavailable for this refresh. Targeted
API, PostgreSQL and Desktop test typechecks pass under the same cap after fixing
the test fixture's declared mode union. No additional product change was needed.

The native explicit snapshot conversion reached its exact browser step-up review
for Alice A's primary snapshot, revision 14, in Cloud Memory Platform, Memory
Events, Curated Memory excluded, no expiry. Human approval was requested. The
review expired without approval; no conversion committed. Conversation Source
manifest reads returned 404 for authorized Memory reader Carol, disabled
Workspace member Bob and non-member Frank before a source grant. The native
source-access request was denied before an approval was created. Read-only
metadata confirms that this Team-side synchronized session has no retained
Conversation Source Artifact. Personal paired checkpoints do not substitute for
that separately authorized Team source prerequisite. Positive native Source
Access remains unverified; the denial is not counted as a successful source grant.

A native restrictive exclusion then exposed a durable-delivery dispatch omission.
Both Workspace exclusion and restoration were supported by request persistence,
authority binding and receipt handling, but absent from the delivery command
allowlist. The approved exclusion entered `needs_review` with
`authority_unavailable` before contacting Team. No Team exclusion committed.
Two delivery regressions reproduced the failure. The queue now admits both
existing command kinds through the normal authenticated authority and exact
Action Grant path. All 76 focused local-control cases pass. Packaged verification
of this correction remains pending.

### Delivery correction and committed-transfer restore checkpoint

The delivery correction is packaged. Desktop integrity verification passes, and
all ten runtime/schema components match Team image
`061a35152e976a4bd0a48960be1a86cdf2646e8a53abb51fa24bdacf2671ce44`.
The combined component identity is
`36d651bf1f53b5a9b9c62719004cf5803eea76c1b87ba4c6f5c3307b44feac84`.
The renderer identity remains
`98c2d42529ea3c670fea0097945a3fea9f2babc36e4962ccf9d1fc8e38294dbf`.
The embedding image and 75-migration schema remain unchanged. All five services
became healthy after the same-key local refresh. Authorized synthetic reads and
recall returned the later turn; disabled Workspace and non-member requests were
denied without private Folder or Project context.

With native profiles stopped and Team writes quiesced, an encrypted same-build
backup containing the committed publisher transfer and later source publication
restored into an isolated database. Exact values and row counts match across all
262 public tables, excluding only the backup operator's exact target-only restore
sentinel. Archive verification and sentinel decryption pass; a wrong archive key
is denied. This preserves consent, revocations, retention, independent reasons,
publication identity and transfer authority. The extended native inventory is
not presented as a fresh stock-fixture topology check.

The same verified image and encryption configuration then served the restored
database on the loopback fixture port while the source server stayed stopped.
Carol's read and semantic recall returned the later synthetic turn. Bob's disabled
Workspace and Frank's non-member requests returned 403 without content markers.
The owner inventory preserves all ten distinct contribution identities and their
reason, consent, authority and publisher identities. The Git Anchor rule remains
active with Alice B, authority version 2 and publisher fence 2. The Project rule
remains stopped. The restore-check container was stopped and removed, and the
source database was resumed. Native delivery verification of the exclusion fix
and the remaining combined controls are still open.

### Current fixture source-format correction

A bounded read of the existing signed source fixtures returned 503 for the active
continuous case. The normal worker reported zero source materialization targets.
The three retained artifact rows were mislabeled `jsonl`, while all five signed
segment manifests already declared `codex_rollout_jsonl`, the format accepted by
the current sanitizer. The fixture generator now writes that canonical artifact
format. No legacy-format support was added to production readers.

The existing live-database fixture test now verifies that both active source
grants reach the production sanitizer target query. It failed with zero targets
before the correction; all five fixture tests pass afterward, including complete
seed/reset and encryption-provider invariants. The running local fixture received
only the three deterministic metadata-label corrections, after verifying every
signed segment already used the canonical format. Source bytes, signatures,
grants, consents and native sharing state were preserved. A normal server restart
materialized the sanitized derivatives without a cursor reset or manual wake.

Current-build HTTP read-back passes for Carol's continuous and fixed-snapshot
source cases. The continuous derivative covers both committed segments; the
snapshot covers only its approved first segment. Response digests and no-store
headers verify, the synthetic email/API-key canaries are absent, and later
snapshot content is excluded. Revoked source and Frank's non-member reads return 404. This establishes a usable existing fixture source case for Bob's remaining
native controls. Alice's newer synchronized primary has no retained Team source
artifact and still cannot grant source access. No new source grants were created.
The Team tooling image was refreshed to
`69ddd0bca42f6af0d8fd8a8d426448a61ef05d9aec05f763a5ba6634d606bdaf`.
All ten runtime/schema component identities remain unchanged and match Desktop
under `36d651bf1f53b5a9b9c62719004cf5803eea76c1b87ba4c6f5c3307b44feac84`.
Desktop was not rebuilt. The same native process remains open at its previously
requested Keychain approval.

During this tooling refresh, Docker Desktop's internal filesystem exhausted its
space even though the host still had free disk. PostgreSQL stopped after failed
restart attempts, and Redis reported AOF write errors. Unused build cache and
three verified untagged, unreferenced superseded images from this work were
removed. Current images, all containers, all database/model volumes and the
original alpha environment were retained. Docker's internal filesystem then had
4.3 GB free. No further heavy build was required.

PostgreSQL completed normal WAL recovery after its existing container was started;
no database files were repaired, reset or reseeded. Redis resumed AOF writes and
reported persistence status `ok` without a reset. Normal dependent-service
restarts reached health. The current-image source privacy, fixed-snapshot bounds,
revoked/non-member denial, native Memory read/recall and ten-contribution identity
checks pass after recovery. The failed native exclusion remains uncommitted.

A quiesced encrypted checkpoint of this recovered canonical source state passes
exact row/value comparison across all 262 public tables in an isolated restore.
It includes three signed source artifacts, five original segments, three source
grants, two sanitized artifacts and two sanitized chunks. Wrong archive keys are
denied and restore sentinel decryption passes. Restored-service source read-back
also passes: continuous and snapshot source bounds, digest verification, canary
redaction, revoked/non-member denial and the native Memory read/recall boundaries
match the source deployment. All ten contribution, consent, reason and publisher
identities remain unchanged. The restored container was stopped and removed, and
the source deployment resumed normally. This checkpoint does not complete the
remaining native UI gates.

### Native restart, exclusion and restoration

After a machine restart on 23 October, the existing five-service Docker fixture
recovered without a rebuild or reseed. The unchanged packaged Desktop reopened
Alice A with healthy API, database, model services and local authentication. No
new Keychain approval was required for this launch.

A fresh native review excluded the current child Conversation from Cloud Memory
Platform after Git publication had transferred to Alice B. Durable delivery was
acknowledged on its first attempt. The owner view showed the Workspace exclusion
and explained that every sharing reason was blocked. Carol's direct read returned
403 and recall omitted that grant; Frank's read and recall returned 403. The
independent primary contribution remained readable and recallable. The previous
failed delivery was retained as requiring review and was not reset or replayed.

The User then approved the exact native restoration review. Its delivery was
also acknowledged on the first attempt. Carol could read the child again under
the existing Git rule, preserving publisher authority version 2 and fence 2.
The stopped Project rule remained stopped. This verifies the packaged exclusion
and restoration delivery fix through actual native controls and Team reads.

The User also authorized the primary snapshot conversion. Its fresh review was
approved as synthetic Alice through the in-app browser: fixed revision 14,
Cloud Memory Platform, Memory Events, Curated Memory excluded, this Conversation
only and no expiry. Desktop retrieved the approval and created the continuous
Conversation rule. Its pending publication activated at revision 53 on the same
destination grant, then retired only the selected fixed snapshot's direct consent.
The independent Git reason retained its existing authority, consent and published
revisions, and the Folder destination remained unchanged. Native pause retained
revision 53 and readable Team content; resume returned the Conversation rule to
active under the same approved scope. The old fixed snapshot stayed stopped.
Native stop subsequently removed only the converted Conversation rule's access.
The existing Git reason remained active, and Carol's read and recall still
returned the later primary content. Bob and Frank remained denied in Cloud.

### Native second-owner sharing and independent Source Access

Bob's existing disposable profile completed normal packaged core setup against
the shared external model services. It preserved its enrollment and synthetic
Conversation. The User approved continuous Conversation sharing to Electron
Team App at Memory Events detail with Curated Memory excluded. The normal
in-app-browser review was approved as Bob. Publication activated at revision 2;
Carol's direct read and recall returned the synthetic content, while Frank's
equivalent requests returned 403.

Bob's existing Timeline grant showed continuous Source Access in the native
editor. Before revocation, Carol read the sanitized source with verified digest,
snapshot bounds and canary redaction; existing unauthorized cases remained
denied. The User explicitly approved revoking only this source capability.
Native review and execution completed, and the editor changed to “Not allowed.”
Carol's source manifest then returned 404 while the Timeline semantic Memory
and Bob's new native contribution remained readable. Frank remained denied.
No replacement source grant was created.

The native content-policy editor also demonstrated that all eight enclosing
required redaction categories were selected and disabled. No required category
could be turned off. Positive policy amendment evidence remains the focused
publication, approval, HTTP and renderer checks recorded earlier; this native
observation proves the enclosing-policy restriction, not an additional amendment.

Bob's native detail amendment was explicitly approved in both directions. Reducing
the active Conversation rule from Memory Events to LCM Rollups advanced its
authority and consent versions and denied Carol's event read with 403. Recall
omitted the exact grant identity. The independent Timeline Memory stayed readable
and its source stayed revoked. A separately approved in-app-browser step-up
restored Memory Events detail. The same grant became readable and appeared in
recall again; Frank remained denied throughout. Query text echoed in an answer
response is not counted as retrieval evidence.

A final quiesced checkpoint of this original fixture state passes encrypted
backup verification, wrong-key denial and exact comparison of all 262 tables
against an isolated restore. The restored service preserves Alice's ten and Bob's
three distinct contribution identities, reason and consent versions, detail,
source revocation and publisher authority. Authorized and denied reads/recall,
independent source snapshot bounds, canary redaction and source revocation pass
through the actual restored service. The original fixture was resumed afterward.

### Isolated native content-policy amendments

The User approved one bounded check in the restored synthetic copy because the
original fixture requires every category and therefore has no editable rule
category. The existing versioned policy repository made only Private dates
optional in that isolated database. The other seven categories stayed required.
The original database was checked before and after the journey: its deployment
policy remains version 1 with all eight categories required, and Bob's original
rule remains authority version 3 with no rule-specific policy amendment.

The same packaged Bob profile opened against the isolated copy and recovered
automatically once its API and database were ready. Its editor exposed only
Private dates and locked the seven required categories. The User approved adding
that rule mask. Because the enclosing policy hash had changed, the previous
effective mask could not be proven; the app correctly required fresh browser
approval rather than treating that uncertainty as consent. The in-app-browser
review completed, normal delivery reached authority version 4 and content-policy
version 1, and publication resumed under the effective all-eight-category mask.

The User then separately approved removing only that added mask. The new review
showed the exact previously masked, required and newly permitted categories.
Fresh authenticated browser approval reached authority version 5 and content-policy
version 2, with only Private dates newly permitted. The rule stayed active at
Memory Events detail, with Curated Memory excluded and the same contribution.
Authorized direct reads and grant-scoped recall passed after each amendment;
Frank remained denied and the independent source revocation remained enforced.
These are native approval, authority and publication checks. The existing source
canary and focused classifier evidence retain their separate scope.

The native app and its background services were stopped normally. The isolated
policy-check container was stopped and removed, and the original five-service
fixture resumed healthy. No original policy, consent or rule was relaxed to make
this check pass. The prior exact original-state restore checkpoint remains valid.

### Exclusion during claimed policy reprocessing

One additional bounded repository case reuses the existing active-policy journey
to cover the remaining processing intersection. It prepares and claims work
under the reviewed restrictive policy, excludes the Conversation, and verifies
that preparation, claimed-target reads, publication, semantic reads and recall
remain denied. Only a fresh reviewed restoration permits reprocessing. The
existing journey then completes broader-policy approval, later publication and
stop under unchanged owner fidelity limits. The case passes in 24.74 seconds
within its 90-second limit, using synthetic classification and an isolated
disposable PostgreSQL database.

An initial runner used a test database containing another suite's local deployment
identity and failed before any test ran. The bounded retry used a fresh dedicated
database and removed only that database afterward. The fixture and native data
were never repository-test targets. No broader suite was repeated for this
test-only addition.

### Native snapshot-after-rule form correction

The final original-fixture check found that the native Share dialog offered
**Add fixed snapshot** for Alice's rule-shared Conversation, then disabled
**Review** as if every active destination were a duplicate. It also treated the
rule's already activated Pending Share as unresolved work. The backend and
approval checks recorded earlier did not expose this renderer defect.

The renderer now allows only the intended additional reason: snapshot mode on
an active captured Conversation destination with an existing rule and no direct
reason. Activated Pending Shares no longer block that operation; unresolved work
still does. Confirmation continues through the existing exact logical grant ID,
expected grant version, preview and fresh consent path. No server authority or
approval condition changed.

The focused regression failed with the active destination before the correction
and passes afterward, including denial while its pending work is still preparing.
All 95 Desktop App cases, targeted lint and changed-test typechecking pass.
The initial test queried a portal through the wrong container and was corrected
before recording the meaningful red/green result. The Desktop package refresh
passes integrity verification. Its 377-file external renderer identity is
`92f4c15e08990388be3d44fddff79e024de425b0c624e040048673352e829cf9`.
The archive remains `f9af0e54e41dd66be195b29179e0766f69b750bef09cacb4bfb3f2a53d054b22`.
All ten service/schema components remain unchanged and match the current Team
image under `36d651bf1f53b5a9b9c62719004cf5803eea76c1b87ba4c6f5c3307b44feac84`.
The Team image was not rebuilt for this renderer-only correction. Actual native
completion remains pending; PROD-03 is reopened until then.

### Packaged snapshot-after-rule completion

The refreshed native package completed the separate fixed snapshot review beside
Alice's active transferred Git Anchor rule. The User approved the exact current
revision 51, six Memory Events, Cloud Memory Platform destination and exclusion of
Curated Memory. Authenticated approval used the in-app browser. The existing
logical contribution and grant were reused; the new direct reason has its own
consent. The stopped Project reason stayed stopped.

Privacy filtering remained visible until the normal five-minute retry activated
the snapshot. Acceptance was at 09:12:09 UTC and activation at 09:17:10 UTC on
23 October. No manual queue reset, retry, cursor change or backend correction was
needed. A later synthetic turn used the normal Capture Hook and Transcript
Watcher, then encrypted Personal replication to Alice B. The Git publisher reached
revision 55 under authority and fence version 2. The snapshot retained only
revision 51. The native view displayed both boundaries and the stopped Project.
Carol's read and exact-grant recall returned the later turn; disabled Cloud
access for Bob and nonmember Frank returned 403. Team responses contained no
local Folder path or private Project name. Three receiving Personal replicas
remained ready with distinct local identities and preserved original Folder
provenance. PROD-03 is locally complete again.

### Queued LCM exclusion and final original-state restore

The existing combined Project exclusion case now also prepares and sanitizes a
later LCM revision while leaving publication queued. The reviewed Workspace
exclusion is applied before publication. The normal ready-publication reconciler
creates no publication for that revision; reads, recall and cached evidence
expansion remain denied. Overlapping Git Anchor and Folder reasons obey the same
veto. Removing Project membership while excluded prevents restoration from
readmitting it; independent eligible reasons recover only after reviewed
restoration. The single isolated PostgreSQL case passes in 31.94 seconds.

The first attempt exceeded the default 15-second test limit. A second attempt
exceeded the default ten-second migration hook during concurrent local checks.
Neither established a product failure. The final serial run used bounded
60-second setup and 90-second execution limits and passed. Targeted lint,
changed-test typechecking and formatting pass. No new production path or harness
framework was added, and this test-only change requires no artifact refresh.

All native profiles and the original Team service were stopped normally for the
final checkpoint. The encrypted same-build archive verifies, rejects the wrong
archive key and restores into the isolated smoke database. All 262 source tables
match exactly after excluding only the backup tool's documented synthetic target
sentinel. The actual restored Team service then passes:

- Exact owner-state comparison for Alice's ten and Bob's three contributions,
  including reason/consent identities, stopped and active rules, fixed approval
  revision, detail, source revocation and transferred publisher authority.
- Carol's authorized read and exact-grant recall of Alice's later turn, with Bob's
  disabled Cloud access and Frank's nonmember access denied.
- Bob's native Conversation and independent Timeline semantic access, with the
  Timeline source still revoked and Frank denied.
- Independent fixed source snapshot bounds, sanitized-source digest and canary
  checks, existing revoked-source denial and nonmember denial.

The restored check service is temporary. Resume the original database and service
following the check. The final identities remain the renderer, runtime, images
and schema recorded in the preceding packaged snapshot checkpoint. The local
candidate uses an ad-hoc signature and local Homebrew smoke assets; no portable
release, WorkOS, GPU or remote-staging qualification is inferred.

## PROD-06 final local disposition, 23 October 2026

This checkpoint supersedes earlier open native acceptance tables without changing
the scope of their historical results. The combined journey uses Alice A and B,
Bob, three independent Workspaces and the same matching current-build services.
It completes local production release-candidate acceptance. It does not authorize
release publication or external deployment.

| Criterion                                                     | Final evidence and disposition                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation, Git Anchor, exact Folder and Project rules      | Enrolled native creation, exact selection, later turns, independent destinations and owner controls pass; stopped Project remains stopped.                                                                                                                                  |
| Both creation orders and explicit conversion                  | Native direct-first and rule-first flows pass. Conversion retains the old snapshot until publication, then retires only that reason. A separate new snapshot remains fixed while the existing Git rule advances.                                                            |
| Two owners and two Personal devices                           | Native Bob Conversation shares and Alice A/B encrypted replication pass; distinct receiving identities and original Folder provenance are retained.                                                                                                                         |
| Privacy, revoked, disabled, retained and nonmember boundaries | Full fixture and focused semantic/evidence/expansion checks remain valid; final restored-service read/recall and source-denial checks pass.                                                                                                                                 |
| Exclusions during activation retry and queued LCM work        | Existing bounded activation exclusion case and final queued-LCM Project case deny late publication; cached expansion remains denied.                                                                                                                                        |
| Exclusions during policy processing, recovery and takeover    | Claimed-policy exclusion regression passes. Existing durable recovery checks and actual native exclusion/restoration after committed B takeover pass, with former-publisher writes denied.                                                                                  |
| Policy and detail changes                                     | Native detail reduction/increase passes on the original fixture. Explicitly approved native policy amendments pass in the isolated restored copy; the original all-eight-required policy remains unchanged.                                                                 |
| Packaged operation and restart                                | Core setup, enrollment, model readiness, machine interruption, shutdown and restart pass; secure storage remains enabled.                                                                                                                                                   |
| Same-build backup and restore                                 | Final encrypted 262-table comparison and actual restored-service authority and identity checks pass.                                                                                                                                                                        |
| Integrated checks                                             | Applicable full fixture, semantic recall, Personal, current-schema, format, lint, production typecheck and build results are retained. Subsequent changed files pass scoped checks; full test-source typechecking exceeded the 2 GB cap and remains explicitly unavailable. |
| Operator and candidate handoff                                | Supported build/run/backup steps and exact artifact identities are recorded. Unavailable deployment qualifications remain separate release prerequisites in the candidate status record.                                                                                    |

The [candidate status record](team-continuous-sharing-release-candidate.md) is the
operator handoff. The User's decision to omit a changeset remains in effect.
No push, PR, merge, remote deployment or release publication was performed.

## Manual-test sharing-review freshness correction, 23 October 2026

The User's clean Team and ordinary Personal profile exposed a review starvation
bug during background capture/import. The preview and approval handoff checked
all owner journal changes, so an unrelated Conversation could invalidate a Git
Anchor or Project review. Read-only reproduction returned the generic conflict
without creating or approving a Share Grant.

The local sharing-preview adapter now uses a bounded selection-state version.
It covers selected identities, context, portable bindings, Project version and
inclusion reasons. Unrelated capture and unrelated Project changes leave that
version intact. Later turns within the selection are also allowed by explicit
continuous consent. Selected membership additions/removals, context/identity and
Project changes still invalidate it. Current metadata is read through the
repeatable-read owner boundary rather than an allocated journal watermark.
The existing owner/expiry/target and destination-policy checks are unchanged.
At this first correction, publisher reconciliation and removal proofs kept their
original global visibility fence. The subsequent catch-up correction below replaces
that publisher fence. Fixed-snapshot review and publication checks are unchanged.
No schema migration, approval bypass or publication authority was added.

Both Git Anchor and Project cases first reproduced the erroneous conflict. The
initial correction removed unrelated-change starvation, but live Git verification
still encountered hundreds of selected-source journal changes from active capture.
The completed correction therefore separates continuous source-content updates
from changes to the approved selection scope. New regression cases cover later
selected turns, unrelated capture, selected context changes, member addition and
deletion, owner isolation, delayed content commits and paginated review. Existing
generic consumer cases retain their original visibility and late-commit behavior.
Eleven existing review-security cases pass. An intermediate test used a nonexistent
title column for its synthetic edit; it was corrected to a normal Session update.

The final nine-case isolated PostgreSQL suite passes in 10.11 seconds. Scoped
lint, changed-test typechecking, formatting and whitespace checks pass. The normal
serial source-runtime build and integrity preparation pass across ten packages.
The local runtime was restored with its original bundled-local profile and ports,
Team collaboration enabled and the local queue. No data reset, credential change
or re-enrollment was needed.

Live read-only verification on that runtime passes for the Project's four sources
and Git Anchor's eight sources: both previews complete and both creation-review
handoffs return success. No native approval, rule creation or publication was
performed by this diagnostic. Background capture may continue during continuous
review; a change to its selected scope or current destination still requires a
new review. Reviews left open across the runtime update must be refreshed.

Earlier candidate package identities refer to the accepted build preceding this
correction. Reassemble and verify packaged artifacts before distributing it.
The Team backend and its manual-test data were not replaced for this fix.

## Manual-test Shares visibility and catch-up correction, 23 October 2026

The User created an active Project rule against the clean manual-test Team, but
Personal → Shares was empty. The owner panel listed accepted rule authority;
Shares queried only per-Conversation Pending Shares and Share Grants. At the
same time, local catch-up repeatedly abandoned its initial baseline during live
capture: the rule had no Team members and no installed local generation after
73 leases. No publication was inferred from successful rule creation.

Shares now also reads the authenticated owner's paginated selection-rule list,
including rules with zero members. The same selector-filtered endpoint remains
available for Project, Git Anchor and Folder panels. No User ID is accepted as
the listing authority. Existing reviewed pause, retry, stop, detail and Privacy
policy controls are reused. The list is reset when the backend or principal
changes. Individual Conversation shares remain separately visible.

Publisher enumeration now compares current owner-scoped membership, source
context, portable identities and Project reasons instead of rejecting every
captured content change. Its digest is computed in PostgreSQL without imposing
the review's source-count limit on future membership. Content changes remain in
the ordinary transaction-visible change journal and trigger subsequent scans.
Complete-baseline installation checks the selected scope and re-evaluates every
staged conclusive removal in the same repeatable-read transaction. Missing,
unavailable or changed evidence rejects the proposal and preserves the prior
complete generation. Publication, consent, destination policy and owner/device
checks remain mandatory. No schema change, data reset or new sharing approval
was used for this correction.

Focused verification passes: four isolated recovery/takeover cases, including
capture between every catch-up phase, later content wake-up and rejection of a
removal whose evidence becomes unavailable before installation; one isolated
owner-list case covering zero-member rules, mixed selectors, pagination and
cross-owner denial; 88 local-edge/review-security cases; and 19 focused screen
cases including a rule with no Conversation shares. The wider 96-case screen
run initially had two one-second asynchronous setup failures. The setup check
passes on focused rerun; the Project load check passes with a bounded five-second
wait. A large three-scenario publication run exceeded its harness deadline and
is not counted as passing. Its disposable database was removed; the focused
owner-list case replaces that run for this correction. Scoped lint passes.

The ten-package source-runtime build and integrity preparation pass. The Desktop
production typecheck, Electron/preload build and renderer build pass under the
2 GB Node heap cap. The existing primary rule then installs a complete baseline
for all four selected Conversations through normal catch-up, and all four reach
Team admission. After restoration, all four Pending Shares fail closed with
`candidate_manifest_changed`. This separate publication issue remains in TODO.md;
no candidate validation was weakened or failed share manually marked complete.

The corrected manual Team image is
`sha256:239268ab308e29d2232d3ea2cd853d6f91586618eca6b5f6dcb8e2b7afaa8cb7`.
Only its service container was replaced; database, queue, encryption and device
volumes were retained. The rebuilt primary development app and native runtime
were reopened. Live authenticated reads return the active Project rule in the
owner-wide rule list and all four failed Conversation shares. Source metadata
checks confirm their accepted identifiers are still actively mapped and their
revision hashes match the production formula; source identifier ordering also
matches. These observations do not prove that the canonical authoritative source
manifest can be reproduced. The source-consistency failure remains open and
must not be bypassed or described as a successful publication.

### Publication failure diagnosis, 23 October 2026

Read-only comparison of the accepted candidates with their decrypted retained
source-artifact manifests identifies the missing canonical Memory Events:

| Source revision | Accepted events | Canonical events | Missing accepted events |
| --------------- | --------------- | ---------------- | ----------------------- |
| 119             | 6               | 4                | 2                       |
| 63              | 14              | 8                | 6                       |
| 113             | 6               | 4                | 2                       |
| 179             | 23              | 16               | 7                       |

The accepted candidate hashes are intact, every canonical event maps through its
active sync relationship, and no additional canonical events appear. Excluded
sources are Pi tool calls/results. All 18 inspected tool source records retain
the original name and call ID in encrypted raw source, while none retain a tool
name in normalized Conversation Item metadata. The Pi parser constructs display
text from tool names but omits tool provenance from its metadata. Projection
therefore cannot carry those names into the semantic item manifest. The local
candidate preview accepts those events and substitutes the generic name "tool";
authoritative preparation rejects them as unsupported protocol items because a
verified tool name is required. The final manifest comparison correctly fails
closed.

This diagnosis used existing owner-private encryption providers inside the local
Team container and emitted counts, source record types, metadata keys and
presence/integrity flags only. No source text, tool arguments, secrets or keys
were printed. No publication was retried or manually altered. The implementation
follow-up is in TODO.md: preserve verified Pi provenance, align preview eligibility
and retain strict final validation. No runtime or configuration change was needed
for this investigation, and no tests or rebuilds were run.

### Pi tool provenance and preview correction, 23 October 2026

Pi capture now preserves native tool names and call IDs. Current captured records
that lack normalized identity recover it at read time from retained native Pi
source. Local preview recovery is restricted to current eligible Personal sources
owned by the caller. Authoritative preparation verifies the original canonical
contributor and Memory Event hashes before deriving identity. Conflicting native
and normalized identities fail closed. Unknown tool identities are excluded from
the local preview rather than assigned a generic name.

Pi tool publication includes only the selected call arguments or semantic result
text. Call arguments remain structured, preserving schema and prohibited-key
checks. Native record wrappers can contain sibling text and hidden reasoning;
they are rejected from fresh or cached tool artifacts. The service was paused
before any of the four operations made content available while this additional
boundary was completed. Retained source bytes and sync revision hashes were not
rewritten. Consent, publisher/device, owner, destination, Privacy and final exact
candidate-manifest checks remain required.

Focused verification passes: 12 shared provenance/semantic cases, five parser
cases, 91 local-edge sharing and preview cases, four isolated authoritative-source
cases, the exact candidate-mismatch rejection case, and an encrypted owner-boundary
case. The latter proves owner decryption, cross-owner denial, source-exclusion
denial and unchanged captured storage. Source cases cover retained sibling
reasoning, structured instruction-key rejection, canonical-hash tampering and
unknown tool exclusion. Scoped lint, formatting and the ten-package production
source-runtime build pass. The Team image also builds successfully under the
2 GB Node heap cap.

The final manual Team image is
`sha256:e674c00db537dc9a8e4db58eb14da11e8862227dd4f561d55a3d393eb0b6f752`.
Only the service container was replaced. Database, queue, encryption, device and
model-cache volumes were retained. Local source-runtime integrity preparation is
`916ce76b7ddb27880a32cb880e66088602b9e03cb5f3e12194a818c6b2775041`;
the image's Linux/Node 22 runtime fingerprint is
`b1fdcf429b7053dcaabb77510fae12c66e2815eef78ddb5f88c11dab6448ddff`.
Platform and Node-version inputs explain the distinct runtime fingerprints.
The existing Desktop process remains open with secure credential storage enabled.
No Keychain approval, new share approval, enrollment replacement or database reset
was used for this correction.

Authenticated local previews retain all 49 originally accepted events and all 18
Pi tool names/call IDs. Read-only comparison of the final authoritative artifacts
reproduces each original accepted manifest exactly: 23 events at revision 179,
14 at revision 63, six at revision 113 and six at revision 119. The final artifacts
contain selected `arguments` or `text` tool payloads and no native wrappers. The
original 49 active canonical mappings and their revision hashes remain unchanged.
The four original Pending Shares were retried through authenticated owner controls
with their original source revisions, consent, destination and detail.

The local CPU classifier exceeded the default 30-second request deadline while
processing real captured content. The manual Team worker therefore uses the
supported `PRIVACY_SERVICE_TIMEOUT_MS=120000` override. Timed-out in-flight
classifier work was restarted normally. The classifier model, required Privacy
categories, byte/field limits and result-validation checks are unchanged;
this setting extends the processing deadline and grants no content access.

All four original operations subsequently reach `activated` / `complete` with
an available Memory Event representation and a durable reason-publication ledger.
Their original operation IDs, candidate preview IDs/hashes, consent IDs, source
revisions, destinations and detail remain unchanged. The original 49 canonical
mapping hashes also match exactly. Eight unpublished private processing previews
from the intermediate native-wrapper build were invalidated through the existing
owner-scoped repository method. No captured source, consent or completed
publication was changed by that cleanup.

The final owner-detail check also exposed a cumulative-preview selection race:
a later LCM publication could replace the Memory Events reference even though
the consent's activation detail remained Memory Events. The local immutable
preview cache correctly rejected that mismatch. Owner selection now requires
both the published representation and source preview to match the consent's
activation representation. The additional isolated regression publishes an LCM
layer after Memory Events, retains the Memory Events owner preview, and continues
to deny a different owner. Cache identity, content and permission checks remain
strict.

Final authenticated local reads pass for all four activated Pending Shares and
their active Share Grants. Every owner preview returns Memory Events at the
original approved revision, with eight, two, six and two verified Pi tool items
for revisions 179, 113, 63 and 119 respectively. Both runtimes are restored healthy
and the existing Desktop process remains open. No new approval or Keychain prompt
was needed. The additional cumulative-preview regression brings focused
verification to 115 passing cases. Packaged release-artifact reassembly and the
previously documented external release qualifications remain separate.

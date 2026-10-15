# Repo-Targeted Recall Implementation Tickets

Approved implementation queue. Each ticket is ready for an agent once its listed blockers are complete.

This single-file format follows the User's request. The source is the approved Repo-Targeted Recall plan and its review decisions. No external tracker is used.

Baseline: `248fecaa` (14 October 2026). Use the existing submit-and-collect
Memory Answer tools and semantic retrieval without a dedicated reranker.
Ticket numbers, blockers, and milestone order remain unchanged.

## Manual product milestones

Prioritize these short previews so the User can try the product before the full
cutover. Each preview takes roughly 3–5 minutes once the implementation agent
prepares the build and sample data. These are optional feedback opportunities.
They do not add tickets, formal acceptance gates, or another test suite.

The agent supplies a runnable preview, the exact place to open or command to
run, a sample question, and the expected result. Use an isolated demo profile
with sample memory. Rehearse the flow first so the User spends their time trying
the behavior. A missing second device or Team account does not block unrelated
work. Record brief feedback and make small adjustments in the relevant ticket.

### M1: Remember something and recall it from another checkout

Complete tickets in this order: **01 → 02 → 03 → 08 → 09**.

Try it: capture one distinctive project decision in a Codex Conversation. Ask
for that decision from a subdirectory or another worktree, then open the Project
in Desktop.

Expected result: the answer recalls the decision with its source, and Desktop
groups the sessions under the same Project while retaining their checkout paths.
The agent demonstrates one non-blocking submission and explicit result collection,
requesting citations at submission. The User can inspect Desktop while recall
runs; the agent retains the task ID and collects with `wait=true` when needed.
No polling commands or completion notifications need to be managed by the User.
**Preview status:** Implemented and rehearsed on the integration branch. The sample Cobalt decision uses the copper checklist with exactly seven checks to catch the amber-cache regression. Recall from the second worktree returned that decision with its source; Desktop showed both sessions together and retained both checkout paths.

This is the first complete capture → recall → inspection loop. Claude Code, Pi,
managed Conversations, historical imports, and sync are not needed for this preview.

### M2: Change an assignment and judge the answers

Next, complete **10 → 17**. Preview ticket 17 on a dependent branch while
keeping its release after ticket 16.

Try it: move one sample session to another Project and repeat its recall
question. Open a prepared anchor-change preview to see the affected sessions.
Then ask one Global question with sample decisions from two repositories.

Expected result: the move changes which Project can recall the session. The
review clearly shows what a bulk action would change. The Global answer favors
similarly relevant current-repository evidence and identifies other Projects.
The User can dismiss the bulk preview without applying it.
Use the current semantic retrieval setup; no additional ranking model is needed.

### M3: Use the same memory on another device

Next, complete **11 → 12 → 13**.

Try it: ask the M1 question from a clone on a second paired device. Inspect the
selected anchor in Desktop. If useful, accept the prepared Project association
and observe one shared anchor-selection update.

Expected result: the same repository memory is available despite different
paths. Shared configuration applies only to the accepted association. The
implementation agent covers offline replay and conflict cases in ticket tests.

### M4: Experience the Team flow

Next, complete **14 → 15 → 18**. Preview ticket 18 with the dependent Global
branch while retaining its release after ticket 16.

Try it: use the prepared Team fixture to share one sample session and ask about
it from the teammate's clone. Move the personal session, then use the explicit
share-update action and repeat the question.

Expected result: the teammate recalls the shared repository evidence. A personal
move leaves the existing Team snapshot alone until the explicit share update.
The Global answer labels repository context consistently with M2.

### Complete the remaining coverage and release

Finish **04 → 05 → 06 → 07 → 16**, then release the already-previewed Global
work in **17 → 18**. Tickets 04–07 can proceed earlier whenever their blockers
are complete, as long as they do not delay the first useful preview.

Ticket 16 retains the complete integration checks and single Project cutover.
The User does not need to rerun the automated matrix as a manual milestone.

## Execution rules

- Work on a ticket only after its listed blockers are complete. M1 is complete and ready for optional User inspection. M2, M3, and M4 are complete and assessed. Ticket 18 is checkpointed as f696f8cb on codex/repo-global-recall; its release remains after ticket 16. Continue 04–07 and 16 on the Project integration branch. Follow the milestone order above for priority rather than numeric ticket order.
- Ticket 01 is a behavior-preserving prefactor and can merge independently. Develop tickets 02–15 on one integration branch with incremental commits and focused verification.
- Ticket 16 is the integration and release gate. Intermediate tickets must be demoable on that branch, but main must receive the complete Project behavior in one cutover.
- Tickets 17 and 18 can start when their implementation blockers are complete. Release them only after ticket 16. This release constraint is separate from their blocking edges.
- Build early Global previews on a dependent branch and keep those commits separate from the Project cutover. Manual previews do not require merging incomplete behavior to main or adding feature flags.
- Every behavior ticket includes the persistence, API, caller or UI, tests, and documentation needed to demonstrate its stated outcome. Do not create layer-only follow-up tickets for missing work.
- Preserve the alpha decisions: no backward compatibility, feature flag, mixed-version support, database reset, or automatic historical backfill. Existing logical sessions remain unresolved until explicit User reassignment.
- Preserve Workspace authorization and Share Grant boundaries throughout. Identity and Project association never grant access or choose a Workspace. Synthesis remains in the AI Client.
- Reuse the existing durable task runtime, collection/cancellation tools, and evidence-selection repairs. Preserve the Supported Capture Hook; recall delivery does not use Stop-hook feedback.
- The optional historical repair command stays deferred. It is not part of this implementation queue.
- All tickets are approved and labeled ready-for-agent. A ticket with blockers still waits for their completion.

## Verification scope

- Acceptance criteria define outcomes, not a separate new test for every checkbox. Reuse shared fixtures and existing suites for identity, assignment, tasks, authorization, and evidence selection.
- Test shared rules once, then use focused integration checks to prove each capture producer and retrieval path carries and enforces them. Do not repeat the entire identity matrix through every client or UI.
- Keep the small ranking cases in the existing evaluation harness. No new benchmark framework, broad model/host matrix, or expanded runtime budgets are required.
- Ticket 16 runs the relevant shared suites and representative integrated flows, with focused new checks for gaps. Preserve coverage for unresolved history, stale writes, sync conflicts, and unauthorized access.
- The 3–5 minute manual milestones stay optional. Unrelated async and evidence follow-ups already tracked in the backlog are outside these tickets.

## 01: Share Git discovery without changing behavior

**What to build:** Project discovery uses one shared Git probe and persisted device salt, giving later work a single tested integration point.

**Blocked by:** None (can start immediately).

**Status:** complete

- [x] Existing Project discovery and inspection return the same roots, remotes, aliases, branches, and local identities after extraction.
- [x] Inject local configuration, filesystem and Git dependencies, and the persisted device salt instead of creating producer-specific state.
- [x] Bound Git execution and cache results by local profile and checkout with a short TTL and configuration invalidation.
- [x] Distinguish non-Git directories from probe failures and ambiguous results.
- [x] Cover real fixture repositories, worktrees, repeated discovery, and failed Git execution with focused tests.
- [x] Update architecture documentation for the shared discovery boundary. This behavior-preserving refactor can merge independently.

**Validation:** Shared probe and metadata suites: 10 tests passed. Server typecheck, targeted ESLint, and formatting passed. The initial sandboxed wider suite hit socket/process restrictions; the subsequent Server suite with those permissions passed all 712 tests across 51 files.

## 02: Select and inspect one repository anchor

**What to build:** A User can inspect and edit a checkout's selected repository anchor and see a stable identity or an explicit unresolved result.

**Blocked by:** 01: Share Git discovery without changing behavior.

**Status:** complete

- [x] Implement local explicit selection, associated replicated selection, portable upstream, portable origin, and device-local fallback in that order. Provide the typed input for replicated selections without inventing associations.
- [x] Normalize equivalent SSH and HTTPS addresses to one anchor. Remote names, extra remotes, and historical aliases never contribute additional matching values.
- [x] Return portable repository, device-local repository, non-Git Project, or unresolved identity with the root, branch observation, resolution reason, and provenance.
- [x] Expose anchor inspection and local editing through Project discovery and Desktop. Invalid explicit selections and conflicting URLs remain unresolved without fallback.
- [x] Use stable checkout identifiers with originating-device provenance. A path reused for another checkout must not inherit its identity or review history.
- [x] Test custom remote names, forks with and without the same anchor, duplicate URLs, non-Git Projects, and the A/B/C extra-remote counterexample.
- [x] Record the identity contract in an ADR and explicitly supersede conflicting alias-matching decisions while retaining Personal Device Sync privacy and Workspace authorization boundaries.

**Validation:** Identity, shared Git, metadata, platform, Project grouping, and IPC suites: 66 tests passed. Desktop detail/contract suites: 60 tests passed. Anchor panel and focused manager tests: 4 passed. Full formatting and lint, Server build, Desktop typecheck, and ADR numbering passed. ADR 0057 records the selected-anchor contract.

## 03: Capture and inspect repository assignments for Codex sessions

**What to build:** New Codex Captured Sessions receive inspectable repository assignments, while existing sessions retain a deliberate unresolved state through later capture.

**Blocked by:** 02: Select and inspect one repository anchor.

**Status:** complete

- [x] Carry identity from the Codex Transcript Watcher and Supported Capture Hook through capture to owner session inspection.
- [x] Persist automatic and override identities, assignment versions, originating checkout/device provenance, and separate branch observations. Retain the original cwd and resolved Git root.
- [x] Use one effective assignment rule: a User override wins, otherwise the recorded automatic assignment applies. Resetting an override restores that recorded state.
- [x] Prepare and exercise the cutover transition that marks every existing logical session unresolved until explicitly reassigned. Activate it only in ticket 16.
- [x] Both capture upsert paths preserve assigned and historical-unresolved states during duplicate, delayed, conflicting, and continued capture.
- [x] Record conflicting observations for later review instead of unioning identities or silently replacing assignments. Re-ingestion must not create a new lineage to evade the unresolved state.
- [x] Demonstrate new capture and a continued pre-cutover Conversation through owner inspection. Add focused persistence and integration tests, indexes, and capture documentation.

**Validation:** Codex watcher and Supported Capture Hook: 67 tests passed. Real PostgreSQL assignment, existing capture/Project, and API artifact replay: 10 tests passed (sequential files, isolated UTF-8 database). API/contract suites: 145 passed, 2 skipped. DB/API/MCP typechecks, focused lint, and Drizzle migration consistency passed. The cutover was exercised inside a rollback and is not invoked automatically.

## 04: Capture Claude Code sessions with the same assignment rules

**What to build:** Claude Code Conversations produce the same repository assignments and historical-session behavior as Codex.

**Blocked by:** 03: Capture and inspect repository assignments for Codex sessions.

**Status:** complete

- [x] Pass the shared resolver result through Claude Code transcript capture, the Transcript Watcher, and relevant Supported Capture Hook paths to session inspection.
- [x] Use the shared effective-assignment and conflict behavior rather than implementing a separate identity policy.
- [x] Demonstrate capture from a repository root and subdirectory, and from two worktrees with the same selected anchor.
- [x] Duplicate and reordered capture cannot replace an assignment, User override, or historical-unresolved state.
- [x] Test a continued pre-cutover Conversation and unavailable Git metadata.
- [x] Update Claude Code integration and ingestion documentation for the new behavior.

**Validation:** Claude watcher tests exercise real Git roots, subdirectories, and two worktrees with the same selected remote, plus unavailable metadata producing an explicit unresolved observation. The primary watcher and Supported Capture Hook regression run passes 29 tests. The shared PostgreSQL assignment suite now runs for Codex, Claude Code, and Pi and passes nine cases covering continued capture, conflicting and duplicate observations, User overrides, historical-unresolved state, reset, and owner boundaries. Production typechecking, full test typechecking, and targeted formatting/lint validate the change. Claude integration and ingestion documentation describe the shared boundary and source-time import limitations.

## 05: Capture Pi sessions with the same assignment rules

**What to build:** Pi Conversations carry repository context through capture and owner inspection without changing recorded assignments on later turns.

**Blocked by:** 03: Capture and inspect repository assignments for Codex sessions.

**Status:** complete

- [x] Integrate the shared identity contract into Pi transcript watching and applicable capture signals.
- [x] Demonstrate root, subdirectory, worktree, and non-Git capture through the shared capture boundary.
- [x] Preserve recorded identity and User overrides across duplicate, delayed, and conflicting observations.
- [x] Continuing an existing unresolved Pi session cannot resolve its old or new turns automatically.
- [x] Test unavailable Git metadata and preserve logical-session identity across re-ingestion.
- [x] Update the relevant Pi integration and ingestion documentation.

**Validation:** Pi capture tests use real repository roots, subdirectories, two worktrees, non-Git Projects, and unavailable metadata. They exercise capture policy pause/resume, durable cursor replay, rewrite generations, restart, and truncation without changing logical-session identity. The primary Pi, Claude, and Capture Hook suites pass 37 cases; the three-provider PostgreSQL assignment contract passes nine cases for recorded assignments, overrides, historical-unresolved state, conflicts, and authorization. Production and full test typechecking, targeted lint, and formatting pass. Normal test discovery now excludes ignored dependency snapshots and scratch preview checkouts. Pi integration and ingestion documentation describe the effective assignment boundary.

## 06: Capture repository assignments for managed Conversations

**What to build:** Desktop-managed Conversations retain the identity of their actual Project across start, capture, and owner inspection.

**Blocked by:** 03: Capture and inspect repository assignments for Codex sessions.

**Status:** complete

- [x] Pass the managed Conversation's Project and checkout context through each supported managed runtime to the shared capture contract.
- [x] Resolve the Conversation's target Project rather than the supervisor's or API process's cwd.
- [x] Retain non-Git and standalone Conversation Project behavior without assigning an unrelated repository.
- [x] Demonstrate a new managed Conversation, a worktree Conversation, and a continued unresolved Conversation.
- [x] Duplicate observations and runtime restarts preserve the same assignment and logical session.
- [x] Update managed Conversation integration documentation and add focused runtime-to-capture integration coverage using the shared assignment fixtures.

**Validation:** Managed Codex runtime-to-capture tests verify initial registration from a root, subdirectory, worktree, and standalone target before transcript ingestion. All 44 managed Codex cases pass, including restart, replay, child identity, and graceful close. The shared capture and managed Worker regression suites pass 70 cases. Nine native integration cases resolve real target checkouts and exercise the database capture boundary for managed Codex, Claude Code, and Pi, preserving navigation Project, assignment, override, logical Session, and historical-unresolved state across replay. Production builds, full test typechecking, targeted lint, and formatting pass. Managed runtime and ingestion documentation explain registration ordering and the bound-checkout context. The close fixture now gates its idle notification on capture readiness so startup duration cannot invalidate the scenario.

## 07: Preserve assignments during historical imports

**What to build:** Historical imports retain source provenance and cannot silently assign existing memory using today's checkout.

**Blocked by:** 03: Capture and inspect repository assignments for Codex sessions.

**Status:** complete

- [x] Apply the shared assignment contract to Codex, Claude Code, and Pi historical import producers.
- [x] Use trustworthy source-time metadata for eligible newly imported sessions. Current directory contents alone cannot establish historical identity.
- [x] Re-imports of an existing logical session preserve its unresolved state, assignment, or User override.
- [x] Missing paths, reused paths, ambiguous provenance, and same-path records from another device remain unresolved.
- [x] Demonstrate source-time assignment where supported and preservation of a continued or re-imported pre-cutover session.
- [x] Keep automatic backfill out of startup and upgrade flows. Document the limitations and add import regression tests.

**Validation:** All 105 historical producer, source-context, and watcher cases pass. Codex historical candidates and selected journals submit source-time context only after checking eligibility, while path-only, missing, reused, nonportable, and conflicting observations remain unresolved. Claude and Pi submit explicit unresolved observations. Three native integration cases exercise eligibility through database capture for Codex, Claude, and Pi, preserving assignment, logical Session, User override, and pre-cutover unresolved state during re-import. Production and full test typechecking, targeted lint, and formatting pass. Provider, ingestion, and retrieval documentation describe source-time requirements and the absence of startup repair.

## 08: Recall Personal Memory by effective Project identity

**What to build:** Memory Answer targets the requested repository across every Personal retrieval path while preserving explicit Project and Session requests.

**Blocked by:** 03: Capture and inspect repository assignments for Codex sessions.

**Status:** complete

- [x] Resolve and persist the target root, identity, branch observation, and resolution status before durable task acceptance. Carry that context through workers, API schemas, remote clients, search, source expansion, and graph browsing; retries reuse it.
- [x] Apply the same effective-assignment filter to raw evidence, Memory Nodes, Curated Memory, and replicated artifact retrieval.
- [x] Default Project scope resolves the caller's root. An explicit Project Y requested from repository X resolves Y only; unresolved targets report a resolution error without substituting X or Global scope.
- [x] Match selected identities by equality. Device-local and non-Git identities remain bound to their originating device.
- [x] Exclude unresolved sessions and honor overrides. Preserve Session scope, ownership, source eligibility, and all time bounds.
- [x] Use the same scope rules for blocking and non-blocking recall. Extend existing task tests to show that cwd, anchor, or branch changes and worker restart cannot retarget a pending task, and repeated authorized collection returns its stored result without another recall. Keep collection User-owned rather than cwd-bound.
- [x] Preserve complete observed source references, chunk identities, visibility, lineage, and evidence budgets when adding repository metadata. Keep current assignment and access checks; pinning request context does not snapshot Personal Memory.
- [x] Demonstrate repo X roots, worktrees, clones, and forks with a shared anchor matching while repo Y stays excluded, including search followed by expansion.
- [x] Audit every project predicate and document the retrieval surface and persisted task context. Reuse shared API/database fixtures to cover each distinct filter boundary without repeating the full scenario matrix.

**Validation:** Semantic/graph/Curated Memory and durable task PostgreSQL checks: 15 tests passed on the isolated UTF-8 database. Worker, adapter, context, coordinator, and delivery suites: 138 tests passed with native process access. DB/MCP/API and test typechecks, migration consistency, and full formatting passed. Focused lint passed; the final full lint found one unused test import, corrected by asserting the stored remote context. The surface audit is in `docs/repository-recall.md`.

## 09: Group Desktop Projects and reassign individual sessions

**What to build:** Desktop shows the same Project groups as recall, and a User can move or reset a session with immediate, predictable results.

**Blocked by:** 08: Recall Personal Memory by effective Project identity.

**Status:** complete

- [x] Group by effective identity while retaining checkout paths for navigation and source provenance.
- [x] Keep unresolved history visible and inspectable without placing it in an inferred repository group.
- [x] Persist a single-session reassignment as a User override and increment its assignment version.
- [x] An override without a portable identity suppresses the original portable identity. Resetting an override restores the recorded automatic state, including historical unresolved state.
- [x] Demonstrate that grouping, recall, and source inspection agree before reassignment, after reassignment, and after reset.
- [x] Cover concurrent assignment updates and ownership boundaries. Update Desktop and Project assignment documentation.

**Validation:** Real PostgreSQL assignment/recall and API ownership/CAS tests pass. Desktop contract, manager, grouping, detail, and checkout-anchor tests pass. Workspace build, test typecheck, lint, formatting, and migration checks pass. M1 was rehearsed with native Codex capture from a nested checkout, a non-blocking Project Memory Answer with citations from a second worktree, explicit result collection with `wait=true`, and actual Desktop grouping/source inspection. The isolated preview reports healthy.

## 10: Review anchor changes and apply bounded bulk reassignment

**What to build:** A User can review anchor changes or capture conflicts and reassign exactly the sessions they accepted.

**Blocked by:** 09: Group Desktop Projects and reassign individual sessions.

**Status:** complete

- [x] Persist anchor-change and capture-conflict events with owner, originating device, stable checkout identifier, previous and target identities, and event revision.
- [x] Display a fixed session set with assignment versions and an exact count. By default include only that checkout's sessions with the previous automatic identity and no manual override.
- [x] Exclude unresolved history and manual overrides unless the User explicitly includes them. Show every override that will be replaced.
- [x] Recheck ownership, checkout, event revision, and every assignment version at execution. Reject the whole action if the review is stale.
- [x] Apply the accepted set atomically as User overrides and record completion so replay cannot apply it again. Never expand the reviewed set with later sessions.
- [x] Supersede stale A-to-B events after a B-to-C change. Dismissal changes no assignments, and a reused or same-path checkout cannot be included accidentally.
- [x] Test stale reviews, concurrent edits, explicitly included unresolved sessions, replay, and Desktop/recall agreement. Team snapshots remain unchanged.
- [x] Document the review, reassignment, and dismissal behavior.

**Validation:** PostgreSQL fixed-set, stale/concurrent-edit, ownership, provenance, explicit-history, capture-conflict, supersession, and replay checks pass. The API and Desktop regression run passed 285 tests. The deterministic Team fixture verified unchanged encrypted snapshots and authorization after apply/reset. Native Desktop exercised a one-session bulk apply, source inspection, automatic reset, and dismissal; semantic recall followed apply/reset. Moving the copper sample to Indigo made Cobalt recall omit it and Indigo recall cite its original source. Build, test typecheck, lint, formatting, and migration checks passed.

## 11: Preserve repository assignments across Personal Device Sync

**What to build:** An authorized second Personal device recalls a synced session in the same repository context without exposing repository identity to the relay.

**Blocked by:** 08: Recall Personal Memory by effective Project identity.

**Status:** complete

- [x] Derive the selected anchor's group-keyed token and carry assignment provenance through authenticated encrypted session and checkpoint transport.
- [x] Match in the verified group and key epoch while preserving separate local checkout identities.
- [x] Preserve effective assignments and historical-unresolved state across import, later checkpoints, replay, and continued source capture.
- [x] Keep device-local identities bound to the originating device and prevent same-path matches on another device.
- [x] Version affected wire semantics and update producers, consumers, and fixtures together without rewriting signed historical packages or adding legacy readers.
- [x] Demonstrate two-device capture, sync, Project recall, and owner inspection, including a session that remains unresolved after a later checkpoint.
- [x] Test authorization, key-epoch handling, duplicate delivery, and relay-visible privacy. Update the Personal Device Sync protocol and operational documentation.

**Assessment:** Verified with signed encrypted package fixtures, API/Worker
contract tests, and PostgreSQL publication/receiver tests representing separate
source and receiving devices. Portable recall matches despite different checkout
paths; historical and device-local cases remain excluded, and local overrides
survive later source checkpoints. Epoch refresh retains private verification keys
and origin certificates. This is an automated assessment, not a physical
two-machine rehearsal. Ticket 16 still owns the coordinated transition for
already-published checkpoint chains and offline baselines before release.

## 12: Associate Projects and sync anchor selection updates

**What to build:** A User links local Projects and shares anchor selection changes or deletions with those associated checkouts, including offline devices.

**Blocked by:** 02: Select and inspect one repository anchor.

**Status:** complete

- [x] Create stable Project association identifiers scoped to the User and Personal Device Group. Require local acceptance before an unassociated checkout uses a shared selection.
- [x] Provide Desktop association and selection controls. Ordinary clone recall can still match independently resolved equal anchors without a configuration association.
- [x] Transport separate encrypted, authenticated selection records bound to the association, stable selection identifier, authoring device, unique revision, and replaced revisions.
- [x] Deliver sequential set and delete operations independently of Conversation capture. Retain deletion records so offline delivery cannot restore a superseded selection.
- [x] Apply only the current selection of the associated Project. Require its anchor among current normalized remotes, tolerate duplicate URLs, and preserve local explicit precedence.
- [x] Deletion removes the replicated preference and resumes the normal detection order. Distinguish shared deletion from local anchor override removal; neither reassigns existing sessions.
- [x] Detect concurrent revisions and leave affected resolution unresolved rather than choosing arrival order. Ticket 13 supplies the User resolution flow.
- [x] Test quiet checkouts, offline replacement/deletion, replay, and the unrelated comparison-remote counterexample. Document association and selection lifecycle behavior.

## 13: Resolve concurrent synced anchor selections

**What to build:** Users can inspect and resolve conflicting anchor changes without losing edits or reviving deleted selections.

**Blocked by:** 12: Associate Projects and sync anchor selection updates.

**Status:** complete

- [x] Show concurrent set/set and set/delete revisions for the same selection record in Desktop.
- [x] Keep an affected checkout unresolved while conflict remains, unless a local explicit selection takes precedence.
- [x] Let a User select an anchor or deletion through an operation that replaces all reviewed current conflict revisions.
- [x] Recheck the reviewed conflict state before resolution. A newly arrived competing revision must not be silently discarded.
- [x] Replicate the resolution so online and formerly offline devices converge without relying on wall clock or arrival order.
- [x] Re-creating a deleted selection requires an explicit revision replacing the deletion. Replays and superseded revisions have no new effect.
- [x] Demonstrate resolution across two devices without session capture or reassignment. Add offline/concurrent tests and user documentation.

**M3 assessment:** Automated checks cover authenticated encrypted delivery between
separate source/receiver certificates, PostgreSQL assignment and configuration
journals, quiet checkout discovery, local acceptance, concurrent set/set and
set/delete states, exact reviewed-head resolution, stale review refresh, replay,
and renewed publication after recipient-epoch changes. Desktop controls pass
component and main-process boundary tests. This assessment does not claim a
physical two-machine rehearsal. The coordinated source-profile release transition
remains part of ticket 16.

## 14: Share and recall Team Memory by Project snapshot

**What to build:** A Team member recalls shared memory from the same repository despite different local checkout paths.

**Blocked by:** 08: Recall Personal Memory by effective Project identity.

**Status:** complete

- [x] Snapshot the effective portable identity and permitted Project label when creating a Share Grant representation.
- [x] Snapshot unresolved classification when no portable identity exists. Never export the original automatic identity through a non-portable override.
- [x] Use the snapshot for Team search, expansion, and graph paths without requiring the sharer's local session row to establish repository identity.
- [x] Resolve caller or explicit-target context to a portable identity before accepting a Project task. Return a Project-resolution error for device-local or unresolved targets without falling back to local path equality or Global scope.
- [x] Keep persisted repository context separate from the selected Workspace/backend, Team Membership, Share Grants, and source access. Collection cannot retarget the task to another Workspace or Personal Memory. Apply authorization and time bounds to every path, and fresh access checks to result collection.
- [x] Use only the selected portable fingerprint for Team matching and document the accepted repository-name guessing exposure.
- [x] Use the Team fixture to demonstrate member A sharing repo X, member B asking from another clone of X, exclusion of repo Y, and denial of private or revoked sources. Extend existing task authorization coverage to deny a completed Project answer when access is revoked before collection.
- [x] Update Team sharing, retrieval, and integration documentation.

**Assessment so far:** The native PostgreSQL Team authority suite passes 15
cases, including a completed Project answer denied before payload decryption
after Share Grant revocation, snapshot changes invalidating frozen authority,
and a receiving device using transferred source context instead of its local
assignment. The isolated UTF-8 Team fixture has also completed normal semantic
indexing: 10 items embedded, zero failures, and no pending items in the next
batch. A disposable copy of that indexed fixture also passed same-fingerprint
matching from two different clone paths, exclusion of another repository, stage
scan and candidate expansion, revoked-source exclusion from search and expansion,
and rejection of a raw local path as a Team Project target. Project labels and
branch names now enter the representation's semantic privacy classification with
immutable fingerprint reconstruction and original-source-revision disclosure.
The focused API and contract suites pass 137 cases, the caller/sync contracts pass
28 cases, and all 85 native Shared Memory repository cases pass. The real share
workflow verifies that a grant initially exposes no raw label or branch, then
publishes only sanitized metadata, and retains its snapshot after source context
changes. Migration checks, DB build, API typecheck, and focused lint/format checks
pass. M4 remains unfinished until ticket 15's explicit update action and ticket
18's dependent Global preview are assessed.

While preparing ticket 15, the raw label storage path was corrected: received
labels and branches now use a Session/source-owner-bound owner-private envelope,
while plaintext routing metadata contains only classification and fingerprint.
Envelope-copy rejection, routing consistency, unresolved cleanup, and real
sanitized label publication pass; all 85 native sharing cases still pass after
the storage change.

## 15: Update Team Project snapshots only through explicit action

**What to build:** Personal reassignment leaves existing Team snapshots unchanged until the owner explicitly updates the shared representation.

**Blocked by:** 09: Group Desktop Projects and reassign individual sessions; 14: Share and recall Team Memory by Project snapshot.

**Status:** complete

- [x] Demonstrate that personal moves, resets, anchor edits, and new captures do not mutate an existing Team Project snapshot.
- [x] New shares use the current effective assignment, while an existing share retains its recorded assignment.
- [x] Provide an authorized explicit share-update action that snapshots the current effective portable identity or unresolved classification.
- [x] Recheck current owner authority, Share Grant state, and relevant assignment/representation revisions before committing the update.
- [x] Never expose the previous automatic repository when the current override has no portable identity.
- [x] Use the Team fixture to test overrides before sharing, after sharing, snapshot updates, revoked grants, private sources, and expansion boundaries.
- [x] Document the difference between Personal reassignment and Team snapshot update.

**Implementation progress:** Backend review and explicit update operations now
pin Team/Workspace identity, grant and source revisions, representation version,
assignment version, and source context. The native share workflow covers stale
reviews, an explicit move, exact and divergent retries, non-owner denial, and
revocation before replay. API tests reject Workspace retargeting before mutation,
deny API Tokens, and preserve optimistic conflicts. Forty focused API/contract
cases pass. Assignment-only delivery now encrypts context updates without moving
the capture cursor, queues work on assignment edits, and schedules a follow-up
when acknowledgement discovers newer context. The focused Worker/wire suites
pass 34 cases, and all 86 native sharing cases pass with the new source outbox
and in-flight acknowledgement regression. Desktop now exposes **Update Project**
for active Captured Session shares. Its device bridge, native approval, Workspace
binding, and snapshot persistence are covered by the Desktop/control suites:
219 cases pass, including review-before-update and stale-approval denial.
The final acceptance assessment also passed new-share/current-context and
continued-capture stability, stale representation review denial, and an explicit
unresolved update with no prior repository metadata. A disposable copy of the
indexed deterministic fixture rehearsed Bob's authorized Electron Workspace
update: the Personal move retained the Team snapshot, explicit update changed it,
raw labels stayed absent, and non-owner/revoked access was denied. The complete
source runtime build passed. M4 still requires the dependent ticket 18 preview.

## 16: Integrate and validate the Project recall cutover

**What to build:** One coordinated alpha release enables the complete Project identity behavior with every existing session explicitly unresolved.

**Blocked by:** 04: Capture Claude Code sessions with the same assignment rules; 05: Capture Pi sessions with the same assignment rules; 06: Capture repository assignments for managed Conversations; 07: Preserve assignments during historical imports; 10: Review anchor changes and apply bounded bulk reassignment; 11: Preserve repository assignments across Personal Device Sync; 13: Resolve concurrent synced anchor selections; 15: Update Team Project snapshots only through explicit action.

**Status:** in-progress

**Integration progress:** Directed Sync V2 is checkpointed with mandatory repository snapshots and hashes. The cumulative PDS V4 profile now has a signed upgrade boundary and database profile epochs. Contract/runtime tests and the pre-0058 migration fixture verify nonzero offline baselines, preservation of signed V3 bytes and raw items, stable Session/replica IDs, ledger continuity, wrong-boundary rejection, and unresolved assignment. The pre-0058 source publisher fixture also verifies one upgrade without new turns, rollback on signing failure, retained ciphertext and mappings, and ordinary resumed capture without assignment resolution. The closed-source V3 signed boundary and genuine pre-cutover closed-source fixture are prepared; migration 0059, automatic publication discovery, and native source republication validation are implemented. The genuine old closed-receiver fixture now verifies retained-boundary checks, reuse of the original Session and raw mappings, exact replay, local override preservation, and reset to unresolved state. Migration 0060 now retires old PDS delivery work only alongside a durable replacement, retaining ciphertext, ACK state, and transport metadata while fencing stale leases and retries. Persisted directed uploads, integrated validation, and the final one-time assignment cutover remain release gates.

- [ ] Integrate all preceding Project behavior tickets and audit every enabled capture, recall, expansion, graph, Desktop, Personal Device Sync, and Team surface.
- [ ] Apply the cutover transition once to all existing logical sessions, including data captured after additive preparation but before activation. Preserve source memory, lineage, and retained provenance.
- [ ] Prove that later turns, duplicate ingestion, imports, and received checkpoints cannot resolve a pre-cutover session. Explicit reassignment resolves it, and resetting that override restores unresolved state.
- [ ] Remove transitional matching forms and temporary call paths. Merge no state to main with mixed old/new Project matching rules and introduce no feature flag or mixed-version support.
- [ ] Run the shared contract suites, migration validation, representative Team and two-device sync flows, and applicable formatting, lint, typecheck, and build checks. Reuse earlier ticket coverage and add checks only for remaining integration gaps.
- [ ] Verify blocking and submit-and-collect recall use the persisted repository context. Reuse task regressions for repeated reads, timeout/reconnect, cancellation, expiry, failure, and access denial; collect the same task after interrupted observation rather than resubmitting. Retain requested citations and evidence. No new task runtime or automatic completion delivery is required.
- [ ] Verify that Global and Session recall and Desktop inspection still expose authorized unresolved history. No database reset or automatic historical repair is performed.
- [ ] Complete the ADR, protocol, ingestion, retrieval, async/durable recall, configuration, integration, and Desktop documentation and record acceptance evidence. Preserve the reranker-free baseline and existing evidence-selection regressions.
- [ ] Merge the integration branch as the single Project behavior cutover only after all blockers and acceptance criteria pass.

## 17: Prefer relevant current-repository evidence in Personal Global recall

**What to build:** Personal Global Memory Answer can find current-repository evidence that the global candidate limit would otherwise discard.

**Blocked by:** 08: Recall Personal Memory by effective Project identity.

**Status:** ready-for-agent

- [ ] Retrieve bounded Global and current-repository candidate pools using the task's persisted context, with the same authorization, time bounds, source eligibility, and effective-assignment rules. Account for both passes within existing search, decrypt, candidate, and evidence budgets and reuse the query embedding where possible.
- [ ] Merge by canonical source identity before final ranking and truncation. Preserve complete observed references, chunk identities, visibility, lineage, and Project provenance. Retain distinct selected parent summaries alongside partial children within existing evidence-budget rules; shared lineage is not independent corroboration.
- [ ] Apply a bounded repository preference through the existing semantic score and candidate-fusion pipeline, with a smaller branch preference only when repository and known branch match. Define the scale and placement, preserve relevance thresholds, and prevent overlap between pools from giving an unintended double boost. No reranker model or service is introduced.
- [ ] Return current, other, or unknown Project classification and an authorized label. Unresolved caller context and mixed or incomparable evidence receive no current-repository preference.
- [ ] Have the AI Client identify other Projects and preserve unknown provenance in answers. Retain AI Client synthesis.
- [ ] Extend existing deterministic tests/evaluations for candidate recovery beyond the Global pool limit, equal relevance, clearly better other-repository evidence, and overlap between pools. Compare with the current semantic retrieval baseline; reuse evidence-selection regressions rather than adding another harness.
- [ ] Test that shared branch names alone give no cross-repository preference and that historical-unresolved evidence remains unknown.
- [ ] Document limits and behavior. This ticket can be developed after its blocker, but its release follows ticket 16.

## 18: Apply Global repository preferences to Team Memory

**What to build:** Team Global Memory Answer uses authorized Project snapshots to improve relevance and label evidence without weakening Team access rules.

**Blocked by:** 14: Share and recall Team Memory by Project snapshot; 17: Prefer relevant current-repository evidence in Personal Global recall.

**Status:** ready-for-agent

- [ ] Retrieve bounded Team Global and current-repository candidates from the selected Workspace and authorized Share Grants using the same time and source rules.
- [ ] Classify evidence from the Team snapshot rather than the owner's current personal assignment.
- [ ] Reuse the persisted request context, result classifications, prompt behavior, candidate limits, budgets, evidence-merge rules, and semantic ranking contract established for Personal Global recall.
- [ ] Apply a branch preference only when a matching branch observation is known and authorized. Missing or incomparable metadata gives no preference.
- [ ] Use the Team fixture to prove private and revoked sources remain absent from both pools and all expansions.
- [ ] Run the shared ranking cases against Team fixtures for equal relevance, candidate recovery, clearly better other-repository evidence, pool overlap, and unknown snapshots. Add only Team-specific snapshot and authorization assertions.
- [ ] Update Team retrieval and integration documentation. Release only after the Project cutover in ticket 16.

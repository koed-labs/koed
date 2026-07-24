# Retention Lifecycle

Koed applies retention policy versions prospectively. A new version controls
lifecycle triggers at or after its `effectiveAt` timestamp; creating that
version does not rewrite an existing retention decision or silently reduce its
`retainUntil` value.

Cross-Identity Sync revocation stops future propagation and marks the remote
replica stale; it does not remove an active grant or its retained Team
representation. Share Grant revocation is an access operation that immediately
removes ordinary Team access and atomically starts a separate grant-scoped
retention clock. It leaves the owner-private replica intact. Personal deletion,
Workspace Archive, Access Suspension, legal hold, retention expiry, and hard
purge continue through their separate authorization and lifecycle rules.

## Share Grant Revocation

Creating a Team also creates its initial Team retention policy in the same
transaction. The initial policy retains Team content for 30 days, adds no
deletion grace period, and schedules backup expiry after 30 days. Team owners
and admins can replace it prospectively through the versioned policy workflow.
A Share Grant cannot be created unless a Team or Workspace retention policy is
effective.

Revocation increments the Share Grant's monotonic revocation epoch and creates
one immutable `share_revoked` decision, one durable purge job, and one evidence
row for every required artifact. Team, Workspace, and grant-specific policies
effective at the transaction timestamp are evaluated together. The latest
deadline controls, so a narrower policy cannot silently shorten a broader
retention obligation. The decision binds the controlling policy and the full
content-free evaluated policy basis.

A revoked grant may be restored only while its purge job is untouched and
pending. Restoration atomically cancels that job, clears the grant's active
retention pointers, and preserves the canceled job, decision, and evidence for
audit. Once claim has moved the grant to `purge_pending`, restoration fails. A
later revocation uses a new epoch and new decision/job rather than reviving the
canceled work.

When expiry and legal holds allow deletion, the Worker purges only that grant's
Team representation chunks, encrypted companion discussion, grant-scoped
outbox/replay material, and structural rows. It resets a stream cursor that
acknowledged a deleted grant event. Grant-specific vector and search evidence
is explicitly `not_applicable` until those materializations exist. The
owner-private source, other grants, normal Team channels, and unrelated Team
content are not part of this purge scope. Team, Workspace, representation,
companion-thread, and companion-message-range holds block destructive work.

## Shortening Existing Retention

Shortening an existing retention decision is a separate management workflow:

1. An enabled Team owner or admin uses a fresh browser session to create the
   prospective policy version.
2. The manager requests an affected-scope preview for that exact current policy
   version and chooses a positive grace period. The server extends the grace
   deadline through the policy's `effectiveAt` timestamp when necessary.
3. The preview lists only content-free lifecycle facts: decision, target kind
   and ID, old and proposed deadlines, and applicable legal-hold IDs. Dedicated
   typed preview and affected-scope tables store the exact inventory, immutable
   per-scope hashes, total count, actor, timestamps, and grace deadline. Foreign
   keys bind every scope to its original retention decision and exact policy
   row/version.
4. Existing decisions and purge jobs retain their old deadlines throughout the
   grace period. API Tokens and device credentials cannot perform this policy
   workflow.
5. After grace, a fresh, explicit confirmation must repeat the preview hash and
   affected count. Koed rechecks the current policy version, manager authority,
   every affected decision, and applicable legal holds. Any difference
   atomically transitions the preview to `invalidated` and requires a new
   preview.
6. Confirmation creates new `policy_migration` retention decisions and repoints
   only not-yet-running purge jobs. Prior decisions remain immutable. A late
   confirmation never backdates eligibility before confirmation time. One
   immutable migration link per affected scope binds the original decision to
   its replacement decision.

Database checks, transition triggers, and deferred aggregate constraints reject
snapshot mutation, invalid state transitions, incomplete scope inventories, and
partial confirmations. `audit_events` receives content-free audit projections
for preview, invalidation, and confirmation; it is not retention domain state.

Legal-hold placement and release remain separate authorized workflows. A hold
release still requires an independent eligible confirmer when another holder
exists; retention-policy confirmation cannot release or bypass a hold.

## Purge Progress And Failure

The Worker claims one durable attempt and processes required artifacts in this
order: outbox/replay, vectors, encrypted payloads, wrapped keys, search index,
database lifecycle rows, and backup expiry. Each artifact cleanup and evidence
checkpoint is transactional. Verified artifacts are immutable and skipped on a
retry.

An artifact failure records `failed` evidence with its artifact kind and
content-free locator hash, then stores the same pair as the resume checkpoint.
Retries continue from the first non-terminal artifact. The Worker emits bounded
Operator progress containing the purge job ID, attempt number, artifact kind,
and completed/required counts; it does not log payload text, key material,
source text, or provider error messages.

After the configured maximum attempt count, the job enters terminal `failed`
state, is no longer claimable, and receives one minimal content-free audit
record containing the target IDs, attempt number, artifact kind, error class,
and error hash. Operator intervention must create a newly authorized lifecycle
operation; terminal jobs are not silently revived.

## Verified Purge And Restore

Completion is refused until every primary artifact is verified or explicitly
not applicable and backup expiry is durably scheduled. Legal holds are checked
again immediately before completion. A verified root Team purge marks the Team
and its Workspaces `purged` with `purgeCompletedAt`; Workspace restore accepts
only `archived` Workspaces under an `active` Team, so verified purge cannot be
restored. Archive and suspension remain the reversible lifecycle states.

Owner-private replica purge derives scope from the replica, source Captured
Session, and Cross-Identity Sync relationship rather than from Share Grants. It
removes replica-derived records, target-owned vectors, sync package/replay state,
encrypted companions, and wrapped keys when retention and holds allow. A
retained Team representation follows its own grant-scoped retention and key
boundary; purging one scope must not delete unrelated grants or replicas.

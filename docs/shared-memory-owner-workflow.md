# Shared Memory owner workflow model

## Decision

Defer extraction of a new deep workflow module. The load-bearing Shared Memory
bundle invariants belong at the transaction-owning repository seam, where they
already execute with row locks, optimistic versions, policy checks, encrypted
materialization, audit, and outbox writes in one database transaction. The
local-edge control is a distributed protocol adapter: it validates an exact
remote response, persists an authoritative local projection, and makes retries
safe, but it cannot make the remote Team Backend and local state atomic.

Moving those rules into a second application state machine would create two
authorities and weaken the repository's transaction boundary. This decision is
based on where authority and atomicity live, not on the size of
`collaboration-shared-memory-control.ts` or `shared-memory-repository.ts`.
Small pure response/binding validators may still be extracted independently;
that is ordinary code organization, not a new workflow owner.

## Concept boundaries

- **Personal Memory** is owned by the source User. Source content and the
  owner-private replica do not become Team data merely because they can be
  previewed.
- **Cross-Identity Sync** moves an authorized owner-private replica to the
  source owner's enrolled identity. It establishes source availability and
  provenance; it creates no Share Grant or Workspace Access.
- A **Personal Note revision source** is a standalone one-event source artifact.
  Snapshot mode pins one revision; Continuous mode advances only across newer
  revisions of the same Note. Neither creates a replica or Cross-Identity Sync
  relationship.
- A **Team** is the collaboration authority containing destinations and policy.
- A **Workspace** is the exact destination inside a Team. Changing Team or
  Workspace creates a different destination and invalidates an existing
  preview/consent bundle.
- **Workspace Access** authorizes a User to the destination. It neither proves
  Personal Memory ownership nor grants the source.
- A **Share Grant** is the durable, destination-bound authority derived from
  owner consent. It is not Cross-Identity Sync, Workspace Access, or ownership.
- Share ownership permits the owner to list safe grant metadata and revoke the
  grant. It does not restore Workspace content or companion-discussion access
  after the owner's Workspace Access is removed.
- A **logical Memory source revision** is the positive immutable identity used
  by generic sharing workflows. Its typed binding supplies source-specific
  meaning. A Captured Session cursor remains a separate non-negative value;
  cursor zero maps to generic revision one and ordinary cursor movement does
  not create a durable frontier.

## Authoritative inputs

| Input                                                                           | Authority                                        | Used for                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Source ownership and owner principal                                            | Personal Memory repository                       | Who may preview, consent, create, change, and revoke                         |
| Captured Session replica state, source revision/hash, provenance, relationship  | Cross-Identity Sync repository                   | Whether exact owner-private Captured Session bytes are eligible              |
| Personal Note id, projected Memory Event, owner, and exact revision hash        | Personal Memory repository                       | Whether the exact standalone Note revision is eligible                       |
| Replica state, source revision/hash, provenance, relationship                   | Cross-Identity Sync repository                   | Whether exact owner-private source bytes are eligible                        |
| Team, Workspace, membership, Workspace Access                                   | Team Backend                                     | Destination existence and current access                                     |
| Owner, Team, and Workspace representation policies                              | Transaction-owning Shared Memory repository      | Exact three-policy intersection                                              |
| Preview ID/hash/revision and encrypted artifact binding                         | Shared Memory repository                         | Immutable consent snapshot and pagination                                    |
| Consent ID, mode, representation, expiry                                        | Source User intent persisted by the Team Backend | Scope of authority delegated by the owner                                    |
| Share Grant version/lifecycle and representation version                        | Shared Memory repository                         | Optimistic concurrency, retries, change, and revocation                      |
| Browser session or Action Grant source/reference, plus mutation/idempotency IDs | Team Backend plus local authority lifecycle      | Exact authority reconstruction after worker restart and replay-safe mutation |

Renderer state, labels, cached pages, and locally reconstructed guesses are
never authoritative inputs.

## States

| State                           | Meaning                                                                                                                                | Recoverable outcome                                          | Fail-closed conditions                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `source_unavailable`            | No current enrolled, provenance-bound replica exists                                                                                   | Complete/retry Cross-Identity Sync                           | Wrong owner/device/backend, revoked or incomplete relationship      |
| `candidate_ready`               | A bounded local semantic candidate is available for destination and policy review; no sync exists                                      | Accept the exact reviewed binding                            | Candidate expiry, source revision change, destination/policy drift  |
| `pending_share`                 | Consent, mutation identity, candidate binding, and durable outbox exist; Workspace access is `none`                                    | Background sync, processing, retry, or cancellation          | Widening authority, duplicate logical grant, unredacted diagnostics |
| `source_ready`                  | Exact replica and representation snapshot are available                                                                                | Request a destination-bound preview                          | Stale provenance, missing LCM snapshot, policy unavailable          |
| `preview_ready`                 | Authoritative preview is persisted with destination, source revision/hash, destination policies, and an inactive owner-policy proposal | Page it or submit the final reviewed bundle                  | Any binding mismatch or changed destination/policy/source           |
| `consent_ready`                 | Active owner consent binds the exact preview and selected representation                                                               | Create or replace a Share Grant                              | Expired/revoked consent, representation outside intersection        |
| `grant_materialization_pending` | Grant exists as `unavailable`; the selected encrypted Team representation is not confirmed                                             | Retry the same deterministic materialization mutation        | Grant/consent/version/preview mismatch or encryption-key reuse      |
| `grant_active`                  | Share Grant, selected encrypted representation, companion discussion, and local authoritative projection agree                         | Read, continuously advance, change representation, or revoke | Lost Workspace Access, policy invalidation, authority mismatch      |
| `grant_stale`                   | Last authorized revision remains readable but propagation can no longer advance                                                        | Restore exact authority or revoke                            | Treating stale data as current or ingesting future source revisions |
| `grant_revoked`                 | Grant authority and representations are invalidated; companion retention follows policy                                                | Idempotently observe the same revocation                     | Reusing a mutation for a different reason/actor or serving content  |

## Transitions

| Transition                        | User intent                                            | Checks and authoritative mutation                                                                                                                                                                                                                                                                                                                                    | Retry/interruption result                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-Identity Sync becomes ready | Make owned Personal Memory available for sharing       | Bind source owner, enrolled device, relationship, replica, revision, provenance, and representation snapshot                                                                                                                                                                                                                                                         | Pending is retryable; revoked/mismatched identity fails closed                                                                                                                                                                 |
| Create candidate preview          | Inspect what could be shared before synchronization    | Reserve the session's semantic sync cursor, build a bounded local candidate at that revision, bind the source deployment and owner principal through the current device-credential lineage, validate destination/policy remotely, and persist its exact expiring binding; create no relationship, upload, replica, or grant                                          | Expiry, protocol mismatch, or binding drift requires a fresh candidate                                                                                                                                                         |
| Page preview                      | Inspect the rest of the same snapshot                  | Verify signed cursor identity, preview hash/ID, snapshot key, offset, and stored preview                                                                                                                                                                                                                                                                             | Expired or changed snapshot returns history-expired, never a new page silently                                                                                                                                                 |
| Change destination before consent | Share somewhere else                                   | No in-place retargeting; request a new preview bound to the new Team and Workspace                                                                                                                                                                                                                                                                                   | Old preview/consent conflicts                                                                                                                                                                                                  |
| Accept Pending Share              | Share this snapshot under selected mode/representation | Persist consent binding, stable mutation/logical-grant identity, Pending Share, safe progress state, audit, and outbox before returning; Workspace access remains `none`                                                                                                                                                                                             | Exact retry returns the same operation; divergent mutation reuse conflicts                                                                                                                                                     |
| Activate Pending Share            | Complete the accepted share asynchronously             | Start sync only after acceptance; reproduce the complete ordered candidate manifest; stage an unreadable representation; resolve the deterministic companion; publish representation, grant, companion, and Pending Share atomically                                                                                                                                 | Worker restart reuses durable identities; companion failures remain quarantined and repairable without owner-list side effects                                                                                                 |
| Activate Personal Note revision   | Share one reviewed Note Memory Event                   | Re-authorize the Note and destination; upload one standalone encrypted artifact; materialize one `memory_events` representation; create the deterministic companion; create no replica or sync relationship                                                                                                                                                          | Exact artifact, materialization, grant, and companion identities converge across retries; source or policy drift fails closed                                                                                                  |
| Advance Continuous Personal Note  | Publish a newer revision of the same Note              | Projection writes a durable local queue item; initial grant persistence reconciles any revision projected during activation; rapid edits coalesce; the enrolled device submits the exact revision; each destination is authorized independently; privacy and encrypted materialization complete before that destination's grant and representation switch atomically | The prior ready revision remains readable; stale jobs cannot replace a newer revision; one unavailable destination cannot block eligible destinations; pause stops advancement, resume catches up, and revocation fails closed |
| Change representation             | Replace/reactivate the representation                  | Persist a durable replacement from the current grant version and fresh candidate preview; prepare it in background; create its authoritative preview and consent; switch grant and materialized representation inside one transaction                                                                                                                                | The prior representation remains readable during preparation; concurrent changes conflict; restart replay sees either the old or completed new representation                                                                  |
| Continuous propagation            | Keep a continuous grant current                        | Repository advances only authorized source revisions under current replica, policies, lifecycle, and encryption context                                                                                                                                                                                                                                              | Revocation/sync loss stops advancement and retains only the last authorized revision as stale                                                                                                                                  |
| Pause or resume updates           | Stop or continue future continuous revisions           | Change only the continuous consent/update state; keep the last activated representation and Workspace access while paused; append an owner lifecycle event                                                                                                                                                                                                           | Exact retries are stable; snapshot shares and stale versions fail closed                                                                                                                                                       |
| Revoke                            | End destination authority                              | Lock grant/retention scope, require owner and expected version, invalidate representations, advance revocation epoch, revoke attached Conversation Source Access, close source streams, schedule retention work, and append outbox                                                                                                                                   | Exact retry returns the same revoked grant and repairs stale derived lifecycle state; divergent reuse conflicts                                                                                                                |

Owner-management responses state whether current Workspace content access is
available. When unavailable, they omit the companion binding and source
preview while retaining Team, Workspace, title, fidelity, lifecycle, and the
authority needed to revoke. Owner-list reads never create or repair a companion.
Team representation responses contain the current source revision needed for
ordering, but never expose owner-private source or revision hashes.

## Why the repository seam owns bundle invariants

`createShareBundle` and `changeRepresentationBundle` in
`packages/db/src/shared-memory-repository.ts` own the outer transaction for the
consent plus Share Grant or representation mutation. Their component repository
operations use nested savepoints, so a failed or mismatched second stage rolls
back the consent as well for both browser-session and device Action Grant
execution. The individual revoke and materialization operations retain their
own transaction boundaries. All of these paths lock the relevant
consent/grant/representation or retention scope, re-read current ownership and
policy, and enforce optimistic versions and idempotency. Tests in
`packages/db/tests/shared-memory-repository.test.ts` cover bundle rollback,
stale sync, destination uniqueness, concurrent retries, exact revocation replay,
policy changes, and encrypted materialization.

Candidate previews store the authority kind and authority reference. Remote
candidate admission requires a one-use device Action Grant for one exact
binding. Browser sessions create authoritative previews only from source state
already owned by the backend. Pending Share records retain the same authority
source, so a restarted worker never treats browser authority as device
authority.

Device candidate admission also carries `sourceDeploymentProtocolId` and
`sourceOwnerPrincipalId`. The remote backend recomputes the deterministic
logical Memory ID, verifies the claimed deployment against the authenticated
device credential, and requires the remote principal to have the active binding
established when that credential was browser-approved by the authenticated
User. This identity-only enrollment binding does not start Cross-Identity Sync
or move content. Share review cannot establish or reactivate a principal
binding. Both provenance fields and the public Action Grant reference
remain in the exact request hash. Revoked deployments, principals, links, or
device credentials are never revived by admission.

Capability discovery advertises
`protocols.sharedMemorySourceAdmission.version = 1`. Deploy the Team backend
first, revalidate its cached capabilities, and then deploy Desktop/local-server
clients. Missing source provenance or a backend without version 1 fails closed
with the explicit safe `protocol_mismatch` result before Action Grant creation.

The candidate row also retains the immutable ordered source identities and
per-source revision hashes, representation, semantic source revision, item and
byte counts, deterministic exclusion count, and candidate hash. Preview pages
are slices of that retained set. They never extend the authorized set.

The candidate source revision is the Captured Session's semantic sync cursor,
not a Capture Hook transport sequence. Candidate preparation binds that cursor
to a positive, immutable generic revision only when the durable candidate
workflow needs the frontier; ordinary ingestion cursor movement does not.
Candidate preparation creates no sync relationship or source upload. After
acceptance, the same typed frontier becomes the exact revision that the source
worker transfers and the Team worker activates.
The reviewed binding also includes the selected snapshot or continuous mode.
Changing that mode in Desktop re-authorizes the preview before consent so the
final command cannot reuse a preview created for a different mode.

For a Personal Note, the candidate source revision is the selected positive,
immutable Note revision and the manifest contains exactly its projected Memory
Event. Snapshot or Continuous mode may be selected; `memory_events` is the only
valid representation. Review and activation reauthorize that exact historical
revision, so a later edit does not retarget or invalidate a Snapshot. A
Continuous Share advances only to a strictly newer projected revision of the
same Note and logical Memory. The standalone artifact is sufficient source
custody; replica and sync relationship identities are invalid for this source
branch.
If a Note edit is projected while its initial Continuous grant is activating,
authoritative grant persistence reconciles the latest eligible projection into
durable advancement work. Advancement reports a terminal, redacted outcome for
each destination: eligible destinations queue independently, while a destination
that has lost current access or policy eligibility is skipped without delaying
the others. Destination admission is cursor-paged in bounded batches; the local
edge persists every page before advancing its cursor, so a large destination set
cannot exceed a response bound or strand later destinations. Unexpected storage
failures still fail the operation and retry.
The authenticated upload carries the local source principal that was used to
hash the reviewed candidate. The Team Backend verifies the deterministic Note
identity, requires the source deployment and principal to match both the device
credential and its active enrolled principal binding, and then stores the
standalone artifact for the remote User. The upload cannot establish or revive
identity authority and does not create a Cross-Identity Sync relationship.

Owner-local source titles remain Personal metadata. The Team-visible Share label
is derived from the privacy-filtered semantic representation and is published
with that exact source revision. Neither a review request nor an owner-local
title can cross the Team privacy boundary. Continuous updates advance the label
monotonically, so completion of an older privacy job cannot replace a newer
Team-safe label.

Owner Share detail reads the consent-bound authoritative preview from the Team
Backend after the owner boundary is checked. The local authority validates and
retains that exact preview revision for paging. This lets an asynchronously
activated Pending Share display what was actually materialized even when the
backend-generated preview was not present in the earlier local candidate cache.
Owner listing is read-only: it pages by immutable creation tuple, batch-loads
local authority snapshots, and never creates or repairs a companion. Activation
and quarantined recovery are the only companion creation paths.
An activated Pending Share owner DTO also carries the current Share Grant
version. Desktop uses that exact version for protected revocation instead of
the Pending Share operation version. The identity and version are returned
together and Desktop submits that exact pair when asking for revocation
approval.
An accepted Personal Note Pending Share remains owner-visible before its
standalone logical-memory row is materialized. This lets the Shares view report
source-upload progress or failure instead of filtering out the operation.

`apps/api/src/local-edge/collaboration-shared-memory-control.ts` has a different
job. Its preview, share, representation-change, revoke, and pagination handlers
bind the local enrolled identity and Action Grant to an exact request, reject
remote envelope drift, and persist only authoritative remote revisions. A
remote success followed by local interruption is recovered by repeating the
same mutation/idempotency identity and accepting only a matching authoritative
snapshot. This is necessarily distributed reconciliation, not a database
bundle invariant.

## Revisit trigger

Proceed with a new tracer-bullet breakdown only if a second caller must execute
the same multi-step remote protocol and cannot reuse the existing control, or
if evidence shows identical transition/recovery logic diverging in multiple
adapters. At that point tickets should separately extract: pure transition
decisions; an idempotent remote-operation journal; adapter-independent envelope
validation; and parity tests against the repository transaction contract. No
such duplicated workflow owner exists today, so no follow-on implementation
tickets are created.

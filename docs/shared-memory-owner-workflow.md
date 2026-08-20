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
- A **Team** is the collaboration authority containing destinations and policy.
- A **Workspace** is the exact destination inside a Team. Changing Team or
  Workspace creates a different destination and invalidates an existing
  preview/consent bundle.
- **Workspace Access** authorizes a User to the destination. It neither proves
  Personal Memory ownership nor grants the source.
- A **Share Grant** is the durable, destination-bound authority derived from
  owner consent. It is not Cross-Identity Sync, Workspace Access, or ownership.

## Authoritative inputs

| Input                                                                           | Authority                                        | Used for                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Source ownership and owner principal                                            | Personal Memory repository                       | Who may preview, consent, create, change, and revoke                         |
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

| Transition                        | User intent                                            | Checks and authoritative mutation                                                                                                                                                                                                     | Retry/interruption result                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-Identity Sync becomes ready | Make owned Personal Memory available for sharing       | Bind source owner, enrolled device, relationship, replica, revision, provenance, and representation snapshot                                                                                                                          | Pending is retryable; revoked/mismatched identity fails closed                                                                                                |
| Create candidate preview          | Inspect what could be shared before synchronization    | Reserve the session's semantic sync cursor, build a bounded local candidate at that revision, validate destination/policy remotely, and persist its exact expiring binding; create no relationship, upload, replica, or grant         | Expiry or binding drift requires a fresh candidate                                                                                                            |
| Page preview                      | Inspect the rest of the same snapshot                  | Verify signed cursor identity, preview hash/ID, snapshot key, offset, and stored preview                                                                                                                                              | Expired or changed snapshot returns history-expired, never a new page silently                                                                                |
| Change destination before consent | Share somewhere else                                   | No in-place retargeting; request a new preview bound to the new Team and Workspace                                                                                                                                                    | Old preview/consent conflicts                                                                                                                                 |
| Accept Pending Share              | Share this snapshot under selected mode/representation | Persist consent binding, stable mutation/logical-grant identity, Pending Share, safe progress state, audit, and outbox before returning; Workspace access remains `none`                                                              | Exact retry returns the same operation; divergent mutation reuse conflicts                                                                                    |
| Activate Pending Share            | Complete the accepted share asynchronously             | Start sync only after acceptance; reproduce the complete ordered candidate manifest; stage an unreadable representation; resolve the deterministic companion; publish representation, grant, companion, and Pending Share atomically  | Worker restart reuses durable identities; companion failures remain quarantined and repairable without owner-list side effects                                |
| Change representation             | Replace/reactivate the representation                  | Persist a durable replacement from the current grant version and fresh candidate preview; prepare it in background; create its authoritative preview and consent; switch grant and materialized representation inside one transaction | The prior representation remains readable during preparation; concurrent changes conflict; restart replay sees either the old or completed new representation |
| Continuous propagation            | Keep a continuous grant current                        | Repository advances only authorized source revisions under current replica, policies, lifecycle, and encryption context                                                                                                               | Revocation/sync loss stops advancement and retains only the last authorized revision as stale                                                                 |
| Pause or resume updates           | Stop or continue future continuous revisions           | Change only the continuous consent/update state; keep the last activated representation and Workspace access while paused; append an owner lifecycle event                                                                            | Exact retries are stable; snapshot shares and stale versions fail closed                                                                                      |
| Revoke                            | End destination authority                              | Lock grant/retention scope, require owner and expected version, invalidate representations, advance revocation epoch, revoke attached Conversation Source Access, close source streams, schedule retention work, and append outbox    | Exact retry returns the same revoked grant and repairs stale derived lifecycle state; divergent reuse conflicts                                               |

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

Candidate previews store the authority kind and authority reference. A browser
session can authorize multiple distinct candidates. A one-use device Action
Grant can authorize only one binding. Pending Share records store the same
authority source. Thus, a restarted worker does not treat browser authority as
device authority.

The candidate row also retains the immutable ordered source identities and
per-source revision hashes, representation, semantic source revision, item and
byte counts, deterministic exclusion count, and candidate hash. Preview pages
are slices of that retained set. They never extend the authorized set.

The candidate source revision is the captured session's semantic sync cursor,
not a Capture Hook transport sequence. Candidate preparation can reserve that
cursor locally before consent, but it does not create a sync relationship or
upload source data. After acceptance, the same cursor becomes the exact
revision that the source worker transfers and the Team worker activates.
The reviewed binding also includes the selected snapshot or continuous mode.
Changing that mode in Desktop re-authorizes the preview before consent so the
final command cannot reuse a preview created for a different mode.

The owner may assign a destination-specific Share name during review and rename
it later from Modify Share. This metadata is stored on the Pending Share and
the activated Share Grant. It does not change the source Captured Session title
or the names of Shares sent to other Workspaces.

Owner Share detail reads the consent-bound authoritative preview from the Team
Backend after the owner boundary is checked. The local authority validates and
retains that exact preview revision for paging. This lets an asynchronously
activated Pending Share display what was actually materialized even when the
backend-generated preview was not present in the earlier local candidate cache.
Owner listing is read-only: it pages by immutable creation tuple, batch-loads
local authority snapshots, and never creates or repairs a companion. Activation
and quarantined recovery are the only companion creation paths.

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

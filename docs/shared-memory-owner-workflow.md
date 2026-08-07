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

| Input                                                         | Authority                                        | Used for                                                |
| ------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Source ownership and owner principal                          | Personal Memory repository                       | Who may preview, consent, create, change, and revoke    |
| Replica state, source revision/hash, provenance, relationship | Cross-Identity Sync repository                   | Whether exact owner-private source bytes are eligible   |
| Team, Workspace, membership, Workspace Access                 | Team Backend                                     | Destination existence and current access                |
| Owner, Team, and Workspace representation policies            | Transaction-owning Shared Memory repository      | Exact three-policy intersection                         |
| Preview ID/hash/revision and encrypted artifact binding       | Shared Memory repository                         | Immutable consent snapshot and pagination               |
| Consent ID, mode, representation, expiry                      | Source User intent persisted by the Team Backend | Scope of authority delegated by the owner               |
| Share Grant version/lifecycle and representation version      | Shared Memory repository                         | Optimistic concurrency, retries, change, and revocation |
| Action Grant and mutation/idempotency IDs                     | Team Backend plus local Action Grant lifecycle   | Exact one-use authority and replay-safe mutation        |

Renderer state, labels, cached pages, and locally reconstructed guesses are
never authoritative inputs.

## States

| State                           | Meaning                                                                                                              | Recoverable outcome                                          | Fail-closed conditions                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `source_unavailable`            | No current enrolled, provenance-bound replica exists                                                                 | Complete/retry Cross-Identity Sync                           | Wrong owner/device/backend, revoked or incomplete relationship      |
| `source_ready`                  | Exact replica and representation snapshot are available                                                              | Request a destination-bound preview                          | Stale provenance, missing LCM snapshot, policy unavailable          |
| `preview_ready`                 | Authoritative preview is persisted with destination, source revision/hash, policies, representation, and allowed set | Page it or record consent                                    | Any binding mismatch or changed destination/policy/source           |
| `consent_ready`                 | Active owner consent binds the exact preview and selected representation                                             | Create or replace a Share Grant                              | Expired/revoked consent, representation outside intersection        |
| `grant_materialization_pending` | Grant mutation succeeded but the selected encrypted Team representation is not confirmed                             | Retry the same deterministic materialization mutation        | Grant/consent/version/preview mismatch or encryption-key reuse      |
| `grant_active`                  | Share Grant, selected encrypted representation, companion discussion, and local authoritative projection agree       | Read, continuously advance, change representation, or revoke | Lost Workspace Access, policy invalidation, authority mismatch      |
| `grant_stale`                   | Last authorized revision remains readable but propagation can no longer advance                                      | Restore exact authority or revoke                            | Treating stale data as current or ingesting future source revisions |
| `grant_revoked`                 | Grant authority and representations are invalidated; companion retention follows policy                              | Idempotently observe the same revocation                     | Reusing a mutation for a different reason/actor or serving content  |

## Transitions

| Transition                            | User intent                                            | Checks and authoritative mutation                                                                                                                                                                                                                    | Retry/interruption result                                                                     |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Cross-Identity Sync becomes ready     | Make owned Personal Memory available for sharing       | Bind source owner, enrolled device, relationship, replica, revision, provenance, and representation snapshot                                                                                                                                         | Pending is retryable; revoked/mismatched identity fails closed                                |
| Create preview                        | Inspect exactly what a destination could receive       | Resolve exact replica; require local LCM readiness when selected; use Direct approval only when the source-owner policy is unchanged and Step-up when creating or replacing it; consume the exact Action Grant; persist the validated remote preview | Same request is safe; malformed/mismatched remote data is not persisted                       |
| Page preview                          | Inspect the rest of the same snapshot                  | Verify signed cursor identity, preview hash/ID, snapshot key, offset, and stored preview                                                                                                                                                             | Expired or changed snapshot returns history-expired, never a new page silently                |
| Change destination before consent     | Share somewhere else                                   | No in-place retargeting; request a new preview bound to the new Team and Workspace                                                                                                                                                                   | Old preview/consent conflicts                                                                 |
| Record consent and create Share Grant | Share this snapshot under selected mode/representation | In one remote bundle: validate preview/version/policies, persist consent, create grant and outbox; then materialize exact encrypted representation and persist authoritative projection                                                              | Reuse the same mutation IDs; conflicts require fresh preview rather than rebasing intent      |
| Change representation                 | Replace/reactivate the representation                  | Require current grant version and a fresh exact preview/consent; invalidate prior representation, update grant, append outbox, materialize replacement                                                                                               | Concurrent version change is conflict; deterministic materialization resumes safely           |
| Continuous propagation                | Keep a continuous grant current                        | Repository advances only authorized source revisions under current replica, policies, lifecycle, and encryption context                                                                                                                              | Revocation/sync loss stops advancement and retains only the last authorized revision as stale |
| Revoke                                | End destination authority                              | Lock grant/retention scope, require owner and expected version, invalidate representations, advance revocation epoch, schedule retention work, append outbox                                                                                         | Exact retry returns the same revoked grant; divergent reuse conflicts                         |

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

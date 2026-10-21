# Shared Memory owner workflow model

## Operational alpha boundary

The [operational alpha](../tickets.md) disables rule content-policy editing.
Desktop omits the editors for Conversation, Git Anchor, Folder, and Project
rules. The HTTP review and amendment routes reject requests, native commands
reject them before approval or queue creation, and Action Grant admission does
not create a new approval. Pending native and browser requests cannot approve
this action. Existing approval and policy records remain intact.

The local delivery worker moves previously queued content-policy edits to
`needs_review` without sending them or acknowledging them. Desktop explains
that editing is unavailable and the prior remote outcome remains unconfirmed.
An earlier request may already have committed remotely. The worker retains its
encrypted intent and clears the retry credential through the existing delivery
transition. It does not roll back or broaden stored restrictions.

Current Privacy checks, creation, detail changes, and pause/resume/stop remain
enabled. The P2-09 implementation sections below describe deferred internals;
they do not make policy editing available in the alpha.

This document describes the current source-based sharing implementation.
The agreed [recall and continuous sharing model](recall-and-continuous-sharing-model.md)
describes continuous selection of existing and future sources, with automatic
resume catch-up. The alpha demonstrates selected Conversation and Git Anchor
flows; the broader package acceptance matrix remains open.

Desktop Shares refreshes immediately on owner status events and authoritative
connection recovery. While a Pending Share is preparing or a sharing reason has
updates active, it also reloads the owner list five seconds after the previous
read completes. This covers local Personal subscriptions that do not receive
the Team Backend's owner-only events. Reads stop when neither condition remains
or Shares is closed. Temporary read failures retry with backoff from one to
thirty seconds, respecting a longer server retry delay; access denials do not
retry. These are status reads, not retries of privacy processing or sharing
mutations. Using Retry on a failed Pending Share restarts these reads when
preparation resumes.

The owner source preview follows the latest published revision under that
entry's current consent. Its preview must match the same owner, source,
destination, activation representation, and approved detail. An unpublished
revision cannot replace it. Fixed snapshots retain their approved revision;
separate sharing reasons do not lend each other preview authority. Workspace
access is checked before exposing or decrypting the preview.

A newly approved selection rule can admit a Conversation whose earlier share
to the same Workspace was revoked. Its original approval must be later than
the destination revocation, and the exact grant version is checked again at
activation. Detail amendments cannot supply that fresh approval. The existing
grant identity is reused with a new rule consent and publication; old sharing
reasons, consents, and invalidated publications stay stopped. Reactivation
cancels pending revocation cleanup but fails if purge has started or Personal
Memory has been deleted. Privacy filtering still precedes Team access.

Revocation can start from an activated Pending Share whose grant has not yet
been projected into local authority storage. In that case, the local control
loads the grant through the existing scoped owner-detail read before checking
its identity, destination, expected version, and approved revocation binding.
A different Workspace still fails before any revocation request is sent.

Authoritative source previews use a repeatable-read transaction. When the
preview owns that transaction, serialization conflicts (40001) and deadlocks
(40P01) may retry the complete transaction twice. Each attempt reloads current
authority and source state. Other errors are not retried. A caller-owned
transaction remains the caller's responsibility; preview preparation never
restarts part of an enclosing consent or publication transaction.

Rule-member activation retries its idempotent admission workflow up to three
attempts when PostgreSQL reports a serialization failure (40001) or deadlock
(40P01). Each attempt reloads current rule and grant authority through the normal
activation path. Permission failures and other errors are not retried. If all
three attempts conflict, the Pending Share still requires attention and an
explicit Retry. This does not automatically resume an already-failed operation.

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

## Owner explanation for direct sharing (P2-01)

`team_memory_share_reasons` records one direct reason for each source Share Grant.
The reason retains a stable identity and binds the current, explicitly approved
consent and repository snapshot. A database trigger maintains that binding in
the same transaction as grant creation, reviewed consent replacement, or a
repository snapshot update. It does not authorize publication or run a separate
lifecycle. Existing snapshot and continuous consent keep their original scope.

The owner-only `owned-shares` list and detail responses include
`summary.sharingReasons`. Each reason explains its consent version and limits,
permitted representations, revision ceiling, expiry, approved repository
snapshot, and published representations with their own revisions. Update state
comes from persisted grant and consent authority: fixed snapshot, active,
paused, stopped, expired, or pending. A preparing Pending Share has no published
reason until a grant exists. This record does not imply new continuous rule
authority or automatic catch-up; those follow in P2-02.

Desktop's Personal Shares detail shows the reason for the selected destination.
Conversation Source Access remains a separately authorized grant and is shown
independently. A permitted Memory Event representation does not permit reading
the Conversation Source.

Ownership still permits safe management metadata after Workspace removal.
Reasons remain visible to the owner, while content previews and companion
discussion access remain unavailable. Another reader cannot inspect the owner's
reasons. Team grant, recall, evidence, expansion and direct-read responses do
not serialize this owner management metadata. Their existing consent, policy,
representation and Workspace checks remain authoritative. Removing a reader
does not itself revoke a retained contribution; revoking consent or the Share
Grant still denies content under that authority.

### Embedding retained Team content

The Shared Memory embedding worker can compute embeddings from an authorized,
sanitized Team representation after its owner's Workspace access is removed.
Personal-vector reuse is an optimization with a separate authority check. Before
reading a Personal embedding, the repository requires an enabled owner and Team
membership, plus current Workspace write and sharing permission. It holds those
rows locked through the embedding handoff and checks permission again before
copying a vector. Without that permission, the worker computes from the Team
derivative under its existing authorization lease. A permission change after the
handoff rejects a queued Personal reuse attempt; its next authorized retry can
compute from the Team derivative. This does not restore the owner's Workspace
access or change the Personal vector.

## Continuous Conversation authority (P2-02, in progress)

`team_memory_sharing_rules` stores one owner, exact logical Conversation source,
Workspace, approved detail and effective privacy policy, lifecycle version, and
enrolled publisher fence. `createConversationSharingRule` requires independent,
current continuous consent, an exact reviewed grant version and privacy policy,
and a current owner publisher credential. Its transaction preserves an existing
direct snapshot and attaches a separate rule reason to the same Share Grant.
Idempotent retries cannot change the recorded intent. There is no public rule
creation route or Desktop confirmation flow yet.

`team_memory_reason_publications` binds each reason to an exact representation
record and consent. Direct publication receives that binding in the existing
materialization transaction. Consent is part of representation uniqueness, so
two independent consents cannot overwrite each other's representation record.
Updating a grant's source metadata cannot invent direct authority for a grant
created for a rule.

`team_memory_reason_grant_records` supplies each reason's consent, source,
approved repository snapshot and policy bindings while retaining the single
physical grant. Publication and Memory reads use that authority; singleton
owner management still uses the physical grant. Workspace listing selects one
authorized result for each grant.

`prepareConversationSharingRule` reuses source preview preparation. Its
`team_memory_reason_preparations` record captures the exact reason, consent,
source revision, grant and rule versions, publisher credential and fence, and
effective privacy policy. This record supplies authority to the existing
Privacy and materialization pipeline; it is not another processing queue.
Materialization checks that captured authority and current Workspace permission
before decryption and commits its exact publication binding with the encrypted
representation. The synced source credential must match the rule's publisher.
An obsolete preparation cannot adopt a newer authority version at completion.

Target synchronization prepares active rule representations through the same
path. A completed summary can trigger preparation even when its Memory Event
cursor has not advanced. Unready summaries remain unresolved, while malformed
source material or changed authority fails closed. A rule's later publication
does not overwrite a direct snapshot's root source revision or content. Team
titles use encrypted companion fields bound to the exact representation and
source revision hash. Representation rows contain only a fixed encryption
marker. Title reads recheck the representation's current authority and Privacy
binding before resolving its Team key. Stopping a rule cannot leave a later
title visible through another reason's older snapshot.

Team reads, semantic scan/search, candidate expansion, frozen recall boundaries,
embedding preparation and Personal embedding reuse require exact publication
authority. A newer unbound representation cannot displace an older authorized
revision. Paused consent keeps previously published content available to
authorized readers, including semantic recall. It does not authorize preparing
or publishing a new revision. Owner explanations show each independent reason
and mark a rule pending until content is published through that reason.

This backend publication work does not complete P2-02. Reviewed public command
delivery, durable local acknowledgments and the full Desktop journey remain
required by the ticket. Internal lifecycle controls, automatic catch-up,
companion authority and independent detail are described below.

## Git Anchor sharing review (P2-03)

The Git Anchor's Desktop header offers **Review sharing**. The owner chooses
the Team, Workspace and detail explicitly. This is inspection only: review and
cancellation create no consent, Share Grant, synchronization relationship or
publication work. There is no confirmation or publication action in this slice.

`collaboration.review_git_anchor_sharing` consumes the bounded Personal
selection contract. Every source/reason entry is retained while Desktop merges
pages by actual local Session identity and combines repeated inclusion reasons.
An unfinished or failed page set is never presented as a complete selection.
Unreadable or unprepared detail remains unresolved rather than disappearing
from the reviewed set. The Personal contract excludes pending, invalidated or
unavailable source bindings; Desktop explains that those sources need a fresh
review once available. A local-only source keeps that identity explicitly.

The local adapter inspects exact owned source headers and current candidate
readiness. Review does not create missing LCM Summaries. Candidate content
stays local; only title, readiness, revision and bounded item count reach the
owner's Desktop. A complete review is not publication authority or permission
to bypass privacy processing.

The Team endpoint
`GET /v1/shared-memory/teams/:teamId/workspaces/:teamWorkspaceId/sharing-review`
checks current owner-sharing permission and the requested detail against the
Team and Workspace policy intersection. It accepts no selector, Project label,
Folder path or source body. Browser sessions and scoped device credentials may
read it; Personal-only API Tokens cannot. The operation creates no Action Grant.

An authenticated continuation binds the local owner, upstream principal,
backend, exact selected Git Anchor and destination, detail, policy hashes and
Personal enumeration snapshot. Policy changes, stale or expired selection
cursors, source substitution and cross-owner continuations require a fresh
review. At the final page, the adapter checks the Personal change journal and
rechecks destination policy. Desktop refreshes the same explicit scope instead
of choosing a different destination or widening the selection automatically.
Future matching Conversations are described before any sharing is confirmed;
their admission remains P2-04 work.

## Explicit Project snapshot update (integration branch)

The source owner can review the active Share Grant's current received source
context with `GET /v1/shared-memory/share-grants/:shareGrantId/repository-snapshot/review`.
The review pins the Team, Workspace, grant version, source revision,
representation version, assignment version, and a source-context digest.
It exposes classification and fingerprint without raw label or branch values.

`POST /v1/shared-memory/share-grants/:shareGrantId/repository-snapshot` applies
that exact review with explicit browser or scoped device Action Grant authority.
The transaction rechecks current ownership, Workspace share permission, source
access, consent, privacy authority, and all reviewed versions. A stale review
conflicts instead of silently choosing newer context. An exact mutation retry
rechecks access and returns current grant state without applying another update;
divergent reuse of a mutation ID conflicts.

Updating to a different repository clears the previously disclosed label and
branch. Updating the same fingerprint can retain its already permitted metadata.
Old privacy work cannot repopulate metadata after an explicit snapshot update.
The grant version changes, so previously frozen recall authority must be checked
again. Source content, fidelity, consent, and Workspace selection are unchanged.
Assignment edits queue source work even when no Memory Event or LCM Summary has
changed. The Worker sends an encrypted context-only package with the same capture
cursor and a new package sequence. The source records the context hash only after
the target acknowledges readiness. If another edit happened while that package
was in flight, acknowledgement queues a bounded follow-up for the current context.
Receiving that context changes the owner-private replica, not an existing Team
snapshot.

In Desktop, open the Captured Session's sharing controls and choose **Update
Project** for an active share. Desktop requests the latest received source
review, then uses the existing native approval and device Action Grant flow.
Approval rechecks that exact review before granting authority. The protected
request applies it to the same share and refreshes the persisted grant afterward.
A stale review shows the existing reload error; it is not automatically replaced
with a new target. Personal Notes do not have this action.

## Concept boundaries

On the Project integration branch, creation of a Share Grant records the
effective portable repository fingerprint or an unresolved classification.
Personal reassignment and later source captures do not retarget that snapshot.
The encrypted source artifact holds the label and branch for privacy review;
only sanitized values from the snapshot's original source revision can complete
its disclosed metadata. A nonportable override suppresses the automatic
repository entirely. See [Team Project snapshots](repository-recall.md#team-project-snapshots).

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
| Activate a direct Pending Share   | Complete the accepted share asynchronously             | Start sync only after acceptance; reproduce the complete ordered candidate manifest; stage an unreadable representation; resolve the deterministic companion; publish representation, grant, companion, and Pending Share atomically                                                                                                                                 | Worker restart reuses durable identities; companion failures remain quarantined and repairable without owner-list side effects                                                                                                 |
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

## Team Global recall

Global questions use the selected Workspace and its authorized Share Grants.
Repository preferences classify each source from the recorded Team snapshot.
Moving a Personal Session leaves those results unchanged until the owner applies
Update Project. A matching repository never supplies access or selects a Workspace.
Permitted Project labels and comparable branch observations come through the
representation disclosure policy. Unknown snapshots remain available to authorized
Global questions without a repository preference. See [repository recall](repository-recall.md)
for candidate budgets, bounded scoring, and the Project cutover release gate.

## Continuous Conversation rule controls (P2-02 backend checkpoint)

The repository supports owner-only pause, resume, stop and retry for one
continuous Conversation rule. Commands bind the exact rule, reason, Share Grant,
reviewed versions and mutation identity. A transaction increments rule, consent
and grant versions together. Repeating the same command returns current
authority without replaying a transition; changing its recorded intent fails.

Pause retains access to content already published through that reason. Stop
revokes that reason, while a separate direct snapshot can continue to authorize
its own published content. Owners can pause or stop after losing Workspace
sharing permission. Resume and retry require current Workspace sharing
permission, unexpired consent, the current enrolled publisher and current
Privacy policy. Failed validation rolls back the state and version changes.

Resume records catch-up on the rule and wakes the existing Privacy
materialization worker. The worker claims due rules in bounded batches, releases
claim locks, and prepares the currently eligible source through the existing
preview, Privacy and publication pipeline. It checks the captured authority
again before decrypting and publishing. A restart recovers from the persisted
deadline; a new source-sync event is not required. Completion schedules a later
source check so delayed summaries can be discovered. Unready sources and
temporary failures retain a retry deadline. Repeated failures appear in owner
metadata; automatic retries continue with a bounded delay. Pause and stop clear
the schedule, and obsolete preparation cannot overwrite a later control.

The Team API accepts a control at
`POST /v1/shared-memory/sharing-rules/:ruleId/control`. Its strict request binds
the rule, reason, Share Grant, Team, Workspace, requested action, mutation
identity and reviewed rule and grant versions. Device requests use the existing
Action Grant executor and its atomic execution receipt. Personal API Tokens and
devices without sharing-management scope cannot use the route.

The `shared_memory.rule_control` Action Grant intent requires native review.
Owner-only admission resolves the Conversation title, exact destination,
selected detail and current lifecycle state without preparing or publishing
source content. Resume and retry admission also require current sharing
permission, unexpired consent, an available publisher and the current Privacy
policy. Execution rechecks current authority in the transaction. A request for
the wrong destination fails before mutation, including on an exact retry.

Durable Desktop delivery, local pending-versus-acknowledged state, and owner
control buttons remain outstanding. API support does not complete P2-02.

## Companion and realtime authority across sharing reasons

A companion discussion is visible only while at least one exact published
representation remains permitted by a current sharing reason and the current
owner, Team and Workspace representation policies. A paused reason can preserve
its already published content and discussion history. Stopping that reason does
not remove access independently supplied by a snapshot or another rule.
Workspace membership and read or write access still apply to every discussion
operation.

Discussion creation, direct reads, messages, thread lists, event authorization
and replay use the same publication predicate. An existence check prevents
overlapping reasons from duplicating a thread in a bounded list. Representation
events bind the exact published representation and its event family; one
reason cannot authorize an event for another reason's revision. The narrow
owner-only Pending Share activation path remains separate from Team reads.

Stopping the last permitted reason emits a scope-bound revocation event so
clients remove cached Shared Memory. When another permitted publication remains,
the lifecycle event refreshes the retained entry instead. These events carry
structural resource identities; they do not disclose source content or private
sharing reasons.

## Curated Memory and Privacy isolation

Curated Memory reconciliation visits each active continuous sharing reason,
including rules attached to a snapshot grant. Rule preparation captures the
rule version, consent version, publisher fence and current Privacy policy.
Each reason keeps its own selection and consent binding. Once a pending rule
has its reason and grant binding, another reviewed rule may prepare on the same
grant. Uninitialized grant creation remains serialized.

Only a completed evidence check that finds no eligible Curated Memory can
invalidate that reason's Curated representation. The check and invalidation
share one transaction with current authority locks. Reconciliation triggered by
a Curated Memory edit inherits the edit transaction and its isolation level. A stale rule, lost
permission, paused consent or other preparation conflict does not prove that
retained evidence is ineligible. Invalidation removes semantic items only for
the affected consent.

Privacy completion updates the matching consent's pending operation and wakes
its activation work. A Privacy failure marks that operation as needing
attention without terminating pending work for another sharing reason on the
same grant.

## Concurrent policy edits and sharing work

Source owner, Team and Workspace policy edits lock the current policy version.
Before changing it, they try to lock the active consents and grants in that
scope without waiting. If publication or a sharing control holds one of those
rows, the edit returns a version conflict and rolls back. The owner can retry
against the current policy version after that work finishes. No policy audit,
consent pause or grant invalidation survives the rejected edit.

This prevents a policy edit from retaining a policy lock while waiting for
publication that must check that same policy. Preview admission also acquires
policy locks in the same order as preparation: source owner, Team, then
Workspace.

## Selected detail and the owner policy ceiling

Selected detail belongs to each consent. It may be narrower than the combined
owner, Team and Workspace representation-policy ceiling. Preparing or approving
a summary-only reason does not lower the source-wide owner ceiling, pause an
independent reason, or invalidate its published content.

A reviewed request for more detail can expand the owner ceiling. The expansion
keeps existing consents, their fixed source-revision limits and their immutable
policy/provenance bindings. Every read and continued publication still checks
that the current active owner ceiling in the same policy lineage covers the
entire retained approval. The original consent and rule continue to limit what
that reason can publish. A higher ceiling does not give a narrower reason
permission to publish more detail.

New reviews and new consents use the exact current policy or an exact reviewed
next-version proposal. A stale proposal cannot become a new approval. Continuing
an existing reason can keep its narrower approved policy binding while the
current ceiling permits it. Team and Workspace policy versions, current Privacy
policy, source identity, publisher authority and publication fences remain
required.

An explicit source-wide owner-policy change retains its existing restriction
behavior: it pauses affected active consents, invalidates their representations
and blocks obsolete queued publication. This differs from choosing the detail
of one new sharing reason.

Direct-share fidelity replacement changes the direct reason and invalidates
only its unsupported representations and semantic work. It preserves work
independently authorized by a rule. A rule-backed primary grant cannot be
silently converted into a direct share through that replacement operation.

The source artifact hash includes the selected detail, Curated Memory choice,
available source representations, activation representation and Snapshot or
Continuous mode. The preview hash includes the linked artifact identity while excluding only the
preview's own generated identity fields. Identical content under
different selected scopes cannot silently reuse the first request's routing
metadata. Loading an authoritative preview verifies the encrypted selection scope
against stored metadata before consent or publication proceeds.

## Whole-grant revocation and later direct sharing

Revoking a whole Share Grant stops every attached rule, revokes each attached
reason's consent, advances rule authority and publisher fences, and clears
scheduled catch-up in the same transaction. It also invalidates representations,
revokes attached Conversation Source Access and schedules existing retention
work. An exact revocation retry does not advance those versions again.

A later, separately approved direct share can restore the root grant. It does
not restore any stopped rule or revoked consent. Old queued preparations remain
unauthorized even if the caller supplies the current root version. Starting
continuous sharing again requires new reviewed authority. Stopping one rule is
the narrower operation described above and preserves independent reasons.

## Local delivery of approved rule controls

Desktop records an approved pause, resume, stop, or retry before it contacts the
Team Backend to execute that control. The local API stores the exact mutation,
request identity, versions, destination, and approved Action Grant in an encrypted
journal. It also encrypts the Conversation, Team, and Workspace labels from the
native review. Local status reads require the current Desktop credential and an
active enrollment. They work without a fresh Team capability response.

The local API drains queued controls at startup and every five seconds. Each
attempt checks the current Desktop owner, enrollment, device, and Team authority.
The worker sends the original request and Action Grant. It never substitutes
current versions or obtains broader approval. A temporary failure retains the
request for retry. Lease versions prevent an older worker from replacing a newer
result. Enrollment revocation clears credentials from queued records.

After a lost response, the same request can recover its committed Team receipt.
An expired Action Grant cannot execute a new control. The Team executor can
return its existing receipt after expiry. A confirmed receipt removes the local
copy of the Action Grant. A permanent authority failure also removes that copy
and requires a new review.

Desktop shows the current Team state separately from the local request. While a
stop waits for acknowledgment, Team access can remain. Local intent alone never
changes the displayed rule to stopped. An acknowledgment refreshes the owner
explanation and clears cached previews. A stop also invalidates cached Shared
Session authority. Other sharing reasons still determine current access.

The owner can inspect recent requests after a Desktop restart, including when
Team sharing lists are unavailable. That panel shows up to 100 recent rules.
Opening a share also reads its own delivery records. Native review still requires
Team access before the local API can accept a newly approved execution request.
A stop that starts before any online review remains part of the interruption
recovery work.

## Reviewed creation of a Conversation rule

The owner selects continuous sharing for one Conversation. The existing source
preview still determines the selected detail and content policy. A separate
creation review reads the current destination grant and Privacy policy. Native
approval binds the rule ID, source, destination, preview, consent, grant version,
and Privacy policy hash. The enrolled Personal device executes the approved
request and becomes the publisher.

The Team Backend accepts the request through the existing Pending Share workflow.
A separate creation record retains its reviewed rule authority. Several reasons
can use the same logical grant, so Pending Shares no longer require a unique
logical grant ID. Each request still has its own mutation and consent IDs.
Acceptance does not make Memory available to teammates.

After source preparation, one transaction activates the selected owner policy,
creates independent consent, and attaches the new rule reason. An existing
snapshot keeps its own consent, representations, and source revision limit.
A new grant becomes active with no published representation. The existing rule
and Privacy workers then prepare and publish content through the exact reason.
Pending Share activation waits for that reason's selected representation.

For an empty active rule grant, companion setup uses the owner-only Pending Share
staging path. It matches the pending operation, rule, consent, source, and
destination. Normal teammate discussion reads still require published Memory.
The owner view uses the attached grant ID and version even when its record is a
Pending Share. The form reads all metadata pages before it chooses rule controls.

After rule creation, later source revisions use rule catch-up. They do not make
the original Pending Share fail as a stale snapshot. Rule pause, stop, consent
expiry, publisher state, and publication versions still control each attempt.
Direct fidelity replacement excludes Pending Shares that create rules.
The older Pending Share pause and resume operations cannot change a rule's
consent. The owner uses the reviewed rule controls instead.

Desktop offers a separate continuous rule for an existing destination. The native
review explains that it includes later eligible turns and completed summaries.
Desktop first records the approved creation request in the same encrypted journal
that delivers rule controls. It retains the exact preview ID, mutation, request,
and approval credential. Receipt recovery does not need the preview cache.
A lost response replays the original request. The Team executor returns the
existing acceptance receipt without creating another Pending Share.

Before Desktop acknowledges creation, the local API persists source preparation
through the existing Pending Share source worker. A local storage failure keeps
the creation request queued for retry. A separate approved control can proceed
while creation receipt recovery waits. An exact mutation query keeps each
receipt visible even after later controls affect the same rule.

The initial Desktop result distinguishes a local request from Team acceptance.
After acknowledgment, the owner tracks source preparation and publication in
Shares. Creation acceptance never means that content is already available.
The complete creation journey and its interruption behavior still need validation.

## Git Anchor rule authority (P2-04 backend checkpoint)

`POST /v1/shared-memory/repository-rules/review` reviews the selected Git Anchor,
Workspace and permitted detail against current destination and Privacy policies.
The selector carries only the repository identity and, for a device-local Git
Anchor, its originating device. Local paths and private Project metadata are
not accepted in this descriptor.

`shared_memory.repository_rule_create` is a separate Action Grant operation.
Its native review explicitly approves existing and future matching
Conversations. The exact request binds the selector, destination, detail,
Curated Memory choice, policy versions and hashes, completed review hash and
Personal snapshot version. Memory Events require step-up approval.

`POST /v1/shared-memory/repository-rules` executes that approved operation
atomically for the enrolled publisher. It checks the original confirmation and
request hashes and stores the selector and approval context under owner-private
encryption. The original decision time is retained so delayed execution cannot
stand in for approval of a later source-owner policy restriction. A repeated
creation returns its original receipt and cannot change the rule's intent.

Creation establishes the rule authority only. Each source still requires
verified membership, its own reason and consent, and the existing Pending Share
and Privacy processing before publication.

The local native commands review the completed Personal handoff before approval
and queue approved creation in the existing encrypted sharing-rule journal.
The full Personal target stays local; the Team request carries only the minimal
selector descriptor. The delivery worker verifies the exact Team rule receipt.
An approved queued request can recover that receipt after its observation
cursor expires. This does not renew publication authority or install a source
membership baseline.

After the creation receipt is acknowledged, the same local transaction seeds
an encrypted membership journal bound to that enrollment and rule. The existing
delivery worker consumes one bounded phase at a time: enumerate all pages,
stage present sources, evaluate missing known sources, then install the complete
baseline. Until that final transaction, source delivery sees only the previous
complete baseline. Failed or expired enumeration discards the proposal without
removing installed members. Missing or unavailable source data cannot prove a
removal; only an explicit deletion or confirmed selector mismatch can do so.

The journal retains exact outstanding requests across newer membership goals.
An acknowledgment completes only the goal that request carried. Enrollment
revocation fences leases and removes the encrypted progress and source payloads.
The delivery worker now consumes committed source goals. Before a new admission,
it checks the current native Session, logical Session, selected Git Anchor and
Git context version. A receiving replica cannot become a new source origin.
Unavailable or unverified sources wait for a later reconciliation. The worker
uses the existing direct candidate-preview Action Grant and queues the existing
Pending Share source work after acceptance. Publication still requires Privacy
processing. Matching members can refresh context; confirmed mismatches remove
only this rule's reason, including while the rule is paused.

Each source write is encrypted in the local journal before it is sent. A newer
membership goal cannot replace a request whose remote outcome is unknown.
`POST /v1/shared-memory/repository-rules/{ruleId}/members/cancel-mutation`
settles one exact request for the current authenticated publisher. It holds the
same mutation lock as admission, context refresh and removal. An accepted write
returns its original receipt. Otherwise, a retained private audit record prevents
that exact request from executing later. This permits a safe retry with a fresh
candidate after an expired preview without changing other members or the rule's
authority version. If settlement is unavailable, the original request remains
queued.

The Desktop review offers **Share existing and future Memory** only after all
review pages finish. Creation uses native approval and the encrypted delivery
journal. The dialog lists the owner's rules for this exact Git Anchor, including
rules that have no members. It shows queued requests until Team acknowledgment;
an accepted creation receipt does not mean its Conversations are published.

`POST /v1/shared-memory/repository-rules/{ruleId}/control` applies native-reviewed
pause, resume, stop or catch-up retry to the parent rule. The request binds its
destination, authority version and publisher fence. Pause stops new members and
revisions while retaining existing publications. Sources that stop matching can
still lose this rule's reason while paused. Resume requires the recorded
publisher and the approved destination policies to remain available. Pause and
stop remain available when that publisher is unavailable.

Stop ends the parent authority immediately. The existing worker then cleans up
members in bounded batches, taking each source's root lock before its parent
lock. It revokes only this rule's consent, cancels its Pending Share work, removes
its preparations and invalidates its representations and semantic items.
Independent sharing reasons retain their permitted access. A stopped rule cannot
resume or admit future members.

Local delivery tracks a work epoch after each acknowledged group control. This
is retry bookkeeping, not Team authority. A delayed source receipt completes
only its original goal and epoch, so it cannot clear catch-up work requested by a
newer resume. Group-control and full publication journeys still require runtime
validation before P2-04 is complete.

`POST /v1/shared-memory/repository-rules/{ruleId}/members` accepts a source from
the authenticated current publisher under the stored rule authority. The
request cannot choose its publisher credential or supply a substitute Action
Grant. It supplies exact source, destination, member and rule versions plus
the current Personal selection evidence. The backend returns an immutable
acceptance receipt and queues the existing Pending Share and Privacy workflow.
Acceptance alone does not make Memory visible to the Team.

The worker rechecks the rule, publisher, member and owner policy before creating
the member's consent reason. A later explicit owner restriction requires fresh
approval before expansion; activating a ceiling for another consent is not
itself a restrictive policy edit. Existing direct and other rule reasons retain
their own consent. Removal cancels only the member's Pending Share operations
and reason. An owner cancellation before activation records a veto against
automatic re-admission. Rule controls and member changes lock the source and
grant before the rule, member and Pending Share rows.

The current publisher can inspect at most 100 exact source identities through
`POST /v1/shared-memory/repository-rules/{ruleId}/members/inspect`. The response
contains current rule, member and destination grant versions plus the latest
member admission state. It contains no private selector payload or source
content. These versions are optimistic checks; every mutation rechecks them.

The member `context` operation refreshes evidence that an existing source still
matches. It advances the member version and retains the consent. While paused,
it records that evidence without scheduling publication. The member `remove`
operation applies conclusive loss of eligibility, including while paused, and
revokes only this rule's reason. Both bind the authenticated publisher and exact
rule/member identities. Their mutation receipts are immutable: a late receipt
describes the original operation and must not replace a newer local desired
state.

## Exact Folder continuous sharing (P2-05)

The owner opens an exact Folder in Personal Memory, reviews its eligible and
unresolved Conversations, and explicitly approves existing and future members.
The selected Folder is the full Personal Folder reference, including originating
deployment, device, profile and directory incarnation. A parent, subfolder,
replacement directory, or equal path on another device is a different selection.
The workflow does not inspect the filesystem or infer membership from a path.

Folder review uses the same bounded enumeration, completed-review handoff,
native approval and encrypted local delivery as Git Anchor sharing. The local
review can display the Folder path from Personal metadata. The Team request
contains only `selector: { kind: "folder", key: <opaque digest> }`; it contains
neither the Folder reference nor its path, name or private membership structure.
The descriptor binds the full reference. Changing its device, profile,
deployment or directory incarnation invalidates the completed local review.
A Folder does not become a Team collection or organization node.

The existing selection-rule operations under `/v1/shared-memory/repository-rules`
handle both selector kinds. Each admitted member carries its exact Git and
Folder context versions, source-context hash, selection snapshot, parent
version and publisher fence. Native source verification checks both context
versions before preparation. A stale Folder correction cannot overwrite a
newer membership. Complete baselines and conclusive known-member evaluation
use the Personal Folder assignment axis; unavailable or unresolved context
retains membership rather than proving removal.

Publication reuses Pending Share and Privacy processing. Pause, resume, retry
and stop apply to the entire Folder rule. Leaving the Folder revokes only that
rule's reason, including while paused; independent direct, Git Anchor and other
reasons retain their permitted content. The owner explanation identifies a
Folder rule and routes its controls through whole-rule native approval. Owner
responses include selector kind, but Team read responses do not expose owner
reason metadata. Separately approved Conversation Source Access remains
independent.

## Private Project continuous sharing (P2-06)

The owner opens a Personal Project and reviews sharing with one Workspace.
The Personal inventory supplies an owned Project reference; the renderer does
not infer its owner from a display name or a source path. Review, native
approval, local delivery, Privacy processing and lifecycle controls reuse the
selection-rule workflow. Approval covers existing and future Project members,
including later direct inclusions and Git Anchor or exact Folder rules.

The Team descriptor contains `kind: "project"` and an opaque digest of the
owned reference. Project names, inclusion identities and private organization
remain local. The Project name may appear in the Personal review dialog, but
that display value is not part of a Team request. Contributions keep their
separately approved source context. Sharing creates no Team collection.

The publisher merges all bounded inclusion-reason entries for each source.
Removing one inclusion leaves the Project reason present while another
inclusion still selects that Conversation. Direct inclusion changes never
rewrite the source's recorded Git or Folder context. Project exclusion ends
only that Project's reason. It does not perform a Workspace exclusion or change
another Project, a standalone selector, or direct sharing.

Missing members require conclusive evaluation against the completed, unchanged
Project checkpoint. Pending or conflicted membership state, unmaterialized
inclusions, unavailable source bodies, or unresolved context needed by a rule
retain an unresolved goal. A known direct inclusion can still prove membership
without Git or Folder facts. Explicit Project exclusion overrides its inclusions.
Known-member evidence carries both context versions and a private context hash;
neither the Project name nor its membership structure crosses the Team boundary.

The sharing consumer can observe a retained, confirmed Project tombstone as an
empty selection and remove known members through the normal reason-specific
workflow. This is an internal consumer option. Public Personal enumeration still
returns the existing unavailable-Project error, and an unavailable or conflicted
catalog cannot become deletion evidence. Parent authority and current member
versions continue to fence publication, removal and cached expansion.

Several independent reasons can publish the same source revision in separate
representation records. Semantic recall keeps those record identities distinct
until hydration rechecks the currently authorized representation. Deduplicating
them by source alone could discard the selected record and hide content that
the owner still permits through another reason.

## Adding a destination (P2-07)

“Share with another Workspace” starts a fresh continuous sharing review. It
selects an unshared writable Workspace when one is available. The owner can
choose another destination and review its own detail and policy before approval.
Opening that review does not change existing grants, pending publication, or
paused and stopped rules. A new destination does not resume another destination.

Each destination retains its own rule authority, consent, detail and publication
progress. A publication denial at one Workspace leaves another eligible
Workspace able to catch up. Restoring permission and retrying the denied rule
affects that destination only. Stopping a rule preserves any independent
snapshot in its Workspace and leaves other destinations' access unchanged.

## Change a rule’s shared detail (P2-08)

The review binds a proposed rule cap to the current rule version,
publisher fence, destination policy and Privacy hashes, and a digest of current
member, consent, grant and owner-policy versions. Private member identities
contribute to the digest without being returned as Team organization metadata.
The review records the previous detail, proposed detail and lifecycle separately. A detail-only amendment requires the rule's existing Privacy policy binding
to remain current. It cannot adopt a changed content policy through the detail
confirmation. Content-policy adoption requires the separate P2-09 review.
It also counts owner-policy expansions. A nominal rule reduction can still
broaden permission relative to a newer, narrower owner policy; the review
classifies that effect as an increase and asks for explicit confirmation.

Migration 0063 introduces a publication-bound read projection for rule reasons.
It retains the policy and source-revision bindings of each existing publication
while current consent and rule caps continue to gate access. New-work authority
continues to use the current consent. Direct reasons retain their existing
consent-policy equality checks. Read, semantic indexing, recall, expansion and
companion authorization use the publication projection before disclosing data.
The projection binds each publication to one exact source revision. Its base
representation row and source binding are reused by direct reads, avoiding
repeated expansion of the same source-binding view during query planning.
Ordinary direct reads select publications for the requested Share Grant before
joining the remaining authorization gates. Locked mutation reviews retain their
existing row-lock propagation. Semantic indexing, search, reuse and expansion
also bound the publication lookup to each selected representation. Grant-locked
hydration keeps its original relation and lock propagation.

The Team mutation rechecks the review under source, grant and rule locks. It
preserves lifecycle, updates this rule's consent caps and versions, queues active
members for reprocessing and stores an exact completed-operation receipt.
Reviewed owner-cap expansions preserve independent approvals. Selector authority
keeps its original creation intent alongside the accepted amended scope.

The protected Team review and mutation endpoints and native action definition
are connected. The encrypted local journal can retain an accepted scope and
advance its delivery epoch without losing a pending exact request. Delivery
inspection can adopt a newer authenticated accepted scope after checking exact
selector, destination and source identity. It renews the lease before preparing
content under that scope. Migration 0064 permits encrypted detail-amendment
requests in the existing durable delivery queue. Acknowledgment retains the
exact accepted review and receipt and advances the local publisher's scope in
the same transaction.

Desktop exposes **Change rule detail** from an owner sharing explanation and
from a selector's rule list. The review describes the whole rule, its current
lifecycle, member count and any owner-policy expansion. Confirmation uses native
approval. Queued changes remain visible until Team acknowledgment. Accepted
changes clear cached Team views before reloading their current authority.

For an initialized rule whose original Share is still preparing, completion
checks the current consent's representation instead of the original request's
detail. An unresolved selector admission retains its immutable evidence. The
publisher adopts the new scope and re-admits that source through the existing
versioned replacement path; obsolete admission work cannot activate under the
new rule version. Paused rules wait for an explicit resume before new admission.
Local acceptance is recorded in the [P2-08 validation record](team-continuous-sharing-validation.md#p2-08-local-acceptance).
The combined native package journey remains open.

## Rule content policy under implementation (P2-09)

A rule's content policy will add Privacy redaction requirements under the
current owner, Team and Workspace constraints. It cannot relax those enclosing
requirements. This uses the existing Privacy categories; it is an implementation
choice for P2-09, not an additional domain collection or a named Team policy.

The shared review and receipt contracts bind proposed categories, enclosing
requirements, effective categories, prior approval and authority versions.
Unknown prior effective categories require confirmation as increased disclosure.
Policy identity follows the selected content requirements and global binding;
authority versions separately fence work. Returning to the same approved policy
can therefore retain its exact older publication without admitting a newer
source revision. A global-only rule starts with no additional categories and no
separate content-policy amendment. A reviewed amendment records its policy
version and effective approval snapshot.

Storage and contracts are in place. Rule-specific Privacy resolution now binds
direct reads, publication commits, detail reviews, member admission checks and
semantic hydration to one rule. Read-policy caches include that rule, so one
reason cannot supply another reason's policy. Pending Privacy work selects a
reason whose approved and current effective policy matches its exact derivative.
The worker receives that reason's added categories and rechecks the enclosing
policy before masking. Classification spans remain separate from policy-specific
masked content.

Scheduling keeps separate derivatives for each preview and effective policy.
Policy invalidation considers every currently authorized reason and retains a
derivative while any one reason permits its whole policy. Paused Privacy work is
limited to exact previews already published by the same reason.

The repository can now produce an owner-scoped content-policy review. It binds
current destination and member authority, the proposed categories and any
increase in disclosure. It reads the current detail limits without proposing
an expansion of those limits. The amendment transaction implementation rejects
changed reviews, retains lifecycle and publisher authority, advances processing
versions and records an idempotent receipt. It does not change fidelity policies
or their approval timestamps. The repository write path now retains an encrypted
content-policy approval beside creation and detail approvals. Future selector
authority uses the latest policy bindings while retaining the original or latest
detail approval time for fidelity checks.

The HTTP review and write routes now use the same exact content-policy intent.
The native approval definition refreshes the complete review before issuing an
Action Grant. Its confirmation shows previous, required, added and effective
redaction categories. The write requires a device credential and a grant bound
to the complete reviewed request; API Tokens cannot submit this amendment.

Desktop review and amendment commands now use the content-policy intent. The
encrypted delivery queue validates the exact receipt before acknowledgment and
records it beside the separate detail receipt. Recording either scope advances
the processing version, so older work must renew its authority. A selector can
recover an approval made on another device from an authenticated rule inspection.

The owner-facing editor is available from Conversation and selector rule
controls. It loads the current added categories before editing, keeps required
categories enabled and shows previous and proposed effective redaction in a
separate review. Changed categories and expired reviews require another review.
Confirmation then opens native approval and records the delivery request.

Returning to an earlier policy can now requeue its exact derivative after policy
or authority supersession. Explicit material invalidations stay invalidated.
The worker can reuse classification spans for unchanged source and classifier
bindings, then produce a fresh sanitized payload. A content amendment releases
old processing leases, including when the content policy later returns to the
same hash.

Historical publication and restoration are connected in the source worktree and
await runtime acceptance. This section is not P2-09 acceptance evidence.

Historical preparation now has a storage link to the exact original publication.
Its source proof checks the revision, representation and content hashes when
policy bindings change. The owned-publication reader checks current permissions
for the individual representation, so a lower current detail limit can still
permit an already-published LCM Rollup. The repository preparation method now
rebuilds a private artifact from that exact body under current eligible policy
bindings. It preserves revision, manifest and source-device provenance, and
records the original publication as its lineage. The rule worker prepares this
bounded history before normal active-source work. Privacy processing and final
publication use current prepared policy bindings only after checking that
lineage and its versions. Historical materialization can retain a paused state;
the ordinary publication path continues to require an active rule.

A current detail-policy reduction can also make the shared grant unavailable.
After native content-policy approval, exact retained history can recover that
availability only when final publication passes current permissions. The rule
and its consent keep their paused state. Pending approval and remediation flows
must finish through their own controls.

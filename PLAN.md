# Plan: Unify selective PII protection and typed asynchronous Team sharing

## Outcome

Resolve the merge by producing one coherent Team-sharing system rather than
preserving two parallel workflows. Captured Sessions and Personal Notes enter
the same durable Pending Share lifecycle. They differ only in how Koed verifies
and prepares exact owner material. All Team-visible material passes through the
same privacy, authorization, encryption, publication, and lifecycle boundaries.

The incoming selective-PII work is the authority for privacy and fidelity. The
branch's typed-source and asynchronous-sharing work is re-expressed on top of
that authority instead of retaining its direct materialization path.

## Deliverables that must survive the merge

### Incoming `main`

- Exact Personal source and derived artifacts remain full fidelity and
  owner-only.
- Team-readable semantic representations and Conversation Source are sanitized
  independently before decryptable egress.
- Privacy classification is local, versioned, provenance-bound, encrypted, and
  fail-closed.
- Privacy outages defer Team materialization without blocking Personal capture,
  Projection, Recall, or LCM work.
- Consent uses a cumulative maximum-fidelity ceiling plus a separate Curated
  Memory choice.
- Sanitized Team embeddings reuse Personal computation only when the final
  embedding input is byte-identical and authorized.
- Hosted Personal semantic authority and retry scheduling remain intact.

### Current branch

- A durable Pending Share is visible immediately after owner acceptance.
- Source preparation, retry, activation, replacement, revocation, and owner
  history remain restart-safe and idempotent.
- Sharing supports typed sources rather than assuming every share starts from a
  Captured Session.
- A Personal Note can be shared as one immutable Memory Event snapshot without
  creating a Cross-Identity Sync relationship or replica.
- Share naming and the owner-facing share workflow remain available.
- Interactive and background embedding work retain appropriate request bounds.
- Unrelated Personal Ask, Notes, Welcome, and Desktop changes remain untouched
  except where their sharing contracts must adopt the unified model.

## Canonical Share Intent

Every preview, approval, Action Grant, command, replay check, and durable
operation binds the same intent:

- source identity;
- source owner;
- the reviewed source-capability set;
- Team and Workspace destination;
- snapshot or continuous mode;
- maximum fidelity;
- whether Curated Memory is included;
- the concrete activation representation;
- preview revision and hash;
- expiry;
- authority reference;
- mutation and logical-grant identities.

`allowedRepresentations`, `selectedRepresentation`, and `candidateSessionId`
are removed. `activationRepresentation` names the concrete layer the owner
reviewed and the operation must publish before initial activation. It is bound
into the candidate hash, preview hash, Action Grant, command, replay checks, and
Pending Share. It is not a second consent model alongside maximum fidelity, and
it must be permitted by the effective layer set.

The source reference is required for new operations:

- A Captured Session binds its session and logical Memory identity.
- A Personal Note binds its Note, projected Memory Event, and logical Memory
  identity.

All canonical request and scope hashes include source identity, reviewed source
capabilities, fidelity consent, and activation representation. Reusing a
mutation or Action Grant with different source capabilities, source, fidelity,
Curated Memory choice, activation representation, destination, or preview fails
closed.

## Collaboration protocol cutover

Both merge parents independently use collaboration contract version 4 for
incompatible envelopes. The combined typed-source and fidelity contract is
version 5. Backend capabilities, local-edge commands, Desktop requests,
persisted projection envelopes, and fixtures advertise and require v5.

There is no permissive v4 parser or shape inference. A v4/v5 mismatch is
rejected before intent or authority data is consumed and is reported with a
bounded protocol error. Contract tests exercise backend-newer, edge-newer, and
stale persisted-envelope cases.

## Source strategy boundary

Use one small source-strategy boundary to isolate the real differences between
source kinds. A source strategy may:

- validate source-specific mode and fidelity restrictions;
- prove current ownership and source identity;
- declare the representation layers the source can truthfully produce;
- determine whether source preparation is ready;
- reproduce the complete reviewed manifest;
- construct the canonical exact source artifact and provenance binding.

A source strategy may not grant Workspace access, choose privacy policy, create
Team representations, publish vectors, or own lifecycle transitions.

### Captured Session strategy

- Requires the exact owner-private replica and Cross-Identity Sync provenance.
- Supports snapshot and continuous sharing.
- Supports the cumulative fidelity ceiling and separately authorized Curated
  Memory.
- Declares the layers its source kind and provenance contract can truthfully
  produce. Current artifact readiness is tracked separately, so a permitted
  derived layer may materialize later without delaying activation.
- May wait for the reviewed source revision to finish synchronization.

### Personal Note strategy

- Requires the owner-authored Note and its projected Memory Event.
- Requires snapshot mode, source revision 1, exactly one manifest item,
  `maximumFidelity=memory_events`, and `includeCuratedMemory=false`.
- Declares source capabilities as exactly `{memory_events}`.
- Produces a standalone encrypted owner artifact.
- Creates no replica or Cross-Identity Sync relationship.
- Does not support Conversation Source Access or fidelity replacement.

## One Pending Share lifecycle

Every accepted share creates a durable Pending Share, even when its source is
already available. Ready sources may pass through preparation quickly, but they
do not use a separate synchronous grant path.

The owner-facing lifecycle remains small:

- `preparing`;
- `needs_attention`;
- `failed` for deterministic terminal failures;
- `activated`;
- `revoked`.

The processing phase explains progress without becoming a second lifecycle:

1. `accepted`
2. `source_preparing`
3. `privacy_filtering`
4. `publishing`
5. `complete`

Transient source, Privacy Service, and Embedding Service failures persist retry
state and the next eligible attempt. Deterministic contract, provenance,
schema, or authority failures fail closed. Workspace access is `none` until a
complete sanitized representation and companion scope are published.

For an ordinary fidelity replacement under unchanged authority, consent,
content policy, classifier safety, and provenance, the existing active
representation remains readable while the replacement follows the same
preparation, privacy, and publication phases. Publication switches authority
atomically. A transient or ordinary replacement failure never widens access or
removes the last valid representation.

That continuity rule never preserves safety-stale material. Loss of access or
authority, consent expiry or revocation, policy invalidation, classifier safety
invalidation, or invalid provenance withdraws the affected protected material
immediately. It remains unavailable until a currently authorized, compliant
representation is published.

## Privacy and materialization pipeline

The generic pipeline consumes the canonical exact source artifact produced by a
source strategy:

1. Persist the owner-private exact artifact and preview binding.
2. Create a privacy target bound to source revision, manifest, classifier
   generation, and effective content-policy hash.
3. Extract every supported semantic string field using the schema-aware
   contract.
4. Reuse encrypted classification spans when their complete input and
   classifier binding match; otherwise call the pinned Privacy Service.
5. Apply deterministic secret detection and the effective content policy.
6. Persist a separately encrypted sanitized preview with complete provenance.
7. Materialize the authorized activation representation from that sanitized
   preview.
8. Create or reuse an authorized embedding for its final sanitized input.
9. Publish the activation representation, Share Grant, required companion
   scope, lifecycle event, and Workspace visibility at the repository
   transaction seam.
10. Materialize other effective layers independently when their complete,
    provenance-valid source artifacts exist; their absence does not delay
    initial activation or authorize fallback to a finer layer.

There is no direct Personal Note materialization shortcut. There is no fallback
from a missing sanitized derivative to owner-private source. Exact source may
never be encrypted with the Team key or appear in Team rows, vectors, evidence,
exports, responses, logs, or failure diagnostics.

## Fidelity model

Maximum fidelity is cumulative:

- `lcm_rollups` permits rollups only;
- `lcm_leaves` permits complete leaves and rollups;
- `memory_events` permits Memory Events, complete leaves, and complete rollups.

Curated Memory remains a separate boolean consent. Conversation Source Access
remains a separate capability and cannot be inferred from semantic fidelity.
Absence of a permitted derived layer never authorizes fallback to a finer layer.

The layers an operation may materialize are the intersection of:

1. the representation capabilities of the reviewed source revision;
2. the layers permitted by the owner's cumulative consent ceiling; and
3. current Team and Workspace policy ceilings.

The activation representation is one concrete member of that effective set. It
is the layer rendered for owner review and required for initial activation.
Other effective layers may materialize independently later. A Personal Note's
`{memory_events}` source capability therefore cannot yield LCM leaves or
rollups, even though its required consent ceiling is `memory_events`.

## Authority and policy revalidation

One canonical resolver computes effective authority and layer eligibility, but
its result is not trusted forever. The repository re-resolves current access,
consent, source capabilities, Team and Workspace policy, classifier safety, and
provenance at acceptance, durable claim, publication, every continuous
frontier, and every protected read, expansion, or export. Stored hashes and
versions prove what was evaluated; they do not replace current-state checks.

An Action Grant must be valid when acceptance creates the durable operation.
Its later expiry does not normally cancel that accepted operation. The durable
consent and Share authority remain independently live: expiry or revocation
before publication stops publication, and loss after publication immediately
withdraws protected access. A stricter policy or safety decision never waits
for replacement materialization before removing the invalid representation.

## Transaction and orchestration ownership

The Shared Memory repository remains the authority for state transitions,
authorization rechecks, optimistic versions, publication, audit, and outbox
writes. Pure transition decisions and source-specific validation may be
extracted to reduce the size of repository methods, but they do not write state
or become a second workflow owner.

The local edge remains a protocol adapter. It validates exact remote envelopes,
persists the authoritative projection, and retries idempotently. It does not
reconstruct policy or materialization state from renderer input.

Workers perform source preparation, privacy classification, and embedding work
under durable repository claims. They do not publish Team access independently
of the repository transaction.

## Hash and encryption vocabulary

- `sourceHash` binds logical source revision and provenance.
- `sourceContentHash` hashes canonical exact owner content.
- `sanitizedContentHash` hashes the final Team-safe content.
- Classifier and effective privacy-policy hashes bind how sanitization was
  produced.
- The embedding-input hash binds the exact final text sent for embedding.

Personal classification results, owner-private source artifacts, sanitized
Team artifacts, and Team representations use their intended distinct encryption
boundaries. Equality or cache lookup must not become a cross-owner or cross-Team
correlation oracle.

## Migration resolution

Restore `0033_fixed_scarlet_witch.sql` byte-for-byte from incoming `main`. The
branch-only final-newline change alters its checksum and is not part of this
merge's deliverables.

Preserve incoming `0034_young_silvermane` as the immutable `main` privacy
migration. Do not hand-merge it with the branch migration.

Remove the incompatible branch `0034_broken_morlocks` from the final lineage and
generate a new `0035` against the merged privacy schema. The new migration
contains only the branch delta required for typed sources, Personal Notes,
Personal Ask state, and their updated constraints. It must use fidelity columns
rather than columns removed by incoming `0034`.

Regenerate the Drizzle snapshot and journal mechanically. Migration validation
must cover a blank database, the `0033` boundary followed by `0034` and `0035`,
and the documented internal-alpha treatment of pre-existing unsanitized Team
sharing rows. Correct the selective-PII ADR to identify `0034`, not `0030`, as
the internal-alpha migration it describes.

## Desktop and approval behavior

- Captured Session sharing lets the owner choose maximum fidelity, Curated
  Memory, mode, destination, and Share name.
- Personal Note sharing fixes the consent to Memory Events, no Curated Memory,
  and snapshot mode; those controls are not presented as mutable options.
- Acceptance returns a Pending Share and displays its current phase.
- Team readers see nothing until activation.
- Increasing fidelity or enabling Curated Memory requires step-up review;
  reducing fidelity uses native review.
- An ordinary replacement explains that the prior representation stays
  available until the new sanitized representation is ready, while safety or
  authority invalidation explains its immediate withdrawal.
- Privacy errors use safe lifecycle codes and never echo source content.

## Conversation Source Access

Conversation Source Access remains separately granted for Captured Sessions.
Manifest, segment, stream, and fork-snapshot reads use sanitized Conversation
Source artifacts and their own authorization checks. Semantic Share Grants do
not imply source access. Personal Notes cannot receive Conversation Source
Access.

During an ordinary continuous update under unchanged authority and safety
policy, the last complete sanitized frontier remains available while a later
frontier is classified. A failed or incomplete append does not expose exact
source or partially publish a generation. Access, consent, policy, classifier
safety, or provenance invalidation withdraws the affected frontier immediately.

## Validation matrix

The merge is complete only when tests cover these intersections:

- Captured Session and Personal Note sources.
- Snapshot and continuous modes, with Personal Notes rejected for continuous.
- Rollup, leaf, and Memory Event fidelity ceilings.
- Curated Memory disabled and enabled where supported.
- No detected private data, contextual PII replacement, deterministic secret
  replacement, and schema-key rejection.
- Privacy outage, malformed classifier response, retry, and policy-only remask.
- Contract-v5 negotiation and fail-closed v4/v5 backend, local-edge, Desktop,
  fixture, and persisted-envelope incompatibility.
- New share, replacement, pause, resume, rename, revoke, restart, stale source,
  and concurrent mutation replay.
- Action Grant expiry after acceptance; consent expiry before publication; and
  access, policy, classifier, or provenance invalidation before and after
  publication.
- Revalidation races during source preparation, privacy filtering, embedding,
  publication, continuous frontier advancement, protected reads, and exports.
- Personal embedding reuse, changed-input Team embedding, hosted authority,
  interactive priority, background request bounds, and retry scheduling.
- Separate Conversation Source consent, snapshot, continuous append, stream,
  and fork export.
- No Workspace access before publication and no owner plaintext in any
  Team-visible surface or telemetry.
- Migration smoke, formatting, linting, typechecking, focused package tests,
  Electron interaction validation, deterministic Team fixture validation, and
  the full CI-equivalent suite.

## Implementation sequence

Work the dependency frontier described in `tickets.md`. The merge integration
branch is allowed to remain temporarily non-green while the wide contract
cutover is in progress; individual tickets must still leave their scoped tests
passing. The final integration ticket owns removal of compatibility remnants,
generated artifacts, documentation consistency, and the complete green build.

## Implementation outcome

The merge now implements this design. Captured Sessions and Personal Notes use
one typed Pending Share workflow. The active contract no longer exposes the
retired direct-consent, direct-materialization, or representation-change
routes. Personal Notes use the same privacy pipeline without creating a replica
or Cross-Identity Sync relationship. Fidelity replacement also uses Pending
Share processing.

Migration `0034_young_silvermane` remains the selective-PII baseline. Generated
migration `0035_concerned_the_twelve` adds the typed-source delta. Migration
acceptance passed all nine blank, boundary, historical, idempotency, and
rollback scenarios.

Validation covered both source kinds and the merged privacy boundary:

- all 77 live Shared Memory repository tests passed on a clean database;
- the API, Worker, Shared, Desktop, MCP Server, Koed Server, Privacy Service,
  Embedding Service, Core, Memory UI, and UI suites passed;
- the Electron interaction harness passed the Personal Note and Captured
  Session sharing flows;
- a clean deterministic Team fixture seeded and validated 7 Users, 3
  Workspaces, 14 memories, and 6 collaboration threads;
- formatting for merge-owned files, linting, and typechecking passed.

On macOS, the eval security tests must use `TMPDIR=/private/tmp`. The default
temporary path resolves through `/var`, which those tests correctly reject as a
symlink component. With the canonical temporary path, all 63 active eval test
files and 502 tests passed.

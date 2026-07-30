# Symmetric Replicated Personal Memory Across Devices

Status: Accepted.

Related decisions:

- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0009 Commercial SaaS Encryption And Key Management](./0009-commercial-saas-encryption-key-management.md)
- [0010 Managed SaaS Queryable Vector Boundary](./0010-managed-saas-queryable-vectors.md)
- [0020 Portable Personal Derived Artifact Replication](./0020-portable-personal-derived-artifact-replication.md)
- [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md)

Related planning and foundations:

- KOE-218: Explorer-first auth and device enrollment design.
- KOE-219: privacy-conscious Project metadata discovery and matching signals.
- KOE-257: revocable device credentials.
- KOE-259: local-edge routing.
- KOE-264: Cross-Identity Sync and Offload persistence design.
- KOE-338 and PR #290: implemented directed hosted Cross-Identity Sync
  baseline.
- KOE-269: headless setup and remote pairing.
- KOE-317: bounded historical AI-client session import.

## Context

A User may run agents on several personal devices. One example is a laptop
running Koed Desktop and a home desktop running a headless `koed-server` over an
SSH-accessible private network. The User expects Personal Memory captured on
either device to become available on both without manually importing sessions,
copying API Tokens, selecting Team Workspaces, or deciding permanently that one
machine owns all Personal Memory.

The current local-first model gives each `koed-server` its own Personal Memory
store. Desktop manages its local personal `koed-server`; remote/private/cloud
backends are connect-only from Desktop's perspective. Existing directed
local-personal-to-hosted Cross-Identity Sync/offload work provides logical
memory, replica, encrypted package, outbox, inbox, cursor, idempotency, retry,
and readiness foundations. It does not implement personal multi-device
replication, and its directed identity, recipient-key, package-closure, and
deletion protocols are not Personal Device Sync protocols.

Project metadata can help associate local code contexts, but it cannot prove
User or device identity. Local paths, Git common-directory hashes, and checkout
ids are device-local. Normalized Git remote aliases are matching evidence only.
None of these signals may grant Team Membership, Workspace Access, create a
Share Grant, select a Team Workspace, or enroll a device.

A simple design would designate one device or deployment as a Personal Hub. All
other devices would synchronize to that Hub, and the Hub would own aggregate
indexing and recall. This is a viable alternative and materially simpler, but it
privileges one device, makes aggregate availability depend on that device, and
creates a migration problem when the User wants another device to become the
Hub.

The decision needed here is whether Personal Memory should instead be
replicated symmetrically between trusted personal devices while preserving
local-first capture and avoiding general multi-primary database replication.

## Decision

Koed uses **symmetric replicated Personal Memory** for trusted devices
associated with one **Local Personal Identity**. This is one user-facing
personal profile across devices, not a set of locally selectable Users.

V1 is frozen by [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md):
relay-required full replication of future closed Captured Sessions; Ed25519
signatures; X25519/HKDF-SHA-256/AES-256-GCM recipient envelopes with
role-separated keys; active-device or recovery-root authorization plus Authority
countersignature; conflict quarantine; current protocol version only; bounded
relay/tombstone retention; compatible portable LCM node reuse; and only one
unambiguous canonical Project alias auto-match. That normative specification
controls where this ADR's earlier exploratory language differs.

The V1 replication model is a relay-assisted, source-owned replicated log of
immutable Captured Session packages and explicitly allowlisted portable
Personal artifacts:

- No personal device is the permanent plaintext or source-of-truth Personal
  Memory authority.
- Every associated device remains a normal local `koed-server` and can capture,
  project, embed, inspect, and recall Personal Memory locally.
- V1 replicates closed Captured Sessions. Each Session has one origin
  deployment/device, and that origin is the sole writer for its content stream.
- Other devices store read-only replicas of that source Session. Authenticated
  group-level lifecycle tombstones remain possible if the origin is lost.
- Authenticated devices in the same Personal Device Group may reuse
  origin-signed compatible derived artifacts rather than repeat avoidable
  CPU/GPU work. Local indexes remain device-local.
- Replication selects rows from explicitly allowlisted tables through versioned
  portable serializers. It does not copy PostgreSQL tables, primary keys,
  migrations, or arbitrary rows.
- Devices exchange versioned, encrypted, checksummed, idempotent packages and
  signed lifecycle records through an encrypted mailbox/relay.
- The relay supports discovery, offline delivery, resumable chunks, and
  anti-entropy cursors. It is not a plaintext Memory store, Projection service,
  recall authority, Team authority, or source of truth.
- Relay transfer is required in V1. Direct peer transfer is non-V1 and requires
  a later protocol decision; it cannot become an implicit relay fallback.
- The same-network V1 deployment has one fixed Authority/Relay-hosting
  installation. That installation is an operational availability hub for
  enrollment, governance, and package transfer even though every admitted
  device is a symmetric data-plane replica. V1 does not transfer or rotate the
  Authority private key.
- Personal multi-device association does not create or modify Team Membership,
  Workspace Access, Share Grants, Team retention, or Project-to-Team Workspace
  mappings.

This is not PostgreSQL replication and does not make every table multi-writer.
It is application-level replication of source-owned logical Memory units.
Consistent with ADR 0007, `koed-server` owns pairing, sync, status, recovery,
and headless contracts; Desktop consumes those machine-readable contracts.

## Relationship To Directed Hosted Cross-Identity Sync

Cross-Identity Sync is an umbrella term with separate product modes:

- **Directed Hosted Cross-Identity Sync / Offload** moves selected source Memory
  from a local Personal Memory identity to one hosted target replica. The target
  may independently derive Projection, embeddings, graph data, evidence paths,
  and LCM Summaries.
- **Personal Device Sync** is this ADR's symmetric replication of one Local
  Personal Identity across its Personal Device Group. Every associated device
  receives and materializes eligible closed Captured Sessions locally.

These modes share only proven common foundations: logical-memory and replica
provenance, encrypted resumable transport, durable inbox/outbox work,
idempotency, retry, and readiness/freshness gates. They retain distinct
identity, key-management, package-closure, lifecycle, and anti-entropy
contracts. A hosted target's independently generated LCM Summary is not a PDS
source record. PDS may reuse a compatible LCM Summary only as a separately
signed `lcm_node/v1` artifact bound to its exact source range and work claim.

## Personal Device Group Authority And Association

A symmetric data plane still needs a neutral identity and key control plane.
Koed uses a **Personal Device Group Authority** that is not any personal device
and cannot decrypt replicated Memory. It may be deployed with the relay,
self-hosted separately, or operated by Koed, but every deployment choice must
implement the same protocol.

The authority:

- maps device-specific deployment-local User subjects into an explicitly
  approved Personal Device Group for one Local Personal Identity;
- verifies browser-mediated enrollment and device proof of possession;
- records device public keys, membership, permitted personal operations,
  membership-statement expiry, revocation, and key epoch;
- signs bounded membership and revocation statements consumed by devices and
  the relay;
- coordinates end-to-end key distribution without retaining group decryption
  keys;
- never grants or evaluates Team Membership, Workspace Access, Share Grants, or
  Team retention.

The authority is a verifier, countersigner, and availability service, not the
sole membership or deletion authority. Group creation establishes a
user-controlled group governance signing root on the first trusted device and
produces offline recovery material. The private governance root and group
decryption keys never enter the authority or relay. The recovery material must
be stored separately from ordinary device credentials and must not be available
to Koed support or an infrastructure operator.

Every membership or lifecycle transition is a signed, monotonically sequenced
statement in an append-only hash-chained group log:

- adding a device requires browser authentication, proof of possession of the
  new device key, and approval signed by an existing active device or the
  user-held recovery root;
- revoking a device, rotating a key epoch, authorizing recovery, and issuing a
  personal-deletion tombstone likewise require an active-device or recovery-root
  signature;
- the authority verifies that authorization, checks the previous log head, and
  countersigns the resulting bounded statement, but cannot create a valid
  transition by itself;
- active devices compare signed log heads during synchronization. Conflicting
  statements at the same sequence or a broken hash chain are treated as
  authority equivocation and fail closed;
- epoch keys are delivered only as recipient-specific encrypted envelopes.
  The authority may retain and relay those envelopes but cannot unwrap them or
  add a recipient that was not authorized by the group log.

The first-device ceremony must require the User to verify and retain recovery
material before enabling synchronization. A replacement device is admitted by
an existing active device or that recovery material. There is no operator,
support, email-only, or authority-only bypass in V1. Losing every active device
and the recovery material permanently loses control of the group.

If the authority is unavailable, local capture and recall continue. New
enrollment, revocation, recovery, and key-epoch changes fail closed. Existing
package exchange may continue only while a cached signed membership statement
is unexpired, which bounds revocation delay.

Personal Device Association is a same-Local-Personal-Identity,
cross-deployment specialization of Cross-Identity Sync. It is not Directed
Hosted Cross-Identity Sync: it keeps one logical Memory lifespan across
deployment-local identities without directed hosted target semantics. It is not
Fork/Import and does not imply Team sharing.

A device necessarily has its own database subject, device id, and device key.
Those are replication and revocation implementation details, not locally
selectable product Users. The Personal Device Group binds them into one visible
Local Personal Identity.

A **Remote Account Link** is separate from the Personal Device Group. It maps
one Local Personal Identity to one explicitly approved remote deployment and
remote User. One Local Personal Identity may have many Remote Account Links;
a link is not proof of real-world identity equality, does not merge accounts,
and does not create synchronization, Team Membership, Workspace Access, or a
Share Grant. Browser-mediated remote authentication must assert the remote User
before the link becomes active. A grouped device may see redacted link metadata,
but must enroll its own device credential for that remote deployment; credentials
are never copied between devices.

Browser-mediated enrollment creates group membership but does not itself start
Memory synchronization. The association must record at least:

- stable opaque Local Personal Identity, deployment, and device instance ids;
- deployment-local User subjects for every group member;
- device public key or equivalent verifier;
- allowed personal operation families;
- creation, validation, expiry, and revocation state;
- current key epoch and current-protocol compatibility status;
- auditable consent and policy state.

Email equality, hostname, operating-system account, local path, Git remote, or
package name is never sufficient to associate devices.

Enrollment completion must also reconcile the verified group state into the
joining deployment's local database. The joining device binds its own
deployment-local User subject to the group, persists the active membership and
Personal Sync Policy needed by local workers, and resumes that state after
restart. The authority-side User subject is provenance for the enrollment; it
must not replace the joining deployment's local User id in local Projection,
materialization, or Recall. A device that holds group secrets but has no durable
local group binding is not fully enrolled and must not report synchronization
as ready.

Device credentials identify an enrolled device. They do not cache Team
Membership, Workspace Access, Share Grants, lifecycle state, or commercial
entitlements. Personal API Tokens remain AI-client compatibility credentials
for the local User and are not copied to peers or used as relay credentials.

Normal MCP Server and Supported Capture Hook configuration continues to target
the local `koed-server`. Upstream, relay, and peer credentials remain inside the
local edge and are never exposed to those integrations, Explorer JavaScript,
ordinary config, or support diagnostics.

## Synchronization Consent And Policy

Device association and synchronization consent are separate.

The Local Personal Identity owns explicit Personal Sync Policy for the Personal
Device Group and future closed Captured Sessions. Association alone synchronizes
nothing; after V1 policy activation, every eligible Session replicates to every
active group device. V1 has no per-device placement/exclusion setting. A Remote
Account Link likewise synchronizes nothing. Historical backfill is non-V1.

Effective Capture Policy, Capture Target, Capture State, and Capture Pause still
gate whether source activity may become Memory. Personal Sync Policy decides
whether already eligible Personal Memory may be replicated. A setup flow that
enables PDS must state clearly that every active group device receives
decryptable Personal Memory replicas. Pause, revocation, and status must remain
visible; removing a device from group is required to stop its future receipt.

## Replication Unit And Ownership

V1 replicates one Captured Session at a time. Personal Device Sync uses its own
versioned package protocol; it must not treat a directed hosted projected-event
package as its source closure.

A source package contains the closed source set needed to reconstruct that
Session's Personal Memory representation, including:

- Captured Session metadata and stable source identity;
- raw Conversation source items;
- Project metadata sanitized for the replication boundary;
- invalidation and group-level personal-deletion tombstones;
- source sequence and package cursors;
- provenance, integrity, and idempotency metadata.

Portable artifact packages are separate from the immutable source package and
are bound to its source fingerprint and closure hash. The Personal replication
registry makes an explicit decision for every durable Personal data class:

- `replicate`: select allowlisted rows, serialize a versioned portable artifact,
  sign and encrypt it, then transactionally validate and upsert it;
- `derive locally`: declare a compatibility contract and rebuild only when a
  trusted compatible artifact is unavailable;
- `device-local`: exclude it with a documented device-specific reason.

The default reusable artifact classes are projected Memory Events and their
canonical embeddings. A receiver imports them only when the complete contract
matches, including source closure, Projection schema and policy revision,
embedding model artifact, dimensions, tokenizer and input transformation,
pooling, normalization, and embedding version. Otherwise it derives them from
the canonical source package. Local vector indexes are rebuilt from imported
vectors. Source-owned LCM leaves and rollups are registry artifacts. Their
identity binds the exact ordered logical source range and complete LCM contract.
Only the source-authoritative device may compact that range; compatible
completed nodes may then be imported by other devices.

The registry is extensible. Adding a durable Personal table requires an
explicit replication classification and tests. It must never silently include a
new table or silently leave durable Personal data device-local. Credentials,
API Tokens, local paths, device identity material, leases, queues, transient
cursors, process and health state, and local indexes are always device-local.

Ownership selects the protocol. Personal-owned notes, chats, and future
artifacts may use this registry. Team-owned channel or direct-message history
remains governed by the Team backend and its revocation and retention rules;
PDS must not convert temporary Team access into an irrevocable Personal replica.

The package format separates source provenance from transport encryption. The
origin signs an immutable content manifest containing the logical source id,
source-closure hash, format version, and source sequence. Recipient and key-epoch
information lives in a separate signed transport envelope. An authorized replica
may re-encrypt the unchanged origin-signed content for a newly admitted device
and sign the new transport envelope as the serving replica. It cannot alter the
content manifest or claim to be the origin. A receiver verifies the original
origin signature, closure hash, serving replica membership, key epoch, and
transport-envelope signature before materialization.

Every materialized replica retains the origin-signed source package, protected
by local application-layer encryption, for as long as the corresponding Memory
is retained. This retained package may be re-served to an authorized replacement
device even after relay expiry. Relay retention is therefore an availability
aid rather than the only recovery path. Recovery is possible only while at
least one authorized replica or an unexpired relay copy still holds the package.
If the origin, relay copy, and every replica are lost, the source data is not
recoverable; governance recovery material restores group control, not missing
Memory bytes.

A canonical source package must not contain:

- raw local paths or transcript paths;
- API Tokens, browser sessions, device credentials, provider keys, or database
  credentials;
- queue internals or unrelated Personal Memory;
- Team Membership, Workspace Access, or Share Grant authority;
- derived artifacts, embeddings, plaintext-equivalent vectors, raw DEKs, or
  object-storage credentials;
- support-only or operator-private diagnostics.

Project-wide and all-Personal-Memory packages remain deferred. A Project can
help select or display Sessions, but it is not the durable replicated Memory
identity or authorization boundary.

## Consistency Model

Koed uses eventual consistency with per-origin ordering rather than a global
total order.

- Every origin device has a monotonic source sequence.
- Package ids include stable origin deployment identity, source sequence, and
  source-closure hash. Logical source identity is group-stable where the source
  exposes a stable source-native identifier.
- Package and chunk replay is idempotent.
- Devices exchange per-origin high-water marks or an equivalent anti-entropy
  summary.
- No consensus is required for independent Sessions created on different
  devices.
- Replicas are read-only; edits produce a versioned source record from the
  origin rather than an independent target mutation.
- Mutable policy or lifecycle records require explicit version and conflict
  rules. Unknown or conflicting versions fail closed instead of selecting the
  latest wall-clock timestamp.
- Projection and embedding readiness are device-local processing states, even
  when a receiver imports compatible artifacts. They are not replicated source
  ordering.

This avoids general CRDT or multi-primary relational-database semantics for V1.
A future shared mutable object would need a separate conflict-resolution
decision.

Independent origins can observe the same underlying AI-client Session, so
origin-local ids are insufficient for logical convergence. Before publication,
each origin derives a **group-stable source fingerprint** from the canonical
source type and stable source-native Session identifier using a dedicated,
group-private source-identity key. This key is distinct from transport epoch
keys and Project matching keys. The fingerprint and source-closure hash remain
inside the encrypted package boundary. They are never derived from a local
database id, raw path, checkout path, device id, or unsalted public hash.

Receiving devices apply these rules:

- equal fingerprints and equal source-closure hashes converge on one logical
  Memory identity while preserving every observing origin in provenance;
- equal fingerprints with different closures are quarantined as a source
  conflict. Neither package silently replaces or merges with the other.
  Synchronized representations of that logical identity are excluded from
  cross-device Projection and Recall on every receiver until a group-signed
  resolution selects a closure or records them as intentionally distinct;
- sources without a trustworthy stable source-native identifier do not
  auto-converge across origins. They remain distinct and may be presented as
  duplicate candidates for explicit resolution;
- a fingerprint collision, invalid source identity, or incompatible package
  format fails closed and is recorded without projecting or embedding the
  conflicting package;
- deletion and invalidation apply to the converged logical identity while the
  audit trail retains all origin observations and package provenance.

The source-identity key remains stable for the Personal Device Group lifespan
and is re-enveloped only to authorized devices. Revocation cannot erase key
material already received by a formerly trusted device; transport authorization
and new transport epochs prevent that device receiving later packages. A
suspected source-identity-key compromise requires an explicit identity-migration
protocol that preserves old-to-new mappings; implementations must not silently
change existing logical ids. Validation must cover two devices independently
importing the same Session, exchanging equal packages in both orders,
conflicting source closures, cloned profiles, and deletion after convergence.

## Relay Boundary

V1 requires encrypted mailbox/relay transport because direct device connectivity
is unreliable across NAT, sleep, roaming, firewalls, and offline periods.

The relay may retain only what is required for delivery and recovery:

- encrypted package chunks;
- redacted encrypted-package manifests;
- source and target opaque identifiers;
- package versions, byte counts, checksums, expiry, and cursor metadata;
- delivery acknowledgement and retry state.

Package content must be encrypted for the associated device group or explicit
target devices before upload. Manifests and signatures must bind the package to
the Personal Device Association, source deployment, intended recipients, key
epoch, nonce, expiry, and package format.

The relay must not be required to decrypt Memory, run Projection, build
embeddings, answer recall, infer repository identity, or authorize Team access.
It will still observe bounded metadata such as network addresses, timing,
package sizes, opaque device relationships, and delivery frequency; privacy
claims and retention policy must acknowledge that leakage.

Relay intake must enforce authenticated membership, package and chunk size
limits, bounded decompression, nonce/replay protection, expiry, format-version
allowlists, downgrade resistance, and redacted operational logging. Compromise
of relay storage should reveal encrypted bytes and bounded redacted metadata
only.

A self-hosted relay or Koed-managed relay can implement V1. Direct peer
transport is non-V1. Relay deployment choice is separate from Memory ownership.

## Local Materialization And Recall

Each device materializes synchronized source packages into its local Personal
Memory store. It imports compatible trusted portable artifacts when available
and otherwise runs local Projection and embedding work.

Recall normally queries the local materialized view. Evidence Bundles should
carry source-device provenance and freshness when synchronized Memory is used.
The UI must distinguish:

- local origin Memory;
- synchronized and ready replicas;
- synchronized but still processing replicas;
- stale replicas;
- unavailable source devices;
- failed or revoked synchronization.

A device being offline must not block capture or recall from already
materialized local Memory. New Memory from another offline device becomes
visible after relay delivery and local processing complete.

Partial replication is non-V1. V1 replicates every eligible Captured Session
to every active group device; selective placement would compromise recall
completeness, deletion, key rotation, and user expectations.

## Project Context Association

Project contexts remain local metadata. Checkouts and worktrees retain distinct
local ids for provenance.

After devices are associated with the same User, Koed may canonicalize the full
network host/namespace/repository alias and derive a blind match key using a
Personal Device Group matching key. Match-key manifests remain inside the
encrypted package, so the relay cannot compare repository identities. Matching
may then associate local Project contexts for Personal Memory grouping.

Key-epoch rotation requires devices to regenerate matching manifests. Hash
collisions, canonicalization changes, and multiple matching aliases are treated
as ambiguity rather than automatic association.

- Raw paths and unsalted remote fingerprints must not leave the local trust
  boundary.
- One unambiguous alias overlap may be associated automatically.
- Forks, multiple candidates, or conflicting historical aliases require User
  confirmation.
- Local-only repositories require manual association.
- A User may inspect, correct, remove, or manually create an association.
  Explicit User choice overrides detection and prevents future automatic
  reassociation until that choice is removed.
- Project association affects Personal Memory grouping and search context only.
- Project association never creates, selects, or authorizes a Team Workspace.

## Lifecycle, Revocation, And Deletion

These operations remain separate:

- device-association revocation;
- device credential rotation or revocation;
- synchronization pause or revocation;
- replica removal;
- personal deletion;
- Team Share Grant revocation;
- Team retention;
- irreversible hard purge.

Revoking a device prevents future package exchange and key access. It cannot
make already downloaded plaintext disappear from a device that previously had
legitimate access. UI and policy must state that limitation clearly.

Group membership changes require a new key epoch. Remaining devices must stop
encrypting new packages to revoked members. Historical package re-encryption is
non-V1; V1 relay and tombstone retention is fixed by protocol profile and cannot
be inferred from credential revocation.

An authenticated User deletion request creates an active-device- or
recovery-root-authorized, authority-countersigned monotonic tombstone. A
tombstone supersedes older content packages, is retained until every active
device acknowledges it plus any required retention period, and remains locally
recorded to prevent stale relay or backup replay from resurrecting deleted
Personal Memory. The Personal Device Group Authority also retains an opaque
compact deletion floor for the logical Memory identity until the entire group
is irreversibly purged. A restored device must reconcile that signed deletion
ledger before materializing restored packages; backup restore cannot lower its
lifecycle high-water mark. The authority cannot issue a valid deletion by
itself. The origin may publish content invalidations, but permanent origin loss
cannot block a properly authorized personal deletion.

If an origin device is permanently lost, already replicated closed Sessions
remain available. Unsynchronized source material is lost with that device.
Content-authority transfer and continued mutation of an origin Session are not
supported in V1.

Personal-device tombstones control Personal Memory replicas only. They do not
revoke or mutate Team Membership, Workspace Access, Share Grants, or Team-side
retained state. Team-shared Memory remains User-owned and follows the separate
Share Grant and Team retention model from ADR 0004.

## Historical Import

Historical AI-client import remains a local ingestion path when KOE-317 and its
children are implemented. PDS V1 never replicates imported Sessions: it admits
only Sessions first closed after PDS policy activation. Import alone does not
grant synchronization consent or upload source data. A later PDS profile must
specify bounded import consent, closure, retention, and idempotency before an
imported Session can replicate. Hook/import overlap must still deduplicate
locally so it cannot create two logical Memory lifespans on one origin.

## Alternative: Designated Personal Hub

A designated Personal Hub remains a valid alternative.

Under that model:

- one selected deployment receives replicas from all devices;
- aggregate Projection, indexing, and recall happen at the Hub;
- local edges route cross-device reads to the Hub;
- source devices retain local capture and may keep local replicas;
- Hub migration or failover is an explicit operation.

Advantages:

- simpler identity and cursor topology;
- one aggregate index and recall authority;
- fewer replicas and less repeated Projection/embedding work;
- easier operational status, quotas, backup, and support;
- direct reuse of directed source-to-target Cross-Identity Sync semantics.

Disadvantages:

- one privileged deployment;
- aggregate recall availability and freshness depend on the Hub;
- permanent-seeming device selection during setup;
- Hub migration, restore, and failover become product workflows;
- a local device may need live remote recall or a second local cache to preserve
  seamless offline use.

The trust and exposure shapes also differ. A Hub must decrypt aggregate Memory
and becomes a concentrated plaintext target, while symmetric replication gives
every selected device a decryptable replica and therefore expands endpoint
exposure. Neither model removes trust; they place it differently.

The Personal Memory Hub design is not selected: no device owns canonical
plaintext Memory or aggregate Recall. The V1 same-network transport still has a
fixed operational Authority/Relay host. Removing that availability dependency
requires a later protocol decision covering direct or multiple relay endpoints,
Authority transfer/rotation, recovery-kit evolution, and split-brain handling.

## Consequences

Benefits:

- no permanent plaintext Memory authority or aggregate Recall device;
- local capture and recall remain available on every device;
- replacement devices can recover retained closed Sessions through the valid
  recovery flow while the fixed Authority/Relay host and an authorized replica
  or retained relay copy remain available;
- replicas can converge after offline work;
- transport deployment is separable from Memory ownership;
- Project matching can span trusted devices without affecting Team security.

Costs:

- more replicas and compatibility/fallback Projection and embedding work;
- per-device cursors, anti-entropy, key distribution, and compatibility state;
- harder revocation and deletion semantics;
- more upgrade and current-version coordination cases;
- greater storage and bandwidth use;
- more complex stale/partial/error UX;
- enrollment, governance, and package transfer pause while the fixed V1
  Authority/Relay host is unavailable;
- wider security and two-node/N-device test matrix.

The complexity is materially greater than a Personal Hub. It remains bounded by
keeping Captured Sessions source-owned and immutable on replicas, avoiding
global ordering, and transferring only explicitly registered portable derived
artifacts.

## Non-Goals

This decision does not add:

- automatic Team Workspace linking;
- Team authority through Project or device metadata;
- peer-to-peer Team Memory replication;
- raw PostgreSQL replication;
- shared mutable Conversations;
- direct target mutation of source-owned replicas;
- backend LLM synthesis;
- Project-wide or global Personal Memory package boundaries;
- selective partial replication in V1;
- relay plaintext processing;
- consensus or leader election between personal devices;
- direct or multiple relay endpoints and Authority transfer/rotation.

## Required Follow-Up Work

Follow-up implementation work:

1. stable deployment/device identity and cloned-`KOED_HOME` handling;
2. secure Desktop and headless credential storage;
3. one-Local-Personal-Identity Personal Device Association, group governance
   signing root, auditable membership log, Remote Account Links, and key epochs;
4. versioned Captured Session package closure and group-stable source
   fingerprints;
5. target-decryptable package encryption, immutable source signatures,
   recipient rewrapping, and replacement-device recovery;
6. resumable source outbox, relay mailbox, and target inbox;
7. idempotent local materialization, cross-origin convergence, conflict
   quarantine, and read-only replica provenance;
8. anti-entropy cursors and governance-authorized lifecycle records;
9. privacy-preserving cross-device Project association;
10. Desktop device, freshness, processing, and revocation UX;
11. historical-import integration without implicit upload consent;
12. two-device and N-device migration, duplicate import, authority compromise,
    recovery loss, outage, replay, and security validation;
13. versioned portable Memory Event and embedding artifact serializers,
    compatibility verification, transactional import, and fallback derivation.

KOE-264 remains the directed-hosted design foundation, and KOE-338 / PR #290 is
the implemented directed-hosted baseline. Personal Device Sync must generalize
only proven shared primitives to multiple device replicas and per-device
cursors; it must not inherit directed hosted identity, recipient-key,
package-closure, or deletion semantics unchanged. KOE-269 should own supported
headless pairing, Remote Account Link enrollment, and recovery surfaces.
KOE-317 and its children should preserve origin deployment/device provenance and
must not imply synchronization consent.

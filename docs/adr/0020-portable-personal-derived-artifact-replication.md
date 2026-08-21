# Portable Personal Derived Artifact Replication

Status: Accepted.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0019 Same-Network Personal Device Enrollment](./0019-same-network-personal-device-enrollment.md)
- [0021 Portable Semantic Work Ownership](./0021-portable-semantic-work-ownership.md)
- [0030 Personal Semantic Work Is Computed Once And Replicated](./0030-single-personal-semantic-computation.md)
- [Personal Device Sync Protocol V1](../personal-device-sync-protocol.md)

## Context

Personal Device Sync replicates the canonical source closure for an eligible
closed Captured Session. A receiving device can reconstruct Memory Events,
embeddings, summaries, and indexes from that source, but repeating all
Projection and embedding work on every trusted device wastes CPU/GPU time and
delays Recall.

Raw PostgreSQL replication would avoid some repeated work, but it would also
copy device-specific state, couple devices to one schema and migration history,
and make ownership and conflict behavior implicit. Replicating only transcript
source bytes has the opposite problem: it is portable and authoritative, but it
discards expensive derived work that another enrolled Personal device has
already completed.

Koed also expects to add more durable Personal data classes. A replication rule
that is hard-coded only for today's transcript and Memory tables would silently
lose or unnecessarily recompute future Personal data.

## Decision

PDS replicates two distinct layers:

1. the immutable, origin-signed canonical source package; and
2. separately signed and encrypted portable artifact packages selected by an
   explicit Personal replication registry.

The source package remains sufficient to reconstruct the Captured Session and
is never mutated when later derived work completes. Artifact packages bind to
the source fingerprint and exact source-closure hash. Losing, rejecting, or not
understanding an artifact package must not prevent canonical source
replication.

The registry classifies every durable Personal data class as exactly one of:

- **replicate**: select allowlisted rows and fields, serialize a versioned
  portable artifact, then validate and idempotently upsert it on a receiver;
- **derive locally**: reconstruct it from canonical source when no compatible
  trusted artifact is available;
- **device-local**: exclude it because its meaning belongs to one installation.

The initial reusable artifact classes are:

- portable projected Memory Events with stable source-item bindings; and
- canonical Memory Event embeddings with a complete compatibility contract.

Portable LCM nodes follow their stable source-range identity and single-writer
work-claim contract. The unfinished LCM compaction frontier is deterministic:
it is reconstructed from ordered logical Memory Events after subtracting
complete leaf coverage. Managed Conversation execution authority therefore
continues the accumulated source range without another mutable replicated
record, resetting the threshold, or duplicating work.

An enrolled Personal device may trust those artifacts from another active
device only after verifying membership, signatures, source binding, content
hashes, schema version, and compatibility. Embedding compatibility includes the
model artifact identity, dimensions, tokenizer and input transformation,
pooling, normalization, and embedding version. A mismatch causes local
derivation, not coercion or partial import.

Local vector indexes are rebuilt from imported vectors. Portable LCM leaves and
rollups use logical source-range identities rather than local database IDs.
Their summaries may be reused only when the exact source range, node kind,
algorithm, prompt, model, structured-output contract, and correction state are
compatible. Otherwise the source range remains eligible for one claimed local
derivation.

Portable artifacts contain logical identities and content hashes, not local
database primary keys. The implementation selects explicitly allowlisted table
rows and fields through versioned serializers. It does not replicate tables,
SQL, migration state, or arbitrary rows.

The following remain device-local:

- device and authority keys, credentials, API Tokens, and browser sessions;
- local paths, checkout identifiers, process state, health state, and runtime
  configuration;
- queue jobs, retry state, transient cursors, and local indexes;
- physical process leases and runner identities.

Semantic work claims are replicated coordination records rather than ordinary
queue rows. They name stable semantic work, carry a bounded expiry and fencing
generation, and prevent two active devices from publishing competing
Projection, embedding, or LCM results for the same logical source range.

Every new durable Personal table or artifact must receive an explicit registry
classification and tests. Absence from the registry is a failing development
condition, not an implicit device-local default.

Ownership controls eligibility. Personal-owned notes, conversations, and future
artifacts may be added to the PDS registry. Team-owned channels, direct
messages, and retained Team Memory remain governed by the Team backend and its
authorization, revocation, and retention rules. Temporary Team visibility must
never become an irrevocable Personal replica through PDS.

## Remote-Backed And Local Topologies

The reuse rule is the same in both supported topologies:

- With an owner-authorized remote `koed-server`, canonical source is processed
  there and, while Hosted Personal Source Replication is explicitly enabled,
  the remote backend owns compatible embedding work rather than merely being a
  preferred claimant.
  Accepted Personal embeddings and LCM artifacts are downloaded and reused by
  every authorized device. LCM synthesis still runs through one claimed Local
  AI Runtime, not a backend LLM.
- Without a remote backend, each device has a local materialization. PDS moves
  canonical source and explicitly allowlisted compatible artifacts so another
  device can reuse completed Projection and embedding work instead of repeating
  it.

This does not make raw database replication the protocol. PDS exchanges
immutable, signed, encrypted source and artifact records. The direct hosted
path uses its separately authenticated, recipient-encrypted package contract;
an enrolled device signs an artifact only if it later serves that verified
result through PDS. Both transports follow the semantic-work rules in ADR 0030.

## Consequences

- Enrolled devices can reuse expensive compatible Projection and embedding work.
- Canonical source remains the recovery and reprocessing authority.
- Devices with different model or Projection contracts still converge on source
  and safely derive their own artifacts.
- Schema changes require deliberate portable-schema and compatibility handling.
- Storage and bandwidth increase because source and selected artifacts are both
  transferred.
- The registry creates an auditable boundary for future Personal data instead
  of gradually becoming whole-database replication.

## Non-Goals

This decision does not introduce:

- PostgreSQL physical or logical replication;
- replication of device-specific operational state;
- trust in artifacts from revoked, unknown, or Team-only identities;
- replication of Team-owned collaboration data through PDS;
- implicit compatibility across embedding models or Projection revisions;
- copying physical execution leases or queue ownership between devices.

## Implementation Boundary

The PDS source-package data plane, same-network enrollment, Authority/Relay, and
local materialization paths are the authority for artifact transport. Portable
Memory Event, embedding, and compatible LCM node transfer use
separate immutable artifact packages bound to an accepted source package.

# Generic Logical Memory Source Revisions

Status: Accepted.

Related decisions:

- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0014 Hosted Personal Source Replication](./0014-hosted-personal-source-replication.md)
- [0029 Selective PII Team Representations](./0029-selective-pii-team-representations.md)
- [0032 First-Class Revisioned Personal Notes](./0032-first-class-revisioned-personal-notes.md)

## Context

Captured Sessions and Personal Notes can both be reviewed, authorized,
privacy-filtered, published, recalled, retained, and revoked. Those workflows
need one stable source identity and one immutable revision identity, but their
source semantics are not interchangeable. A Captured Session has a semantic
cursor and can expose several representation levels plus separately governed
source access. A Personal Note has positive immutable Note revisions and only
provides its projected Note Memory Event.

Putting nullable Session and Note foreign keys on every generic workflow row
would duplicate identity rules and make unsupported capabilities liable to
fall through accidentally. Treating a Captured Session cursor as a generic
revision would also make cursor zero invalid or force generic revision numbers
to inherit adapter-specific meaning.

## Decision

`logical_memories` is the stable generic source identity. It has a closed
`source_kind` discriminator. Source-specific identities live in exactly one
typed binding table for that kind. Machine-local Session and Note IDs live only
in local binding tables.

`logical_memory_source_revisions` contains positive, immutable, monotonically
numbered generic revisions. Every generic revision is created in the same
transaction as exactly one matching typed revision binding. Deferred database
constraints reject unbound, multiply bound, wrong-owner, wrong-kind, or
wrong-logical-memory revisions at commit. Repository APIs do not expose an
operation that creates a generic revision without its typed binding.

Captured Session cursors remain non-negative source-specific values, so cursor
zero is valid. A Captured Session generic revision is a hash-bound durable
frontier and is materialized only when a durable workflow needs that exact
frontier; ordinary ingestion cursor movement does not create revisions. The
current mapping assigns generic revision `cursor + 1`. Personal Note generic
revision numbers equal their positive Note revision numbers.

Generic workflow tables reference `logical_memory_id` and
`source_revision_id`; they contain no nullable source-specific foreign keys.
Typed adapters resolve the exact Captured Session or Personal Note binding.
The governing split is generic identity, authorization, and publication;
source-specific capabilities and bindings.

Canonical hashes are versioned and domain-separated. Generic revision
bindings, Captured Session frontiers, and Personal Note revisions use distinct
domains and include their generic revision plus the relevant source-specific
revision or cursor. A hash from one domain cannot authorize another source
kind or revision.

Generic Team/read DTOs expose only authorized product identity and state. They
must not expose owner principals, machine-local IDs, protected hashes, or
adapter internals. Owner-authorized consent workflows may use bounded opaque
preview references needed to bind an exact reviewed revision; those references
do not become Team read DTOs.

Capability authorization remains source-specific and fails closed. Personal
Notes provide projected Note memory only. Captured Sessions may provide Memory
Events, LCM levels, Curated Memory when separately selected, and separately
governed source access. A generic Share Grant never implies capability parity.

## Consequences

- A Share Grant, consent, artifact, preview, representation, or durable work
  row identifies one exact generic revision without polymorphic columns.
- Source adapters retain strong relational ownership and revision invariants.
- Continuous publication advances the representation, Share Grant revision
  number, and immutable source revision ID atomically.
- Unsupported source capabilities are rejected before source upload,
  decryption, or publication.
- Normalized reads add typed binding joins, so their principal lookup paths
  require explicit indexes and query-plan validation.
- Adding another source kind requires an explicit enum, typed identity and
  revision bindings, capability policy, hash domain, authorization adapter,
  and tests. Generic fallback behavior is prohibited.

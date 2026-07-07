# Managed SaaS Queryable Vectors

Status: Accepted for the Team SaaS launch plan.

## Context

Commercial Memory encryption protects human-readable Memory and evidence
fields, but recall still needs a searchable representation. Koed currently uses
pgvector for semantic search and SQL lexical search over plaintext Memory
columns. Once managed SaaS Memory text is encrypted, plaintext lexical fallback
is no longer compatible with the security model.

Queryable vectors are also sensitive. They are not plaintext, but they are
derived from customer Memory and can leak semantic information through nearest
neighbor behavior, membership inference, model inversion attempts, or support
access to search infrastructure.

## Decision

Koed-managed cloud will keep a tenant/team-scoped queryable vector
representation inside the trusted backend search boundary. This representation
is the operational search index for recall. It is sensitive derived customer
data, not zero-knowledge storage.

Canonical embeddings used for rebuild, export, support, or future migration
must be treated as encrypted sensitive payloads. Queryable pgvector rows remain
inside the database/search boundary with tenant/team authorization metadata and
must be selected only after request-time authorization gates are applied.
The launch implementation records this explicitly on `memory_embeddings`:
`queryable_vector_strategy='trusted_backend_pgvector_v1'`,
`search_boundary='owner_user_dynamic_grants'`, and
`canonical_embedding_state='not_stored'`. The pgvector dimension tables are the
queryable representation, not a plaintext canonical embedding archive. If Koed
later stores canonical embeddings for rebuild, export, support, or migration,
that storage must move through the encrypted payload/package path and update
`canonical_embedding_state` accordingly.

Managed SaaS disables plaintext lexical search by default. Operators may enable
`MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED=true` only after the deployment has a
documented leakage posture or a separate encrypted/search-derived lexical index
is implemented. Local personal, developer, private VPS, and Team Self-Hosted
can keep plaintext lexical search unless their Operator disables it.

## Implementation Rules

- Authorization is applied before vector candidate admission, reranking,
  Evidence Bundle expansion, graph/source expansion, or decrypt.
- Queryable vector rows must carry enough owner, visibility, source, and future
  tenant/team metadata to apply the visibility resolver before ranking.
- Personal-owned launch rows use the owner User plus dynamic Share Grant joins
  as the search boundary. Team-visible recall can admit a row only when the
  current Team Workspace authorization and source-session Share Grants match.
- Plaintext `lexical_search` must fail closed in `koed_managed_cloud` unless
  explicitly opted in.
- Reranking input must be built only from already-authorized candidates.
- Diagnostics, logs, audit metadata, support status, and queue payloads must not
  include raw Memory text, raw embedding vectors, or decrypted canonical
  embedding payloads.
- Product and capability language must avoid zero-knowledge or end-to-end
  encryption claims for Koed-managed cloud.

## Consequences

- Managed SaaS recall remains practical with encrypted Memory text.
- Queryable vectors remain a trusted-boundary data asset that must be protected
  by tenant isolation, database roles, backups, support policy, and audit.
- Exact lexical search quality in managed SaaS is intentionally reduced until a
  leakage-documented derived lexical index exists.
- High-assurance customers may still require tenant-side search, a customer
  data plane, BYOK/CMEK, or future private vector search instead of
  Koed-managed searchable vectors.

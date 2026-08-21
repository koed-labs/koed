# Managed SaaS Queryable Vectors

Status: Accepted for the Team SaaS launch plan.

## Context

Commercial Memory encryption protects human-readable Memory and evidence
fields, but Recall still needs a searchable representation. Koed uses pgvector
for production semantic retrieval. A global SQL lexical search over plaintext
Memory is incompatible with the managed SaaS security model and is not part of
the production Recall architecture in any deployment profile.

Queryable vectors are also sensitive. They are not plaintext, but they are
derived from customer Memory and can leak semantic information through nearest
neighbor behavior, membership inference, model inversion attempts, or support
access to search infrastructure.

## Decision

Koed-managed cloud will keep a tenant/team-scoped queryable vector
representation inside the trusted backend search boundary. This representation
is the operational search index for recall. It is sensitive derived customer
data, not zero-knowledge storage.

Personal embeddings remain owner-only and are computed from unchanged
full-fidelity Personal Memory. A Team-queryable vector is derived only from the
current sanitized Team representation. When the final Team embedding input is
byte-identical to a Personal input under the same model, tokenizer,
composition, pooling, and normalization generation, an authorized worker lease
may reuse the existing computation. If sanitization changes that input, Koed
computes one Team-safe embedding. Grant-scoped vector rows may remain
physically separate so authorization, revocation, and retention stay explicit.

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

Exact and lexical hints may seed focused semantic queries. Koed may then compare
those hints with the small set of already-authorized retrieved candidates, such
as validated LCM lexical anchors. It does not maintain a production lexical
index or decrypt Memory globally for lexical matching. Eval-only BM25 and fixed
hybrid indexes remain isolated Retrieval Arena baselines rather than product
storage or policy.

## Implementation Rules

- Authorization is applied before vector candidate admission, reranking,
  Evidence Bundle expansion, graph/source expansion, or decrypt.
- Queryable vector rows must carry enough owner, visibility, source, and future
  tenant/team metadata to apply the visibility resolver before ranking.
- Personal-owned launch rows use the owner User plus dynamic Share Grant joins
  as the search boundary. Team-visible recall can admit a row only when the
  current Team Workspace authorization and source-session Share Grants match.
- Production candidate generation is semantic in every deployment profile;
  there is no plaintext lexical-search stage or configuration escape hatch.
- Reranking input must be built only from already-authorized candidates.
- Vector creation must bind the classifier generation, effective content-policy
  version and hash, sanitized content hash, and canonical final-input
  fingerprint. A policy or classifier change rematerializes provenance but
  does not rerun embedding when the final input and embedding generation are
  unchanged.
- Team vectors, queryable inputs, exact-hint checks, and evidence expansion must
  use sanitized Team material. They must never substitute Personal text,
  Personal lexical anchors, or Personal vectors when Team materialization is
  pending or unavailable.
- Diagnostics, logs, audit metadata, support status, and queue payloads must not
  include raw Memory text, raw embedding vectors, or decrypted canonical
  embedding payloads.
- Product and capability language must avoid zero-knowledge or end-to-end
  encryption claims for Koed-managed cloud.

## Consequences

- Managed SaaS recall remains practical with encrypted Memory text.
- Queryable vectors remain a trusted-boundary data asset that must be protected
  by tenant isolation, database roles, backups, support policy, and audit.
- Revocation, retention expiry, hard purge, and key rotation cover Team-safe
  vectors and any encrypted canonical embedding artifacts together with their
  sanitized source representations.
- Exact terminology is routed through focused semantic queries, grounded LCM
  anchors, and checks over already-authorized candidates rather than a separate
  lexical index.
- High-assurance customers may still require tenant-side search, a customer
  data plane, BYOK/CMEK, or future private vector search instead of
  Koed-managed searchable vectors.

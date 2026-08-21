# Team Memory Uses User-Owned Share Grants And Workspaces

Status: Accepted.

Supersedes: [0002 Deferred Multi-User Memory Access](./0002-defer-multi-user-memory-access.md).

## Context

Koed's first self-hosted boundary was personal-memory only. Multi-user memory
sharing was deferred because the old proof of concept did not have a clear
domain model, authorization boundary, token behavior, or migration path.

Team memory sharing is now in scope, but it must not reintroduce ambiguous
"team project" ownership, hidden copies, or team-owned memory by rename. The
product needs a stable shared memory identity that survives local path,
repository, branch, ref, and cwd changes. It also needs vocabulary that can
cover later hosted Team, self-hosted Team, cross-identity sync, and Memory Inbox
flows without changing the underlying ownership model.

## Decision

Koed will model Team memory as user-owned memory made recallable through
explicit grants and policy. The data model remains logically flat: ownership,
visibility, lifecycle, sync, and retention are separate concerns rather than
separate physical memory hierarchies.

- Memory Events, Memory Nodes, and Captured Sessions remain owned by the
  originating User.
- A Team is the collaboration boundary.
- A Workspace is the stable shared ID for memories within a Team.
- A Project is local AI-client or code context such as a repository, filepath,
  ref, branch, or cwd. Project metadata may resolve or display a Workspace, but
  it is not the durable authorization key.
- Workspace Access controls whether a User can recall, share, or manage
  Team-shared Memory in a Workspace.
- A Share Grant links a user-owned memory source to one Team and one Workspace.
  The first implemented source type is a Captured Session; future sources may
  include synced replicas or Memory Inbox content.
- API Tokens remain user-owned. Team and Workspace authority is derived from
  the owning User's current Team Membership and Workspace Access at request
  time.
- Sharing changes authorization. It does not move ownership or create an
  independently evolving memory lifespan. Sanitized encrypted Team
  representations are derived sharing artifacts, while exact Personal
  originals and Personal derived artifacts remain unchanged and owner-only.
- Cross-Identity Sync is the model for personal Koed to Team-personal sharing
  when the same logical memory lifespan must continue across identities or
  deployments. It may maintain a policy-aware synced replica for availability,
  indexing, and Team recall, but the logical memory does not fork.
- Fork/Import is a separate, explicit future operation for cases where a user
  intentionally wants a new memory lifespan that can diverge from its source.
- Offload changes where storage or processing happens, such as using a hosted
  Koed service. It does not by itself create Team visibility or a fork.
- Removing a User from a Team or Workspace changes future access only. It does
  not delete, invalidate, or modify the user's previous Team-shared Memory.
- Share Grant revocation, Workspace archive, Access Suspension, personal
  deletion, retention hold, and hard purge are separate lifecycle operations.
- A Workspace archive is a soft delete: the Workspace leaves normal active
  flows, but retained Team-shared Memory, audit history, grants, and provenance
  remain available for restore, retention, and authorized archived search.
- Access Suspension is a separate gate from Team deletion. For example, billing
  failure may block ingestion, recall, sharing, management, or some combination
  of those actions without deleting Team data.
- Personal deletion removes the Captured Session from the owner's Personal
  Memory recall surface, but does not revoke active Team sharing in the first
  version.
- Backend LLM synthesis remains out of scope. Koed's local MCP-side Memory
  Answer worker uses the connected AI Client to return a standalone answer;
  citations or selected evidence are explicit response-detail choices. The
  connected AI Client also performs LCM Summary synthesis.
- Memory Inbox is a future ingestion surface, not the V1.0 Team memory core.
  The Team architecture should still reserve room for Content Objects, Content
  Inventory, Knowledge Collections, ingestion jobs, provenance, quotas, and
  collection grants so external content can be added later without redefining
  Workspace or Project semantics.

## Consequences

Authorization and lifecycle gates must be enforced during retrieval candidate
selection, not only as a final response filter. Semantic vector search, narrowed
exact checks over admitted candidates, graph lookup, expansion, fallback
retrieval, diagnostics, and reranking must constrain candidates to Memory
visible to the caller through Personal Memory and active Team / Workspace Share
Grants. Production Recall has no global plaintext lexical index or decrypted
lexical scan. Archived Workspace data may be included
only by an explicit archived-search mode. Access-suspended Team data requires a
separate admin, legal, or Operator mode and must not become searchable merely
because archived search is enabled.

Share revocation, personal deletion, global invalidation, owner account
deletion, Team retention, Workspace archive, Access Suspension, ingestion
gating, and audit must remain separate states or events. This keeps future Team
Retention Policy, hosted/SaaS retention controls, legal hold, billing policy
changes, and deletion request workflows possible without redefining ownership.

The first implementation should prefer explicit nullable lifecycle fields over a
single overloaded status. Expected examples include `archived_at` for retained
Workspace soft deletion, `disabled_at` plus a reason for Team or membership
access suspension, `revoked_at` for Share Grants, and future `purge_after`
fields only where hard deletion eligibility is intentional. The exact billing
behavior can then evolve from "read-only after grace period" to "recall blocked
but ingestion allowed" or another policy without a schema rewrite.

Local path, repository remote, branch, ref, package name, and cwd changes must
not change Team authorization. Those Project fields are resolution and display
metadata only; Workspace is the stable shared memory identity.

Team-visible derived memory must be built only from source items authorized for
that Team and Workspace. A private LCM Summary, rollup, embedding, or graph edge
must not become Team-visible by relabeling or by pointing to one shared source
while also carrying unrelated private source material. Source authorization is a
retrieval and derivation boundary, not only a UI display filter.

The semantic representation choice is cumulative and sets maximum fidelity:
Memory Events permit complete Memory Events, leaves, and rollups; LCM leaves
permit complete leaves and rollups; and LCM rollups permit rollups only. Every
Team layer must be independently current, complete, sanitized, encrypted, and
policy-bound. Conversation Source Access and Curated Memory remain separate
grant and consent surfaces, and no missing layer permits fallback to Personal
or finer Team source.

Cross-Identity Sync requires sync state and provenance in later implementation
work. A Team-side replica must be marked as synced, stale, revoked, or otherwise
policy-gated so recall can distinguish "current enough to use" from "source is
offline or no longer shared." Revoking the cross-identity sync should stop
future propagation while preserving the Team-visible data already shared under
the relevant grant and retention policy.

Memory Inbox implementation must deduplicate Content Objects by content identity
where possible, keep ingestion provenance separate from recall grants, and allow
one Knowledge Collection to be granted to multiple groups without re-ingesting
the same files or URLs. This preserves the same flat ownership and grant model
for education, support, and non-software Team use cases.

The old multi-user proof of concept must not be revived. New implementation
work should follow this domain model and the accepted AI-client synthesis
boundary in [0001 Rely on AI clients for LLM synthesis](./0001-ai-client-synthesis-only.md).

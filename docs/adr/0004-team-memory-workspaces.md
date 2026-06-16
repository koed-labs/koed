# Team Memory Uses User-Owned Share Grants And Workspaces

Status: Accepted.

Supersedes: [0002 Deferred Multi-User Memory Access](./0002-defer-multi-user-memory-access.md).

## Context

Koed's first self-hosted boundary was personal-memory only. Multi-user memory
sharing was deferred because the old proof of concept did not have a clear
domain model, authorization boundary, token behavior, or migration path.

Team memory sharing is now in scope, but it must not reintroduce ambiguous
"team project" ownership. The product needs a stable shared memory identity
that survives local path, repository, branch, ref, and cwd changes.

## Decision

Koed will model team memory sharing as user-owned memory made recallable through
explicit Share Grants.

- Memory Events, Memory Nodes, and Captured Sessions remain owned by the
  originating User.
- A Team is the collaboration boundary.
- A Workspace is the stable shared ID for memories within a Team.
- A Project is local AI-client or code context such as a repository, filepath,
  ref, branch, or cwd. Project metadata may resolve or display a Workspace, but
  it is not the durable authorization key.
- Workspace Access controls whether a User can recall or share Team-shared
  Memory in a Workspace.
- A Share Grant links one user-owned Captured Session to one Team and one
  Workspace.
- API Tokens remain user-owned. Team and Workspace authority is derived from
  the owning User's current Team Membership and Workspace Access at request
  time.
- Team admin "delete" means stop sharing for the Team. It revokes the Share
  Grant and does not delete, invalidate, or modify the underlying user-owned
  memory.
- Personal deletion removes the Captured Session from the owner's Personal
  Memory recall surface, but does not revoke active Team sharing in the first
  version.
- Backend LLM synthesis remains out of scope. Koed returns Evidence Bundles and
  the connected AI Client performs Answer Synthesis and LCM Summary synthesis.

## Consequences

Authorization must be enforced during retrieval candidate selection, not only as
a final response filter. Vector search, lexical search, graph lookup,
expansion, fallback retrieval, diagnostics, and reranking must constrain
candidates to memory visible to the caller through Personal Memory and active
Team / Workspace Share Grants.

Share revocation, personal deletion, global invalidation, owner account
deletion, Team retention, and audit must remain separate states or events. This
keeps future Team Retention Policy, hosted/SaaS retention controls, legal hold,
and deletion request workflows possible without redefining ownership.

Local path, repository remote, branch, ref, package name, and cwd changes must
not change Team authorization. Those Project fields are resolution and display
metadata only; Workspace is the stable shared memory identity.

The old multi-user proof of concept must not be revived. New implementation
work should follow this domain model and the accepted AI-client synthesis
boundary in [0001 Rely on AI clients for LLM synthesis](./0001-ai-client-synthesis-only.md).

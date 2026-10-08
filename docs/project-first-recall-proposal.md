# Proposal for Project first memory recall

Proposed future behavior. Implementation is deferred.

Koed can prioritize Personal Memory and authorized Team-shared Memory associated
with the current Git Project, then widen recall when the question needs more
context. A Project is the current repository or code context. A Workspace is a
stable boundary for Team-shared Memory.

[Team Workspace discovery](team-workspace-project-mapping.md) provides access to
authorized scopes. The next design step is to choose relevant scopes and rank
their evidence as memory grows.

## Retrieval order

Use the current Project as the starting context:

1. Search Personal Memory from the current Project and authorized Team-shared
   Memory associated with that Project.
2. If the evidence is incomplete, search other relevant Personal Memory and the
   linked Team Workspace.
3. If the question needs broader context, search additional authorized Team
   Workspaces that match the User's intent.

Rank evidence by relevance, freshness, and source quality within each stage.
Strong Team evidence can outrank weaker Personal evidence. Questions about a
whole Team can start at Workspace scope when the User's intent is clear. Bound
the search effort and report when a limit prevents complete recall.

## Identity and access

Repository identity must work across devices, checkout paths, and Git worktrees.
Branch and worktree context can refine relevance without splitting all knowledge
about the same repository. Local paths alone cannot establish shared Project
identity.

Project associations help select memory. Workspace Access and active Share Grants
determine which Team-shared Memory a User can retrieve. Repository identity does
not grant access, and widening a Search Domain does not authorize a broader
Retrieval Scope.

Team selection remains explicit or follows an enabled Project mapping. Personal
Memory remains the default when no Team scope is selected. Electron and headless
MCP use the same Koed enrollment. Opening a Workspace in Electron does not select
MCP scope.

## Reporting and open decisions

Return the searched scopes, any widening, and material retrieval limits with the
Evidence Bundle. A narrow search can establish that no relevant memory was found
in that Project. It cannot establish that no relevant memory exists elsewhere.
Unavailable Team routing must remain distinct from an empty search result.

Repository identity, widening thresholds, search budgets, and User controls for
mixed Personal and Team recall remain open design choices.

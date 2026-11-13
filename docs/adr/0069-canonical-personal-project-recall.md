# ADR 0069: Canonical Personal Project Recall

## Status

Accepted.

## Context

Named Projects can overlap and include Conversations through direct membership,
Git Anchor rules or exact Folder rules, with explicit exclusions. The Desktop
uses that database membership, while implicit MCP Project recall previously
selected a repository identity. A User's organization changes could therefore
be durable without affecting the agent's default recall boundary.

Selecting only one Project would require another choice for Conversations with
multiple memberships. Recursively following overlapping Conversations would
instead admit Projects the caller never joined. Neither is the selected policy.

## Decision

Implicit Personal Project recall selects the union of Projects containing the
calling Conversation, using the same database membership predicate as the UI.
It does not follow other Conversations into additional Projects. Source Git and
Folder context remain independent facts; organization does not rewrite them.

Resolve the owner-bound Conversation and Project references before accepting a
durable request. Keep that selection across retries, search, expansion and final
question history. Retrieval rechecks current eligibility and exclusions for the
source and current caller membership in each pinned Project. A later addition
does not silently enlarge an already accepted selection; removing membership
cannot retain recall through that removed Project.

Unknown caller identity or zero available memberships is an explicit error,
not a repository or Global fallback. Global remains a deliberate alternative.
Existing explicit targets and deprecated version-zero repository selectors
retain their compatibility boundaries; they do not define the new default.

Native per-call metadata and trusted caller resolvers constrain supplied
Conversation identity. Hook-only body fields are client claims, resolved under
the authenticated User; they are not cryptographic proof of the active native
Conversation. MCP transport sessions are not Conversation identities. Personal
scope selection grants no new ownership or Team access.

Store the accepted selection in existing encrypted task and question metadata.
A Project union has no single Project identifier: do not invent one or record a
Global domain to satisfy storage. The question-history constraint permits this
narrow Personal MCP case, with application validation binding the accepted
selection and existing encryption marker. Team routes retain separate authority.

## Consequences

Automatic Git-based grouping remains useful, while explicit moves/exclusions
change the same scope used by recall. Existing organization and correction APIs
support retained history without requiring its original checkout to exist.

Project recall needs captured Conversation identity and completed membership
reconciliation. Missing capture or pending reconciliation can temporarily make
the default unavailable. The interface must expose that state honestly rather
than silently widen scope or repeatedly poll on the agent's behalf.

Narrower selection workflows and adaptive context expansion are deferred. This
decision does not change Global repository reservation, retrieval budgets,
embedding models, Team sharing or AI Client ownership of synthesis.

# ADR 0057: One Selected Repository Identity

## Status

Accepted. Implemented on the Project integration branch; full capture, retrieval,
and replication cutover is gated by ticket 16.

Supersedes the alias-overlap matching and automatic Project association rules in
ADR 0012's Project Context Association section and section 9 of the Personal
Device Sync protocol. Their encryption, device authority, User ownership, and
Workspace authorization requirements remain in force.

## Context

Remote-set overlap cannot define repository equality. If A selects repository
`a`, B contains remotes for `a` and `b`, and C selects `b`, overlap would join
unrelated Projects through B. Paths cannot identify a repository across clones,
worktrees, or devices. An existing checkout path can also be reused.

## Decision

Select one normalized anchor by this order: local explicit remote selection,
selection supplied for an established replicated Project association, portable
`upstream`, portable `origin`, then device-local Git common-directory identity.
Equivalent SSH and HTTPS addresses identify the same anchor. Remote names,
extra remotes, and historical aliases contribute no other matching values.

An invalid explicit selection, conflicting URLs for the selected remote, missing
associated anchor, or conflicting associated selection is unresolved. It cannot
fall back to another remote. Git discovery failures and ambiguous observations
are distinguished from non-Git Projects. Missing optional branch or HEAD
observations do not invalidate an otherwise established repository identity.

Portable identity uses the selected anchor's `gr_` fingerprint. Device-local Git
identity combines the profile's persisted device salt, common-directory path,
and filesystem incarnation. Non-Git identity combines that salt, path, and stable
checkout identifier. Local checkout identifiers are persisted opaque values
bound to the observed directory incarnation and originating profile/device.
Replacing a directory or Git checkout creates new provenance; selecting an
anchor requires the caller's expected checkout identifier to still match.

A Project association is configuration authority established by explicit User
acceptance. It is separate from equality for recall. The resolver takes a typed
associated-selection input and does not infer or create associations. Equal
independently selected anchors may match without replicating configuration.
The local editor changes only local checkout configuration. It neither writes
replicated selections nor changes recorded Captured Session assignments.

Shared selection editing uses a separate encrypted configuration journal scoped
to the owning User and Personal Device Group. Stable association and selection
identifiers do not establish checkout acceptance by themselves. Acceptance binds
the live local checkout incarnation; ordinary anchor equality never creates it.
Every signed set or deletion revision names the revisions it replaces. Causal
heads determine the shared selection, including concurrent set/delete conflicts.
Resolution replaces exactly the heads the User reviewed and rechecks them in the
write transaction. Retained deletion history prevents offline replay from
restoring a superseded preference. This retains more configuration history than
a clock-based register, in exchange for preserving concurrent edits and explicit
deletions across offline devices. The existing PDS Worker delivers this journal
independently of Conversation capture.

## Consequences

Forks match only when their selected anchors match. Custom remote names need
explicit selection. Worktrees keep separate checkout provenance while sharing
one repository identity. Branch is an observation, not an identity component.
Migration 0046 marks every existing Personal Session unresolved once, including
Sessions captured during additive preparation. It clears automatic and User
override assignments and increments versions. It preserves raw memory,
provenance, and existing Team Share Grant snapshots. Continued capture cannot
resolve this history. Explicit reassignment resolves it, and reset restores
unresolved state. The migration journal prevents repeated startup from clearing
later assignments.

Personal Device Sync must carry one selected anchor through its existing
verified, encrypted, group-keyed boundary. Unsalted Personal fingerprints and
raw local paths must not become relay-visible. Team representation uses the
selected anchor only inside separately authorized Share Grant flows. Repository
identity never chooses a Workspace or grants access. Synthesis stays in the
AI Client.

Directory-incarnation observations are local filesystem evidence, not globally
portable identity or authentication. A restored or replaced checkout must be
rediscovered, and its local selection may need to be set again. This conservative
boundary avoids inheriting a previous checkout's selections and review history.

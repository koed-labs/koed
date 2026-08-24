# First-Class Revisioned Personal Notes

Status: Accepted.

Related decisions:

- [0013 Team Collaboration Authority](./0013-team-collaboration-authority.md)
- [0018 Personal Collaboration Sync And Cross-Platform Secret Providers](./0018-personal-collaboration-and-cross-platform-secret-providers.md)
- [0029 Selective PII Team Representations](./0029-selective-pii-team-representations.md)
- [0033 Generic Logical Memory Source Revisions](./0033-generic-logical-memory-source-revisions.md)

## Context

Personal Notes were initially represented as messages in a special Personal
chat thread. That coupled document editing and Memory Projection to chat
delivery, receipts, unread state, realtime selection, and thread repair. It
also made a mutable Note body impossible without changing message semantics.

Notes need stable identity, safe concurrent edits, durable Projection,
embedding, Personal recall, and privacy-filtered Team sharing. Multiplayer
document editing is a separate problem and is not required for this decision.

## Decision

A Personal Note is a first-class owner-scoped aggregate. Its encrypted title
is mutable through an optimistic title version. Its encrypted body is stored as
immutable, monotonically numbered revisions. Body updates require the expected
current revision and an idempotency key.

Each revision has durable Projection state and may bind one Personal Memory
Event. A new revision does not invalidate the prior current Memory Event until
the replacement Projection succeeds. Successful Projection atomically makes
the new event current and supersedes older Note revisions for Personal recall.
Repair work is bounded, idempotent, and revision-addressed.

Notes are not collaboration threads or messages. They have no chat receipts,
unread state, participants, message delivery, or collaboration selection. Note
events are excluded from Project and Captured Session grouping and from LCM
summarization.

Team sharing supports Snapshot and Continuous modes, with Continuous as the
Desktop default. Initial review always binds one exact Note revision and its
exact projected Memory Event. Snapshot mode remains pinned to that revision.
Continuous mode preserves the same Note and logical-memory identity, then
admits only strictly newer projected revisions through a durable, coalescing
local queue and the enrolled device-credential path. Each revision runs through
the normal privacy pipeline. The prior ready Team derivative remains readable
until the new derivative is complete, and publication switches the grant and
representation atomically. Pause stops advancement while preserving the last
ready derivative; resume catches up to the latest eligible revision; revocation
stops updates and removes Team authority. None of these operations mutates the
Personal Note or its immutable revisions.

Each projected Note revision is bound atomically to one positive generic
logical-memory source revision. Generic sharing rows reference that immutable
revision; Note IDs and Memory Event IDs remain in the typed Personal Note
binding. This preserves generic authorization and publication without implying
that Personal Notes have Captured Session capabilities.

The consolidated alpha migration discards the transitional Notes chat rows and
their dependent payloads instead of converting them. There is no compatibility
path for pre-release Notes chat data.

## Consequences

- Note creation and edits are durable before asynchronous Projection finishes.
- Concurrent devices cannot silently overwrite title or body changes.
- Personal recall keeps the last available revision during replacement work.
- Snapshot provenance remains stable across later edits and renames.
- Continuous sharing coalesces rapid edits without exposing an unclassified
  intermediate revision or making Team reads unavailable during preparation.
- Existing collaboration realtime remains responsible only for chat; protected
  Note invalidations refresh first-class Note state.
- Collaborative document editing requires a later operation-based protocol; it
  must not reinterpret immutable Note revisions as chat messages.

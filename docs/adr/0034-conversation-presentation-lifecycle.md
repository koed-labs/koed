# ADR 0034: Conversation Presentation Lifecycle

- Status: Accepted
- Date: 2026-08-18

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0030 Shared Durable Realtime Client Runtime](./0030-shared-durable-realtime-client-runtime.md)
- [0033 Runner-Owned Worktrees And Execution Checkpoints](./0033-runner-owned-worktrees-and-execution-checkpoints.md)

## Context

Long-running Personal Projects accumulate many Conversations. Recent work needs
to remain easy to reach, while inactive work should stop dominating navigation.
Pinning, settling, and snoozing are presentation choices, not evidence that a
Conversation is archived, deleted, no longer captured, no longer recallable,
or eligible for workspace cleanup.

Using source, Capture, Memory, retention, Share Grant, or execution-workspace
state for navigation would couple unrelated lifecycles. Storing only local UI
state would also make a User's choices disagree across their Koed clients.

## Decision

Koed stores an owner-scoped Conversation presentation record against the
stable logical Captured Session identity. It contains:

- an optional pin timestamp;
- an explicit display mode of `automatic`, `active`, or `settled`;
- optional snooze start and expiry timestamps; and
- an optimistic version and update timestamp.

The default `automatic` mode presents a Conversation as active until three
days after its latest activity, then as settled. This first product boundary is
fixed rather than User-configurable. The renderer computes the deadline from
authoritative activity timestamps and schedules only the next transition; it
does not poll the API.

`active` and `settled` are explicit User overrides. A pin keeps a Conversation
in the visible pinned section regardless of its automatic or explicit display
mode. Snooze temporarily moves an unpinned Conversation out of the active
section. A snooze ends at its expiry or immediately when Conversation activity
advances beyond the recorded snooze start. These rules affect only navigation
placement.

Updates require the current optimistic version. A stale client receives a
conflict and resnapshots instead of overwriting a newer choice. Successful
updates publish a content-free Personal graph invalidation through the existing
durable realtime path. Authorized clients then reload the owner-scoped state.

Presentation state is independent from:

- provider Conversation and transcript source;
- Capture State and Projection;
- Memory Events, LCM Summaries, embeddings, and recall;
- archive, delete, retention, and legal lifecycle;
- Share Grants and Team visibility;
- managed execution, checkpoints, and worktree cleanup; and
- Project membership or ordering.

No presentation mutation may update any of those records or grant access to
another User.

## Consequences

- A User's pin, settle, and snooze choices are durable across their clients.
- Automatic settling reduces navigation clutter without losing Memory or
  source data.
- New activity wakes a snoozed Conversation without a background scheduler.
- Stale clients fail closed through optimistic concurrency.
- Future configurable settling rules or merge-based suggestions can extend the
  presentation contract without reusing archive or retention state.

## Non-Goals

- Reordering pinned Conversations.
- Settling on source-control merge.
- Archiving, deleting, retaining, or cleaning up Conversations or worktrees.
- Changing capture, recall, sharing, or Team visibility.

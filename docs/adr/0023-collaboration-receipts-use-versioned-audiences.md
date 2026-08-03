# Collaboration Receipts Use Versioned Audiences And Monotonic Cursors

Status: Accepted design.

Related decisions:

- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](./0013-team-collaboration-authority.md)

## Context

Koed must show whether an outgoing Chat Message has been sent, delivered to
every recipient, or read by every recipient. Unread badges must also clear only
after the current User has actually viewed the unread content.

Storing one mutable row for every message-recipient pair would make each large
channel message create work proportional to channel size. Computing receipts
against only the current channel membership would be incorrect after members
join, leave, lose Workspace Access, or are disabled.

Delivery and read activity is private recipient behavior. Other Users need only
the aggregate state of messages they sent, not a list of individual recipient
activity.

## Decision

Each thread has immutable, versioned audience snapshots.

- A send resolves the currently authorized audience while holding the thread
  sequence lock.
- If that audience differs from the current snapshot, Koed creates one new
  version and advances the thread's audience version.
- Every message records the audience version that applied when it was sent.
- The sender is part of the snapshot but is excluded from recipient aggregate
  calculations.

Each User has one monotonic receipt cursor per thread.

- Delivery advances when an authorized client has materialized the message.
- Read advances only when the application is focused, the document is visible,
  the final unread row is visible, and the timeline is at its current end for a
  short dwell.
- Advancing read also advances delivery.
- Unread counts are calculated authoritatively from messages after the read
  cursor, excluding the current User's own messages.
- Receipt writes and their durable realtime events commit together.

The sender-facing state for a message is the least complete state across its
original recipients:

- one grey tick: committed and sent;
- two grey ticks: delivered to every recipient;
- two green ticks: read by every recipient.

Koed returns only this aggregate to the sender. A recipient receives only their
own receipt cursor. Realtime events invalidate and update these states without
polling.

## Consequences

- Ordinary receipt writes remain constant-size regardless of channel size.
- Membership changes do not rewrite historical messages or alter their
  recipient meaning.
- Aggregate reads join the bounded message page against one immutable audience
  version and one cursor per recipient.
- Disabled or removed Users remain part of the historical audience for messages
  sent while they were authorized. Their uncompleted receipt therefore keeps
  those historical messages at the appropriate least-complete state.
- Exact per-recipient receipt UI is intentionally unavailable. Adding it would
  require a separate privacy and scale decision.

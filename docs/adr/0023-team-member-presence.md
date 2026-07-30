# Team Member Presence

Status: Accepted.

Related decisions:

- [0013 Team Collaboration Authority](./0013-team-collaboration-authority.md)
- [Team Collaboration Action And Credential Matrix](../team-collaboration-action-credential-matrix.md)

## Context

Team members need a small, current indication of whether another User is
available. Presence must not become an exact activity log, imply that an agent
is working, or add a polling system beside Koed's existing collaboration
realtime path.

Users also need manual states that remain selected until changed. Automatic
presence must degrade while a client is open but idle, even when no new server
event is emitted at each threshold.

## Decision

Koed stores one Team Presence preference and one latest foreground-human
activity timestamp on each Team Membership.

The preference is either:

- `auto`; or
- `manual`, with `available`, `do_not_disturb`, or `out_of_office`.

Manual presence persists until the User changes it. Automatic presence derives
one coarse level from the newest accepted human activity signal across that
User's devices in the Team:

- `active`: at most 5 minutes;
- `recently_active`: over 5 and at most 30 minutes;
- `idle`: over 30 minutes and at most 2 hours;
- `inactive`: over 2 hours, missing, or invalid.

The collaboration snapshot carries a versioned manual-status catalogue with
stable keys and display labels. Clients use that catalogue for available
controls instead of treating a compile-time enum as the wire contract. A client
that receives a valid but unknown future status key renders a neutral unknown
state while retaining the catalogue version and entries; it does not reject the
Team roster or guess that the User is available.

Only foreground human interaction may report activity. Pointer or keyboard
interaction, window focus, and a transition to a visible document qualify.
Capture Hooks, AI Clients, agent execution, embedding, LCM work, sync,
background jobs, SSE heartbeats, and receipt of remote events do not.

Clients coalesce activity reports and the repository rate-limits durable
writes. Reports name the Teams currently visible to the authenticated User;
the server independently accepts only enabled Memberships. Personal API Tokens
cannot read or mutate Team Presence.

Preference and accepted activity changes use the existing collaboration outbox
and authorized SSE subscription. The materialized update contains only the
bounded Team person contract. Manual mode omits the last activity time and
automatic activity level so that choosing a manual status does not leak a
parallel activity signal.

Automatic threshold transitions do not require server writes. A client
schedules one timeout for the next transition represented in its current
snapshot, recomputes the display, and schedules the next transition. Reconnect
and snapshot recovery remain authoritative. Interval polling is not used.

Preference writes use optimistic versions. Unauthorized writes fail before
version conflict handling; a stale write by an authorized User returns a
conflict and must reconcile from authoritative state.

## Consequences

- Presence updates arrive through the same durable, authorized Team stream as
  other collaboration state.
- Multiple devices converge on the newest accepted activity signal without
  selecting a permanent primary device.
- Manual states are stable and privacy-preserving.
- Automatic colors can age correctly without network polling.
- Agent activity remains a separate future domain rather than being inferred
  from human presence.

## Non-Goals

- Exact last-seen history or activity analytics.
- Read receipts or typing indicators.
- Agent, tool, worker, Capture Hook, sync, or embedding status.
- Calendar-derived availability.
- User-defined status text or expiry schedules.

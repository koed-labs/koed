# Team Conversation Source Sharing

## Purpose

Conversation Source Access lets the owner of a Team-shared Captured Session
separately expose verified source records to currently authorized members of
the same Team and Workspace. It supports read-only source inspection, live
observation, and explicit fork-snapshot export. It does not change the active
Memory Event, LCM leaf, or LCM rollup representation.

## Owner Operations

The owner first creates a normal Captured Session Share Grant. Source access is
then enabled with:

- `PUT /v1/shared-memory/share-grants/:shareGrantId/transcript-access`
- `POST /v1/shared-memory/share-grants/:shareGrantId/transcript-access/revoke`

The enable request chooses `snapshot` or `continuous`, carries an optimistic
version and mutation ID, and requires a fresh browser session or an exact
one-use Action Grant. A snapshot pins the current committed segment frontier.
Continuous mode follows later verified source generations with the same
logical source identity. Revocation takes effect independently of semantic
sharing.

## Member Reads

Authorized Team members use:

- `GET /v1/shared-memory/share-grants/:shareGrantId/transcript/manifest`
- `GET /v1/shared-memory/share-grants/:shareGrantId/transcript/segments/:segmentId`
- `GET /v1/shared-memory/share-grants/:shareGrantId/transcript/stream`
- `POST /v1/shared-memory/share-grants/:shareGrantId/transcript/fork-snapshot`

The manifest contains bounded structural metadata and segment descriptors. The
segment route returns one verified and decrypted NDJSON source segment with
`no-store` caching. The SSE stream carries `ready`, segment-availability,
generation-change, and access-loss events, not source plaintext. Clients fetch
new segments through the segment route.

Fork snapshots require a fresh browser session and return a bounded verified
NDJSON snapshot through a completed turn. Parent session, source generation,
frontier, and digest are returned as response headers. The caller is responsible
for asking its AI Client to create a new Conversation from that snapshot.

## Authorization

All reads fail closed unless the current request satisfies every one of these
conditions:

1. browser session or scoped device credential authentication;
2. active, entitled Team;
3. enabled User and Team Membership;
4. active Workspace and current read or write Workspace Access;
5. active Captured Session Share Grant;
6. active, unexpired source-owner consent;
7. active Conversation Source Access grant; and
8. valid Conversation Source Artifact lifecycle.

Personal deletion or source-owner account disablement makes exact source
unavailable. Existing Team semantic retention does not retain raw source.

Personal API Tokens have no Team source authority. Team, Workspace, grant,
artifact, segment, and viewer identities are bound server-side. Missing or
mismatched resources return no source content.

## Operational Properties

- Source bytes use the existing signed and encrypted Conversation Source
  Journal; there is no second copy made for Team sharing.
- PostgreSQL notifications wake live streams after committed changes. Durable
  database rows remain the replay source.
- Opaque cursors bind replay position to the viewer and Share Grant.
- Client and per-principal stream limits, backpressure bounds, transport
  heartbeats, and event-driven authorization rechecks protect long-lived
  connections without polling.
- Audits contain structural IDs, counts, digests, and action classes only.
- No UI is required by this backend contract.

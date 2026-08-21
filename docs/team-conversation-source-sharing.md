# Team Conversation Source Sharing

## Purpose

Conversation Source Access lets the owner of a Team-shared Captured Session
separately expose sanitized, verified source records to currently authorized
members of the same Team and Workspace. The exact Conversation Source Journal
remains unchanged and owner-only. Source access supports read-only inspection,
live observation, and explicit fork-snapshot export, and remains separate from
the cumulative Memory Event, LCM leaf, and LCM rollup fidelity ceiling.

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
segment route returns one verified, decrypted, sanitized NDJSON Conversation
Source Artifact segment with `no-store` caching. The SSE stream carries
`ready`, segment-availability, generation-change, and access-loss events, not
source plaintext. Clients fetch new sanitized segments through the segment
route.

Fork snapshots require a fresh browser session and return a bounded verified,
sanitized NDJSON snapshot through a completed turn. Parent session, sanitized
source generation, frontier, and digest are returned as response headers. The
caller is responsible for asking its AI Client to create a new Conversation
from that snapshot. A fork snapshot cannot recover the owner's original values.

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

Personal deletion or source-owner account disablement makes Team source
artifacts unavailable unless an applicable retention decision preserves the
sanitized artifact. Team retention never makes exact Personal source readable.

Personal API Tokens have no Team source authority. Team, Workspace, grant,
artifact, segment, and viewer identities are bound server-side. Missing or
mismatched resources return no source content.

## Operational Properties

- The exact signed and encrypted Conversation Source Journal remains the
  owner's canonical source. Team reads use separately encrypted sanitized
  Conversation Source Artifacts bound to source generation, committed
  frontier, classifier generation, effective content-policy hash, and artifact
  digest.
- Snapshot mode pins one sanitized frontier. Continuous mode classifies only
  newly committed immutable records and publishes a new sanitized generation
  atomically. Classification or policy failure preserves the prior committed
  frontier and leaves new Team material pending.
- The versioned content policy covers `account_number`, `private_address`,
  `private_email`, `private_person`, `private_phone`, `private_url`,
  `private_date`, and `secret`. Model spans are unioned with deterministic
  structured-key and credential-format detection. This best-effort filtering
  reduces exposure; it does not guarantee anonymization or complete secret
  detection.
- PostgreSQL notifications wake live streams after committed changes. Durable
  database rows remain the replay source.
- Opaque cursors bind replay position to the viewer, Share Grant, and exact
  sanitized artifact generation. Any artifact-ID rollover resets replay to byte
  zero even when classifier and policy hashes are unchanged, preventing a
  prior generation's offset from skipping records in its replacement.
- Client and per-principal stream limits, backpressure bounds, transport
  heartbeats, and event-driven authorization rechecks protect long-lived
  connections without polling.
- Audits contain structural IDs, counts, digests, and action classes only.
- The owner Shares detail presents source access separately as `absent`,
  `snapshot`, `continuous`, or `revoked`. Granting it uses Step-up and warns
  that prompts, tool calls, tool results, Approval Activity, and other
  non-Memory records can be exposed. Revocation uses Native review, closes
  streams, and leaves semantic access unchanged. Parent Share Grant revocation
  makes source access unavailable.

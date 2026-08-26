# Team Collaboration Architecture

Koed combines local Personal collaboration and remote Team collaboration in one
Desktop application while preserving separate identity, storage, credential,
authorization, availability, and lifecycle boundaries.

This document defines the canonical service, data, authorization, realtime,
Projection, and UI boundaries for Team collaboration. The hard-to-reverse
authority and rollout decisions are recorded in
[ADR 0013](adr/0013-team-collaboration-authority.md). The complete list of
Team-facing Shared Memory exposure paths and their fail-closed requirements is
maintained in the [Shared Memory Surface Inventory](shared-memory-surface-inventory.md).
The implemented Desktop information model, User workflows, lifecycle language,
accessibility behavior, and responsive layouts are documented in
[Koed Desktop](desktop-ui.md).

## Product Model

```text
User
|
+-- Personal
|   +-- Personal Memory
|   +-- Notes to self
|   +-- Personal channels
|
+-- Team
    +-- Team people
    +-- Team-scoped direct messages
    +-- Workspace
        +-- Channels
        +-- Team-shared Memory
            +-- Shared Captured Session
                +-- Authorized source representation
                +-- Companion Team discussion
```

- Personal is not a synthetic Team.
- A User may belong to zero or more Teams.
- A Team is the membership and member-communication boundary.
- A Workspace is a stable collaboration and Team-shared Memory subdivision
  within a Team.
- A Project is local AI-client or code context. It may resolve to a Workspace,
  but it is not an authorization key.
- Every Team channel belongs to one Workspace.
- Team direct messages and group direct messages belong to one Team and do not
  belong to a Workspace.
- Personal channels and notes-to-self belong only to their Personal owner.
- A shared Captured Session appears in the Workspace named by its Share Grant.
- Its companion discussion is attached to the shared source and does not appear
  in the ordinary channel list.
- Workspace confidentiality protects Workspace content. Every enabled Team
  member may discover the bounded Team roster and start a Team-scoped direct
  message with another enabled member.

## Service Boundary

```text
Electron renderer
      |
      | allowlisted typed preload IPC
      v
Electron main
      |
      | authenticated OS-local transport
      v
Local koed-server
      |                         \
      | Personal operations     \ enrolled Team operations
      v                          v
Local Personal store       Remote koed-server
                                  |
                                  v
                         Teams and Workspaces
```

### Desktop And Local Edge

- The renderer communicates only with Electron main through an allowlisted,
  typed preload API. It does not receive a general HTTP proxy.
- Electron main bridges renderer lifecycle and typed commands to the separate
  local `koed-server`. It does not own Team authorization, durable Team cursors,
  remote credentials, or remote sockets.
- Local `koed-server` owns remote backend registration, capability validation,
  browser-mediated enrollment, credential storage, upstream HTTP routing,
  upstream realtime sockets, replay, reconnect, durable cursors, and queued
  Team operation state.
- Outbound upstream requests reject redirects and unsafe schemes, resolve and
  classify the destination on every connection, and pin the approved address so
  DNS cannot redirect an accepted request into a different trust boundary.
  Private-network destinations require an exact operator-managed backend
  registration; link-local, metadata, indirect-loopback, and mixed-trust DNS
  results always fail closed.
- The Supported Capture Hook and MCP Server continue to target local
  `koed-server`.
- Approved local integrations use a Local-Edge Client Credential scoped to one
  enrolled backend and explicit operation families. They never receive the
  upstream device credential.
- Electron main starts the broker as a child over an inherited Node IPC channel
  authenticated by a fresh per-process 256-bit handshake token. Broker access
  to the loopback-only local API uses the authenticated per-install credential.
  DTOs are schema-validated at the local-server boundary, at Electron
  main/preload, and before renderer state mutation.
- Local snapshot and acknowledgement responses expose only the bounded Desktop
  subscription contract. Durable cursors, upstream subscription identifiers,
  acknowledgement metadata, and other broker state remain inside local
  `koed-server`.
- The renderer does not persist device credentials, provider tokens, API
  Tokens, browser cookies, remote session material, decrypted Team content, or
  remote API-base configuration.

### Backend And Identity

- One enrolled remote backend may expose multiple Teams.
- Local Personal and remote Team Users have different IDs. Enrollment binds one
  local profile/device to one verified remote provider subject for one backend.
  Matching email addresses do not link identities.
- Team Membership, Team role, Workspace Access, Share Grants, lifecycle state,
  retention state, and entitlements remain remote Team-backend records checked
  at request time.
- A remote outage makes Team surfaces unavailable or reconnecting without
  blocking Personal notes, Personal channels, or Personal Memory.
- Koed does not persist a decrypted offline Team-content cache.
- Desktop may keep a bounded, memory-only cache of recently authorized Team
  navigation and Shared Memory views. Current realtime events invalidate
  affected entries before revalidation, and authority loss, disconnect,
  backend change, or identity change purges the cache. The cache is never an
  authorization source and is not written to disk.
- Disconnect, backend change, remote identity change, or broker revocation
  closes upstream connections, removes or revokes Team credentials, clears
  Team cursors and metadata caches, cancels or quarantines queued Team writes,
  and clears renderer and IPC Team state. Personal data and Personal credentials
  remain unchanged.

## Collaboration Data

### Thread Scopes

Team Chat Threads express their scope and kind directly.

| Kind                      | Scope    | Owner | Team | Workspace | Participants                   |
| ------------------------- | -------- | ----- | ---- | --------- | ------------------------------ |
| Notes to self             | Personal | yes   | no   | no        | owner                          |
| Personal channel          | Personal | yes   | no   | no        | owner                          |
| Team channel              | Team     | no    | yes  | yes       | current Workspace audience     |
| Direct message            | Team     | no    | yes  | no        | two enabled Team members       |
| Group direct message      | Team     | no    | yes  | no        | immutable enabled member set   |
| Shared-session discussion | Team     | no    | yes  | yes       | current shared-source audience |

The data model enforces valid scope combinations and durable identity:

- one notes-to-self thread per Personal owner;
- unique active normalized Personal-channel names per owner;
- unique active normalized Team-channel names per Workspace;
- one direct-message thread per normalized User pair and Team;
- one group direct-message thread per immutable normalized participant set and
  Team;
- one companion discussion per logical shared source and Workspace;
- same-Team and same-Workspace foreign-key relationships;
- same-thread read cursors and message references; and
- immutable shared-source identity and complete summary provenance.

Threads retain stable IDs, normalized keys, lifecycle timestamps, archive
state, activity time, and optimistic versions. Archive hides a thread or
Workspace from normal navigation without physically deleting retained content.

### Messages, Unread State, And Receipts

- A Team Chat Message has a stable ID, thread and scope, sender identity and
  kind, encrypted body, server-authoritative timestamps, a client idempotency
  key, a monotonically increasing thread sequence, and the immutable audience
  version that applied when it was sent.
- Repeating an idempotent send produces one stored message and one logical
  realtime event. Reusing a key for different content is a conflict.
- Edit and deletion lifecycle fields are reserved but do not create message
  edit or User-deletion behavior.
- Delivery and read state are private per User and thread and advance
  monotonically by validated cursors from that thread. Read also advances
  delivery.
- Unread counts exclude the current User's own messages and come from
  authoritative server state.
- An outgoing message exposes only an aggregate status: sent, delivered to
  every original recipient, or read by every original recipient. Koed does not
  disclose individual recipient activity.
- Thread audiences are versioned only when authorized membership changes, so
  historical receipt meaning does not change when members join or leave.
- Receipt changes are delivered through the durable realtime stream without
  polling.
- Removed or unauthorized Users cannot send messages, read history, update read
  state, or receive realtime activity.

### Encryption

Remote Team message bodies, thread and channel names, topics, descriptions,
persisted previews, sensitive metadata, and idempotency payloads use Team-scoped
application-layer envelope encryption. Structural authorization metadata may
remain queryable: opaque IDs, scope relationships, participant IDs, thread
kind, sequence, lifecycle state, timestamps, ciphertext references, and
idempotency hashes.

Authorization occurs before Team-key unwrap and decryption. Plaintext Team
content does not enter queue payloads, outbox records, caches, audit records,
logs, metrics, diagnostics, or error responses. A key, encryption, or outbox
failure rejects the write; there is no plaintext fallback. Commercial key
handling follows
[ADR 0009](adr/0009-commercial-saas-encryption-key-management.md).

## Authorization Boundary

Credentials identify an actor or enrolled device. They do not embed current
Team authorization. Every route, broker command, IPC operation, snapshot,
replay batch, and live event resolves authorization from current server state.
The endpoint- and channel-level rules are defined in the
[Team Collaboration Action And Credential Matrix](team-collaboration-action-credential-matrix.md).

| Operation family              | Personal owner                   | Scoped enrolled device                  | Remote browser session                      | Personal API Token |
| ----------------------------- | -------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------ |
| Personal chat read/write      | local owner only                 | no remote authority                     | no local Personal authority                 | denied             |
| Team catalog and roster read  | no implicit authority            | explicit scope plus Team authorization  | allowed after Team authorization            | denied             |
| Team chat read                | no implicit authority            | explicit read scope plus authorization  | allowed after thread authorization          | denied             |
| Team chat write               | no implicit authority            | explicit write scope plus authorization | allowed after thread authorization          | denied             |
| Team-shared Memory read/live  | source ownership is insufficient | explicit scope plus grant authorization | allowed after grant/Workspace authorization | denied             |
| Share creation or change      | initiates and consents locally   | explicit scoped operation               | allowed after source/Workspace checks       | denied             |
| Team/Workspace administration | no implicit authority            | browser-confirmed action grant          | allowed after role and action checks        | denied             |

### Scope Predicates

- Personal threads require ownership for reads, writes, history, read state,
  and realtime.
- Team direct messages require enabled Team Membership and explicit thread
  participation.
- Team channels require enabled Team Membership and active Workspace Access.
  Posting additionally requires Workspace write access.
- Team-shared Memory and companion discussions require enabled Team Membership,
  active Workspace Access, an active Share Grant, a permitted active
  representation, and applicable Team, Workspace, entitlement, archive,
  suspension, retention, and encryption gates.
- Team owners and administrators still need Workspace Access to read Workspace
  content and Workspace write access to post there.
- The ordinary Team roster remains a bounded discovery surface. Team owners and
  administrators receive membership role, status, version, email, and explicit
  Workspace Access IDs, levels, and versions only through the manager-authorized
  People administration surface.
- Workspace lifecycle and access mutations send content-free resnapshot signals
  to Team readers. Clients purge stale Team state before loading a newly
  authorized snapshot, so grants and removals take effect without polling or
  exposing inaccessible Workspace metadata.
- Client-supplied IDs are untrusted and are joined back to the authenticated
  scope before content selection or decryption.

### Read Composition And Prewarming

- The Team backend exposes bounded aggregate read contracts for initial Team
  navigation and for the newest authorized Shared Memory source page with its
  companion discussion. The backend returns only that bounded page rather than
  transferring the complete representation. Aggregation reduces network round
  trips without weakening the underlying Team, Workspace, Share Grant,
  representation, or thread predicates.
- The local edge validates every aggregate relationship before projecting it
  into the Desktop contract. It may deduplicate concurrent reads and reuse a
  bounded navigation result, but validated upstream realtime events invalidate
  that result immediately.
- Desktop prewarms only a bounded set of the most recently active, ready Shared
  Memory sessions with bounded concurrency. Selecting a warm session renders
  the memory-only view immediately, then revalidates it through the normal
  command path.
- A cold Shared Memory selection renders its newest bounded page first, then
  follows authorized older-page cursors asynchronously until the renderer's
  row budget is full or the beginning is reached. This applies equally to
  Memory Events, LCM leaves, and LCM rollups and does not use polling.
- Realtime remains the freshness mechanism. This flow does not poll, persist
  decrypted Team content, or treat cached data as current authorization.

### Device And High-Risk Authority

- Team catalog, chat read, chat write, Team-shared Memory, share management, and
  browser-confirmed actions are separate device operation families. The
  `action_grant` family is grant mediation, not reusable administration
  authority; the exact one-use grant retains the underlying `admin` action
  binding.
- Operation grants are action allowlists bound to the backend and, where
  possible, Team. Wildcard grants are prohibited.
- Team creation, invitations, role changes, member disablement, Workspace access
  management, retention or hold management, and destructive lifecycle actions
  require recent browser reauthentication or per-operation confirmation plus
  request-time role checks.
- Team creation always creates exactly one default Workspace and its structural
  `#general` in the same idempotent transaction. Workspace creation also always
  creates its structural `#general`; shared commands and Desktop expose no
  caller-controlled channel-omission field.
- High-risk grants are short-lived, action-specific, device-bound,
  backend-bound, Team-bound where applicable, and audited.
- Personal API Tokens are denied for Team catalog, chat, Shared Memory,
  companion, realtime, sharing, invitation, Workspace, and administration
  operations. They also do not authorize Personal collaboration UI operations.

## Team-Shared Memory

Team-shared Memory remains owned by its originating User. Sharing changes
authorization and does not transfer ownership, copy the logical memory
lifespan, or turn a Captured Session into Team Chat.

### Cross-Deployment Flow

```text
Local authoritative Captured Session
        |
        | policy-controlled Cross-Identity Sync
        v
Owner-private remote replica
        |
        | Share Grant
        v
Grant-scoped Team representation
        |
        v
Workspace shared-source view and companion discussion
```

- The Personal owner explicitly consents to snapshot sync for one exact source
  revision or continuous sync for future revisions admitted by the same
  versioned source, content, and representation policy.
- Initial preview and share use the same redacted DTO, source revision, policy
  revision, classifier version, and content hash. Preview drift is rejected.
- The enrolled remote identity must match the sync relationship and have
  current `workspace.memory.share_owned` authority for the destination.
- The remote replica is owner-private and deduplicated by stable logical Memory
  identity. It is not owned by a Team, Workspace, or Share Grant.
- A Team receives a grant-scoped authorized representation encrypted under its
  Team boundary. Team clients never read the owner-private replica or receive a
  cross-Team correlation identifier.
- Sync is durable and idempotent. When the source is offline, the Team may see
  only the last authorized remote revision with freshness state. When the
  remote backend is unavailable, Team content is unavailable.
- After a target revision is ready, every active continuous Share Grant bound
  to that replica is rematerialized under its existing exact consent and policy
  binding. Snapshot grants remain pinned to their consented revision. The new
  Team representation becomes visible only after encrypted materialization
  commits; clients receive the normal Shared Memory realtime update rather than
  polling the source.
- `hasSynchronizedRevision` records whether at least one target revision has
  completed successfully; it is not a synonym for current sync readiness. It
  remains true while a later revision is processing and after sync revocation,
  because the last synchronized revision may still exist. `syncState` reports
  the relationship's current transfer/freshness state. A stale target revision
  is excluded from Recall until a successful package or authenticated durable
  heartbeat makes it ready again.
- Sync revocation stops future propagation and marks the replica stale. Share
  revocation ends ordinary Team access, leaves the owner-private replica intact,
  and atomically schedules the Share Grant's separate retention lifecycle. An
  active Share Grant may continue to expose the last authorized synchronized
  revision after sync revocation, subject to freshness and Team retention
  policy. Access revocation remains distinct from later retention expiry, legal
  hold evaluation, and hard purge.

### Representation Authority

The supported Team representations are `memory_events`, `lcm_leaves`,
`lcm_rollups`, and consent-bound `curated_assertions`. A Curated Memory Share
Grant is eligible only when its complete direct-source provenance is confined to
the granted Captured Session; mixed-session or incomplete provenance fails
closed.

- A Share Grant stores immutable logical source identity, the source owner's
  allowed representation set, one selected active representation, policy
  revisions, lifecycle identity, and creating authority.
- Team and Workspace policies each provide an allowed representation set. The
  active representation must be in the intersection of all three sets.
- No representation is assumed less sensitive than another. There is no
  inferred permission or fallback to whatever source rows exist.
- Only the source owner selects the initial or replacement representation.
  Higher fidelity or expansion of the owner's allowed set requires a new exact
  preview and explicit consent.
- Team and Workspace managers may reduce their policy sets or revoke the Share
  Grant. They cannot select a replacement, expand owner consent, or share
  another User's source.
- A policy change that excludes the active representation makes the source view
  unavailable until the owner explicitly selects an allowed replacement.
- Derived leaves and rollups have complete provenance inside the one shared
  logical source. Cross-session summaries are not eligible.
- Share-bound summaries are produced locally by the LCM Summary Service through
  the connected AI Client. The Team backend does not perform LLM synthesis or
  substitute another representation when a summary is unavailable.
- A completed share-bound summary snapshot carries the exact source Event and
  child-node provenance, summary model, prompt version, structured schema,
  LCM algorithm version, timestamps, and canonical revision hash through
  encrypted Cross-Identity Sync. The target reconstructs owner-private
  encrypted nodes and produces its own embeddings; source vectors and
  source-local node identities never cross the deployment boundary.
- Summary snapshots are atomic. A changed revision replaces and invalidates the
  prior target nodes, while an authoritative empty snapshot removes them. An
  event-only sync package leaves the last acknowledged summary snapshot alone.
  The requested representation remains pending until the exact source snapshot
  is acknowledged; the target does not compact synchronized Events locally.
- Replacement is authoritative for the complete summary snapshot, not an
  append. Target apply invalidates the replaced nodes and target-owned
  embeddings before the replacement becomes recallable. Stream resnapshot is a
  separate client-state operation: a replacement, expired cursor, or
  authorization invalidation causes the client to discard the affected
  protected state and load one fresh authorized snapshot before subscribing
  after its high-water cursor.
- A versioned server-side allowlist classifies shareable source item schemas.
  Unknown item types, unknown schema versions, hidden reasoning, system
  instructions, credentials, and unsupported protocol items fail closed. Tool
  inputs and results cross the Team boundary only after eligibility checks and
  secret redaction.
- Encrypted representation chunks declare their authenticated-data format
  version. Version 1 authenticates each chunk's item offset, item count, and
  total item count so a cold read can decrypt only the newest bounded page.
  Readers fail closed when the version or paging metadata does not match the
  supported format. A future format change requires an explicit data reset or
  migration that decrypts and re-encrypts affected chunks; readers must not
  infer compatibility.

### Companion Discussion

One companion Team Chat Thread exists for each logical shared source and
Workspace. It is created idempotently, derives its audience from the active
Share Grant and Workspace authorization, and remains separate from the shared
source representation.

Revoking a Share Grant makes the discussion inaccessible and starts its
grant-scoped retention clock without immediately deleting retained history.
Restoring the untouched pending grant before purge begins cancels that purge
work and restores the same discussion. Once purge has started, restoration is
rejected. Sharing to another Workspace creates another discussion. A
representation reduction removes the prior source representation from ordinary
access but does not erase Team-authored statements already made in the
discussion.

## Realtime Boundary

HTTP supplies authoritative snapshots and paginated history. Realtime adds
durable, push-based updates without polling application data.

- A collaboration mutation and its durable outbox event commit in one database
  transaction. The same transaction emits the database wake-up signal after the
  outbox row exists, so active streams can react immediately without making the
  signal the source of truth.
- A source Cross-Identity Sync acknowledgement that changes `processing` to
  `ready` commits one content-free `personal_memory_changed` outbox event in the
  same transaction. The row stores only owner, logical-memory, Captured Session,
  cursor, and mutation identities. Replay reauthorizes the owner and materializes
  the current `PersonalMemoryEntry`; titles, project labels, previews, and other
  display content never enter the outbox.
- A continuous Team representation advancement commits through the existing
  Shared Memory outbox. It does not publish owner-private payloads, sync package
  content, or reusable cross-Team identifiers.
- Each event has a stable event ID, typed versioned envelope, opaque
  backend-bound and principal-bound cursor, occurrence time, resource identity,
  and minimal encrypted or content-safe payload.
- An authorized snapshot and high-water cursor are read from one consistent
  database snapshot. Replay starts after the high-water cursor.
- The database outbox is the replay source of truth across transaction recovery,
  API restart, socket disconnect, and horizontal fanout.
- Physical outbox cleanup atomically advances content-free replay low-water and
  high-water cursors before deleting events. Personal watermarks are isolated by
  owner and Team watermarks by Team; a reconnect cursor below its authorized
  scope's low-water requires an authoritative snapshot. Snapshot cursors use the
  greater of the retained high-water and the live scoped outbox tail, so cleanup
  cannot regress a cursor or force repeated snapshot recovery.
- Filtering can create cursor gaps; clients never infer missing data from cursor
  continuity.
- Active streams reauthorize at most every four seconds, leaving processing
  headroom inside the five-second revocation guarantee even when an advisory
  database notification is missed.
- Local `koed-server` owns the remote socket and durable acknowledgement state.
  It forwards only typed authorized events to Electron main and the renderer.
- One renderer subscription owns each Personal or Team scope. Replacing or
  abandoning a scope explicitly tears down its prior local subscription, and
  concurrent subscription attempts for the same scope are deduplicated.
- The local upstream registry identifies one explicit active Team backend for
  Desktop navigation and implicit broker routing. Disconnected or revoked
  records cannot become authoritative through array order; no active selection
  means Team routing fails closed while Personal remains available.
- The renderer applies events idempotently by event ID before acknowledging
  them. Local `koed-server` advances its durable upstream cursor only after that
  applied acknowledgement.
- Personal Memory sync-state changes use the same replay and acknowledgement
  path as collaboration updates. LISTEN notifications only wake replay; a stream
  always replays after subscribing, so a commit in the listen setup window is
  recovered without renderer polling. Missing, malformed, or wrong-owner
  materialization closes with `requires_snapshot`.
- A crash after renderer application but before acknowledgement causes replay
  and deduplication. A renderer restart begins from a fresh authorized snapshot
  because its prior protected content was discarded.
- A retryable acknowledgement failure stays at the head of the renderer queue;
  later deliveries cannot overtake it, and redelivery retries acknowledgement
  without applying the event twice. A subscription/version conflict requests a
  fresh authorized snapshot. Only an authorization or lifecycle denial may be
  represented as access revocation.
- Personal and Team connection health are independent. Personal stream events
  cannot change Team backend authority, clear Team state, or report Team
  connection health.
- Reconnect reauthorizes and replays still-authorized missed events before live
  mode. An expired cursor produces a fresh authorized snapshot.
- Authorization is checked for snapshot selection, every replay batch, and live
  serialization. Authorization loss forces stream closure and protected-state
  clearing even when an advisory revocation event cannot be delivered.
- Team or Workspace lifecycle and access mutations are content-free
  invalidation signals for every active Team member. They remain deliverable
  after the mutation removes a member's Workspace Access, but never carry the
  inaccessible Workspace DTO. Each terminal control is bound to the exact local
  subscription and forces a new authoritative snapshot.
- The renderer purges the affected Team before resnapshotting. It restores the
  prior selection only if the fresh snapshot still authorizes it; otherwise it
  falls back to that Team's People view when Team membership remains valid, or
  to Personal when the Team itself is no longer authorized. A successful
  resnapshot clears the transient warning and starts a new Team subscription.
- Heartbeats, bounded buffers, acknowledgement deadlines, backpressure,
  reconnect limits, jitter, replay limits, and defined close reasons prevent
  unbounded resource use. SSE comment heartbeats are transport liveness only and
  never enter the application event parser or trigger reconnects.

Realtime event families cover Team and Workspace lifecycle or access changes,
thread creation and archive, Team Chat Message creation, current-User read
state, Share Grant and representation changes, newly permitted Memory Events or
LCM summaries, companion activity, and access revocation.

## Projection Boundary

Personal notes, Personal channels, Team channels, Team direct messages, group
direct messages, and companion discussions are not Projection inputs.

- Team Chat Messages do not create Memory Events, embeddings, LCM work,
  Evidence Bundles, graph content, or AI-client prompts.
- Companion messages are never returned as shared source representation,
  source evidence, graph expansion, summary provenance, or recall content.
- Chat records retain stable source identity, ordering, timestamps, lifecycle,
  and provenance fields so a separately accepted Capture Policy and source
  adapter can support Projection without changing chat identity.
- No backend LLM synthesis is introduced. The connected AI Client remains the
  synthesis authority for Answer Synthesis and LCM summaries.
- Shared Captured Sessions retain the existing capture, Projection, Memory
  Event, Memory Node, embedding, and recall paths. Team visibility is applied
  through Cross-Identity Sync, Share Grants, authorized representations, and
  request-time retrieval predicates rather than chat storage.

## Shared Memory Semantic Recall

An available Team representation creates pending, plaintext-free semantic item
metadata containing only grant-scoped pseudonyms, item/chunk positions,
revision and policy versions, and content hashes. The normal Worker embedding
reconciler first proves the Share Grant, consent, policies, representation,
replica, sync relationship, Team, and Workspace are still current, then
decrypts only the precise already-redacted representation item and submits it
to the Embedding Service while the exact authorization rows remain protected
by a shared transaction lock. Revocation takes conflicting locks: a completed
revocation prevents decrypt and handoff, while an already-active embedding
lease finishes its handoff before revocation can commit. Queryable vectors
remain sensitive data inside the trusted backend search boundary; readable
Team source remains encrypted.

Search is always bound to the current User and requested Team Workspace. It
applies Membership, active User, Team entitlement/lifecycle, Workspace Access,
Share Grant, consent, all three policy versions, latest authorized
representation revision, sync/replica freshness, and retention predicates
before candidate decrypt. Exact hints are checked only after semantic search
has selected that bounded authorized candidate set. They annotate and boost
each matching candidate independently; they are not conjunctive admission
requirements, and hints may match different evidence items. Expansion repeats
the same authorization and stays within the candidate's grant, representation,
revision, and encrypted materialized closure. Rollups expand to authorized
child leaves, leaves to authorized source evidence, and Curated assertions to
authorized direct evidence. API Tokens remain Personal-only; browser sessions and scoped
device credentials can use Team search, answer evidence, and candidate
expansion through the existing local-edge routes. The Team graph remains
unavailable.

At the start of a Team Memory Answer, the API freezes the exact admitted Share
Grant IDs and the PostgreSQL row versions for the User, Team, Workspace,
Membership, and Workspace Access records. A signed, short-lived token binds
that boundary to the User and Workspace and is forwarded by trusted MCP code
for every subsequent search and expansion. The model cannot supply or broaden
it. New grants remain outside the run; revocation or authority-row replacement
fails closed immediately and a later regrant does not reopen the old run. The
boundary is capped at 128 grants so oversized scope fails explicitly rather
than being truncated.

The accepted Search Domain and time selectors are repository predicates, not
advisory hints. Session scope matches the Shared Memory's Captured Session;
Project scope matches that session's effective Project; `recent_days` uses the
database clock over source occurrence time; and explicit source bounds apply to
the same field. Expansion applies the identical predicates. Parent-candidate
search is also Share-Grant-bound, so a candidate from another grant cannot
broaden retrieval. Search and expansion preserve canonical grant-scoped source
identity, allowing the answer worker to deduplicate repeated evidence while
preserving genuinely distinct child sources. Expansion never emits the
selected parent as its own child.

Team staged recall follows the Personal retrieval contract: `score_scan`
returns bounded grant-scoped candidate counts and top scores independently for
each available representation, without hydrating or decrypting readable
evidence;
`rollup_search`, `scoped_leaf_search`/`leaf_search`, and
`fresh_pending_search` select only rollups, leaves, and Memory Events,
respectively, while `curated_memory_search` selects eligible consent-bound
Curated Memory. Parent candidate IDs bound leaf search to the same logical
Captured Session, and `strict_limit` is applied during vector candidate
selection. Unsupported plaintext/raw stages return no Team candidates.

The MCP Server obtains the signed Team authorization boundary from one initial
Team Memory Answer request before starting its local answer worker. Every
worker search and expansion reuses that same boundary. The API's embedding
request uses the trusted internal-service transport; local-edge upstream fetch
policy is reserved for user-configured remote backends.

The embedding generation is more than a model label. It versions the trusted
item composition (plain redacted event/tool text and LCM summary text followed
by a separate `Lexical anchors` section), deterministic arithmetic-mean chunk
pooling with L2 normalization, and the configured tokenizer, input transform,
service pooling, and service normalization. A generation mismatch is not
searchable and is reconciled as a new embedding.

Alpha upgrades do not backfill pre-existing active encrypted representations.
They must be reset or rematerialized. The Worker readiness check reports active
representations with no semantic metadata instead of silently leaving them
unsearchable.

This recall path includes only materialized `memory_events`, `lcm_leaves`,
`lcm_rollups`, and eligible `curated_assertions`. Live-view permission does not
imply durable recall permission. Uncaptured DMs, Personal channels, Team Chat,
presence, receipts, typing state, and transient collaboration events are
excluded.

## UI Boundary

Desktop is a collaboration product surface rather than an infrastructure
dashboard.

### Navigation

- The far-left rail switches between Personal and Teams. Personal is first;
  Team identity and unread state remain stable when Teams are reordered or
  renamed.
- Selecting a Team opens one sidebar with Team people, Team-scoped direct
  messages, collapsible Workspaces, Workspace channels, and Team-shared Memory.
  The hierarchy does not add a third permanent navigation rail.
- The main content shows Personal Memory, notes-to-self, a Personal channel, a
  Team channel or direct message, Team people, Workspace Team-shared Memory, or
  a shared-session split view.
- Shared source content is visually distinct from Team Chat. LCM leaves and
  rollups are labelled as summaries and are not rendered as User or agent
  messages.

### Shared-Session View

- Desktop windows show the authorized source representation and companion
  discussion in independently scrolling panes with a draggable divider.
- Narrow windows use an accessible tabbed or stacked mode instead of shrinking
  either pane below a usable width.
- The source pane is read-only with respect to the AI Client. Team discussion
  cannot modify, prompt, or interrupt the source Conversation.
- Revocation, representation invalidation, membership disablement, Workspace
  Access removal, Team suspension, Workspace archive, session expiry, device
  revocation, or remote identity change removes protected source and discussion
  content from renderer state and closes affected streams.

### Setup And Operations

- Normal navigation contains a focused connection/status surface for Remote URL,
  capability validation, browser-mediated enrollment, reconnect, disconnect,
  and backend change. After enrollment, protected actions use the
  backend-selected Direct, Native review, or browser Step-up tier documented in
  ADR 0024; browser approval is not the default ceremony.
- Remote URLs are validated outside the renderer. Embedded credentials,
  unsupported schemes, unsafe redirects, disallowed private-network targets,
  DNS-rebinding paths, and non-loopback plaintext production connections are
  rejected.
- Infrastructure configuration, environment editors, service ports, raw
  manifests, reusable credentials, and diagnostic JSON are not ordinary
  product views.
- A separate Help/Diagnostics surface exposes only sanitized health, version,
  connection, and log-export information.
- Every primary surface represents loading, empty, denied, revoked, reconnecting,
  unavailable, failed-send, history-loading, and suspended states in product
  language without raw server errors or internal identifiers.

## Retired Experimental Boundaries

The unified collaboration boundary supersedes the disposable Team Conversation
experiment. The old `/v1/team-chat/*` routes, global numeric stream, Team Chat
tables and repository, generic Team IPC actions, and
`TeamConversationWorkspace` renderer are not compatibility surfaces. Current
collaboration uses the typed contracts, scoped routes, durable outbox/replay,
and authorization boundaries described above.

## Lifecycle And Rollout

Workspace archive, Team suspension, Team deletion request, Share Grant
revocation, sync revocation, Personal deletion, retention expiry, legal hold,
and hard purge are distinct operations. Archive and suspension block ordinary
access without deleting retained content. Purge requires an authorization-
blocking tombstone, durable resumable work, retention and hold evaluation,
cryptographic and search-material cleanup, and minimal content-free audit.

An owner-private remote replica purge is derived from the canonical replica,
its local Captured Session, and its Cross-Identity Sync relationship. It does
not discover purge scope through Share Grants. Once retention permits work and
no owner-private legal hold applies, the Worker removes replica-bound encrypted
field companions and wrapped DEKs, embedding vectors and search jobs, sync
inbox/outbox/package/replay state, mappings, and replica-derived Personal
Memory rows. Backup copies receive a policy-derived scheduled-expiry record.
The sync relationship is revoked before purge so no new package can repopulate
the replica.

Team grant-scoped representations have an independent lifecycle and encryption
boundary. Owner-private purge does not remove Team ciphertext, Share Grants,
representation chunks, shared recipient keys, or unrelated replicas. When a
Team representation still references the canonical replica, the minimal
replica and revoked sync tombstones remain so retained Team recall stays
referentially intact; without Team references, the canonical replica and its
logical Memory shell advance to `purged`. Every phase is idempotent, rechecks
legal holds, records content-free evidence, and emits one content-free
completion audit.

Share Grant revocation creates its immutable retention decision and durable
purge job in the same transaction as access removal. The longest deadline among
effective Team, Workspace, and Share Grant policies controls. The eventual
grant purge destroys only the selected grant's Team-encrypted representation,
companion discussion, and replay material; broad and companion-scoped legal
holds block work without restoring ordinary access.

Team chat, Team sharing and Cross-Identity Sync, Team realtime, Team-scoped
Memory, enrollment/upstream Team routes, replay background work, and
device-mediated high-risk operations share one atomic deployment kill switch;
retention purge remains active as safety maintenance for existing data:
`KOED_TEAM_COLLABORATION_ENABLED`. Operator-managed server deployments and
Desktop-managed local edges default to `false`; only the exact value `true`
enables every Team family in both API and Worker. Desktop therefore starts
Personal-only and does not provision the Privacy Filter model unless its
Operator explicitly sets `KOED_TEAM_COLLABORATION_ENABLED=true` and restarts
Desktop. Existing Desktop installs retain an explicit environment value, but
otherwise require this opt-in after upgrade. The families may have separate
protocol versions and operation-family grants, but they are not independent
feature flags. A mixed API/Worker value is an invalid deployment because it
cannot present a coherent fail-closed state.

With the switch off, Team HTTP and local-edge operations return `404`, Team
capabilities are unavailable, Team streams are closed on restart, and Team
background mutation does not start. Personal notes, channels, realtime,
Personal Memory, Projection, embedding, and LCM remain available. Disabling the
switch preserves encrypted Team rows; it does not revoke Share Grants, erase
retention evidence, rotate keys, or migrate data.

The operator-facing secrets are
`API_COLLABORATION_LOCAL_BROKER_SECRET` and
`API_COLLABORATION_REALTIME_CURSOR_SECRET`. `koed-server` maps them into the API
child environment as `COLLABORATION_LOCAL_BROKER_SECRET` and
`COLLABORATION_REALTIME_CURSOR_SECRET`. Packaged local mode generates and stores
the unprefixed child values in the mode-`0600`
`local-service-secrets.json`; Compose/hosted Operators supply the `API_` names.
The broker and cursor secrets must be distinct and retained across restarts and
restore. See [Collaboration Launch Validation](collaboration-launch-validation.md)
for executable rollout, disconnect, cleanup, and rollback procedures.

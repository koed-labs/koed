# Team Collaboration Uses Device-Mediated, Server-Authorized Operations

Status: Accepted design.

Related decisions:

- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0009 Commercial SaaS Encryption And Key Management](./0009-commercial-saas-encryption-key-management.md)

## Context

Koed presents local Personal collaboration and remote Team collaboration in one
Desktop experience. That presentation must not collapse their identities,
credentials, storage, availability, or authorization boundaries.

Team collaboration adds member chat, Team-scoped direct messages, Workspace
channels, shared Captured Sessions, companion discussions, and administration.
The MCP Server, Supported Capture Hook, Desktop renderer, local `koed-server`,
and remote Team backend all participate in parts of those flows. Without an
explicit authority model, a convenient local integration could become a remote
credential holder, Personal API Tokens could acquire accidental Team authority,
or Desktop could become a second authorization and realtime implementation.

Realtime collaboration also needs a durable recovery contract. Process-local
fanout or acknowledgement before renderer application can lose committed events
or leave a restarted renderer with a cursor for content it no longer holds.

Sharing a local Captured Session across deployments creates another authority
boundary. Source ownership, sync consent, Workspace share permission, Team
policy, representation fidelity, and retention are independent decisions. No
single role or credential can stand in for all of them.

These boundaries affect credential custody, client protocols, data ownership,
deployment ordering, and rollback. They are difficult to change after clients,
credentials, and stored collaboration data are in use.

## Decision

### Personal And Team Scopes

Personal and Team collaboration are separate scopes.

- Personal is not represented as a synthetic Team.
- Personal notes-to-self and Personal channels belong to one local User and
  remain usable without a remote Team backend.
- A Team is the membership and communication boundary. A Workspace is the
  Team subdivision for Workspace channels and Team-shared Memory.
- Team direct messages belong to one Team and do not inherit Workspace Access.
- Local Personal identity and remote Team identity remain distinct security
  principals. Enrollment binds them for one backend without merging IDs or
  ownership.
- Team Chat Messages are collaboration data. They do not become Memory Events,
  embeddings, LCM sources, Evidence Bundles, or AI-client prompts unless a
  separate Capture Policy and Projection decision is accepted later.

### Device-Mediated Team Operations

Desktop reaches remote Team operations through the enrolled local edge.

- The remote browser session remains the direct human-authenticated authority
  for Team and Workspace management.
- An enrolled device may perform Team catalog, chat, Shared Memory, sharing, and
  selected administration operations only through explicit operation-family
  grants. Browser-mediated enrollment never issues reusable `admin`; it issues
  the narrow `action_grant` family, which is inert without an exact one-use
  browser-confirmed Action Grant.
- Team chat read, Team chat write, Shared Memory read/realtime, share
  management, and browser-confirmed action mediation are separate operation
  families.
- Operation grants are action allowlists bound to one backend and, where
  practical, one Team. Wildcard operation grants are prohibited.
- A device credential identifies the User, device, backend, credential version,
  and granted operation families. It does not contain or cache Team Membership,
  role, Workspace Access, Share Grant, lifecycle, retention, or entitlement
  authority.
- The remote Team backend resolves those authorization records at request time.
  Client-supplied IDs and requested operation names never grant authority.

High-risk operation grants require browser-confirmed user presence.

- Team creation requires deployment capability plus a freshly authenticated
  remote User confirmation because no existing Team role can authorize it.
- Invite creation or revocation, role changes, member disablement, Workspace
  access management, retention or hold management, and destructive lifecycle
  actions require recent browser reauthentication or per-operation
  confirmation in addition to request-time role checks.
- High-risk device grants are short-lived, action-specific, backend-bound,
  device-bound, and Team-bound where the action has a Team. They are audited and
  cannot be replayed for another action, Team, backend, device, or confirmation
  window.
- Ordinary backend registration never silently grants high-risk operations.

### Credential Boundaries

Personal API Tokens remain Personal Memory compatibility credentials.

- API Tokens cannot authorize Team catalog or roster access, Team channels,
  direct messages, companion discussions, Team-shared Memory, Team realtime,
  Share Grants, invitations, Workspaces, or Team administration.
- API Tokens do not authorize Personal notes-to-self or Personal-channel UI
  operations.
- API Token denials are explicit in HTTP, local-broker, IPC, and realtime
  operation matrices and are covered by negative tests.

The local `koed-server` owns remote credential and connection state.

- It stores and uses the upstream device credential outside renderer-accessible
  storage.
- The MCP Server and other approved local integrations receive only a separate
  Local-Edge Client Credential scoped to one backend and explicit operation
  families.
- The local `koed-server` validates the local credential and operation family,
  resolves the upstream credential, owns remote HTTP routing and realtime
  sockets, persists remote cursors and retry state, and handles replay and
  reconnect.
- Electron main is a constrained bridge to the local server. It does not become
  a remote credential store, remote HTTP proxy, realtime authority, or durable
  Team cache.
- The renderer talks only through an allowlisted typed preload IPC API. It
  receives schema-validated authorized DTOs and events, not reusable remote
  credentials, cookies, API Tokens, provider tokens, arbitrary URLs, or a
  general proxy.
- DTOs and events are schema-validated at the local-server boundary, at the
  Electron main/preload boundary, and before renderer state mutation.
- Disconnect, backend change, identity change, or device revocation closes
  upstream connections, revokes or removes Team credentials, quarantines or
  cancels queued Team writes, and clears Team cursors, caches, IPC state, and
  renderer state while preserving Personal data and Personal credentials.

### Durable Realtime And Acknowledgement

HTTP is the authoritative snapshot and history surface. Realtime is a durable,
resumable delivery protocol backed by a transactional outbox.

- A collaboration mutation and its outbox event commit in one database
  transaction.
- Events have stable event IDs, typed versioned envelopes, opaque
  backend-bound and principal-bound cursors, occurrence time, resource identity,
  and minimal encrypted or content-safe payloads.
- An authorized snapshot and its high-water cursor come from one consistent
  database snapshot. Replay starts after that cursor.
- The database outbox is the replay source of truth across API restarts and
  horizontal fanout. Process-local notifications may wake streams but are not
  durability.
- Delivery is at least once. Clients reconcile events idempotently by event ID.
- The renderer applies a typed event before acknowledging it. The acknowledgement
  travels through preload, Electron main, and local transport to local
  `koed-server`, which advances its durable upstream cursor only after that
  applied acknowledgement.
- A crash after application but before acknowledgement causes a duplicate
  replay, not data loss.
- Retryable acknowledgement failures preserve delivery order and block later
  acknowledgements until the failed delivery succeeds or the subscription is
  replaced. A version conflict forces a fresh authorized snapshot; it is not
  treated as proof that access was revoked.
- Renderer restart or protected-state purge begins with a new authorized
  snapshot and high-water cursor. A durable local cursor cannot substitute for
  renderer content that was discarded.
- Replay retention, batch size, acknowledgement deadlines, buffer bounds,
  backpressure, close reasons, heartbeat, and snapshot fallback are explicit
  protocol policy. A cursor outside retained history causes an authorized
  snapshot, never silent event loss.
- Authorization is checked for snapshots, each replay batch, and live event
  serialization. Authorization loss forces stream closure and protected-state
  clearing; a content-free revocation event is advisory UX, not enforcement.

### Sharing And Representation Authority

Sharing never transfers ownership. A local authoritative Captured Session is
made remotely shareable through policy-controlled Cross-Identity Sync to an
owner-private remote replica, followed by a remote Share Grant to one Team and
Workspace.

- The source owner explicitly authorizes snapshot or continuous sync and the
  exact shareable source boundary.
- The enrolled remote identity must match the sync relationship and must also
  have current `workspace.memory.share_owned` authority. Source ownership alone
  and Team role alone are each insufficient.
- Team owners and administrators cannot share another User's Personal Memory.
- The canonical remote replica remains owner-private. A Team reads only a
  grant-scoped authorized representation encrypted for that Team boundary.
- Each Share Grant records stable logical source identity, owner-allowed
  representations, one active representation, policy revisions, lifecycle
  identity, and creating authority.
- The active representation must be in the intersection of the source-owner,
  Team, and Workspace allowlists. There is no wildcard representation, inferred
  permission, or fallback to another fidelity.
- Only the source owner selects or replaces the active representation. Raising
  fidelity or expanding the owner allowlist requires a new exact redacted
  preview and explicit consent.
- Team and Workspace managers may reduce their policy allowlists or revoke a
  Share Grant. They cannot expand the owner's allowlist, choose a replacement,
  or share a source they do not own.
- Policy invalidation fails closed. Sync lag may expose only the last authorized
  revision with freshness state; classifier, redaction, or eligibility changes
  hide invalidated content until safe regeneration.
- Sync revocation stops future propagation and marks the remote replica stale.
  It does not revoke the Share Grant. Share revocation, Personal deletion,
  retention, legal hold, and hard purge remain separate lifecycle operations.

### Deployment, Disablement, And Rollback

Collaboration uses one atomic deployment kill switch,
`KOED_TEAM_COLLABORATION_ENABLED`, across Team chat, Team sharing and
Cross-Identity Sync, Team realtime, Team-scoped Memory, enrollment/upstream Team
routes, replay jobs, support/lifecycle routes, and device-mediated high-risk
operations. Retention purge remains active as safety maintenance for existing
data. There are no independent family feature flags. Separate
protocol versions and operation-family grants remain authorization and
compatibility controls, not rollout switches.

The switch defaults to `false`, accepts only exact `true` or `false`, and must
match in every API and Worker process. When false, Team routes fail closed and
Team Worker services do not start; Personal collaboration, Personal Memory,
Projection, embedding, and LCM remain available. A mixed process value is an
invalid deployment and blocks launch.

Collaboration protocols are versioned, but the Team capability families are
enabled and disabled together by the atomic switch.

- Deployment proceeds authority-first: persistence and encryption contracts,
  authorization predicates and credential matrices, local broker and typed IPC,
  durable snapshot/replay protocol, then product UI.
- Remote API, local `koed-server`, Electron main/preload, and renderer negotiate
  explicit capability and protocol versions. Unsupported or stale capability
  combinations fail closed for Team operations while Personal remains usable.
- Collaboration contract version 4 is an atomic compatibility boundary for the
  staged Shared Memory result shapes. Deploy the authority before local
  `koed-server` and Desktop. Version 3 subscriptions must obtain a fresh
  authorized snapshot; they do not replay protected version 3 payloads into a
  version 4 client.
- The atomic server-side gate removes Team route, broker, IPC, and subscription
  admission together without deleting retained data or weakening authorization.
  Retention enforcement continues independently of product admission.
- High-risk device operations default disabled until browser confirmation,
  audit, and negative authorization coverage are deployed.
- Stored collaboration data and durable events use forward-readable schema and
  envelope versions during the compatibility window. A client never guesses a
  newer contract from route presence or release number.
- Database migrations are forward-only during rollout. Rollback means disabling
  the affected capability and returning to a compatible application version
  only while the schema and protocol window supports it. After incompatible
  writes or migrations, recovery uses a forward fix or verified backup restore,
  not ad hoc schema reversal.
- Feature disablement and application rollback do not revoke Share Grants,
  destroy retained Team data, roll back acknowledged source revisions, or
  bypass retention and legal-hold rules. Purge remains a separately authorized,
  resumable lifecycle operation.
- Release readiness requires backup/restore and rollback/forward-fix rehearsal,
  packaged Desktop and staged-remote validation, feature-disable verification,
  authorization and plaintext-leak checks, outbox/replay monitoring, and
  post-deploy observation.

## Consequences

Desktop can present Personal and Team collaboration together, but temporary
remote failure or Team feature disablement does not compromise local Personal
availability. The renderer stays replaceable because it has neither remote
credential custody nor protocol authority.

The credential model is more complex than forwarding an API Token or browser
cookie. That complexity is intentional: local integration permission, enrolled
device identity, verified human presence, and current Team authorization are
different facts with independent revocation.

Durable outbox, snapshot/high-water coordination, applied acknowledgements, and
idempotent replay require more storage and protocol work than best-effort
fanout. They make committed collaboration state recoverable across process,
network, and renderer failures without polling or cursor-based data loss.

Representation policy requires explicit previews, provenance, and grant-scoped
encrypted material. This prevents a summary label, available database row, Team
role, or higher-fidelity source from silently broadening what a Workspace may
receive.

Operational rollback favors capability disablement and forward fixes over
destructive data reversal. Deployments must therefore maintain compatible
protocol windows, durable migration evidence, and monitoring that can identify
authorization failures, decrypt failures, outbox lag, replay failures, forced
revocation-close latency, and unexpected Team request errors.

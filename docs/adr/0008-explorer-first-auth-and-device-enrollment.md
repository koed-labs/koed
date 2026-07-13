# Explorer-First Auth And Device Enrollment

Status: Accepted design; implementation is tracked by follow-up Team SaaS Launch
issues.

Related decisions:

- [0004 Team Memory Uses User-Owned Share Grants And Workspaces](./0004-team-memory-workspaces.md)
- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)

## Context

Koed Desktop is becoming the main setup and inspection surface for local
personal Koed, private VPS or Team Self-Hosted Koed, and Koed-managed cloud.
The same installed app needs to help an Operator start a local personal
`koed-server`, connect to a remote backend, inspect capability state, configure
the AI Client integration, and explain when memory capture or recall is local,
remote, unavailable, or gated.

The current self-hosted product uses API Tokens for MCP Server, Supported
Capture Hook, local work queues, and Explorer compatibility. That remains
useful, but API Tokens are not a good product-level credential for Team/cloud
enrollment because they are easy to copy into the wrong place and they do not
represent a device, upstream deployment, or Team authorization grant.

Hosted Team memory also introduces human identity, device identity, Team
Membership, Workspace Access, Share Grants, lifecycle gates, and commercial
entitlements. Those are separate concepts. A cloud identity provider can prove
who a human is, but Koed must remain the memory authorization authority.

## Decision

Koed uses an Explorer-first enrollment model. Koed Desktop hosts or opens
Explorer as the primary setup surface, and Explorer guides the User through the
backend-specific auth and enrollment path. Standalone browser access remains
useful for diagnostics and development, but it is not the primary launch setup
surface.

Backend targeting is explicit:

- **Local personal**: Desktop may start and supervise a managed local
  `koed-server`. Local simple auth and app-provisioned API Tokens may remain the
  first-run path. Desktop installs or repairs the MCP Server and Supported
  Capture Hook against localhost.
- **Private VPS / Team Self-Hosted**: Desktop connects to an Operator-managed
  remote `koed-server`. It does not manage that server's lifecycle. Setup uses
  browser session auth plus device enrollment when available; API Tokens remain
  a compatibility fallback for personal AI-client operations only.
- **Koed-managed cloud**: Desktop connects to Koed-managed `koed-server`.
  Human identity is provided by hosted browser auth, expected to be
  WorkOS/AuthKit in the first commercial implementation. Koed creates or
  resumes a Koed browser session from the verified external identity and then
  resolves memory authorization from Koed records at request time.

Human auth, device auth, and AI-client compatibility credentials stay separate:

- A **browser session** represents a signed-in human User. It may be local auth
  or a WorkOS/AuthKit-backed Koed session. It is required for Team management,
  Team Workspace recall/graph/admin, Share Grant management, authenticated
  diagnostics, authenticated capabilities, and device enrollment.
- An **API Token** remains an AI-client compatibility credential for personal
  Memory capture, personal recall, local work queues, and local smoke tests. It
  does not carry Team authority, cannot create Share Grants, cannot unlock Team
  Workspace recall, and must not be used as a cloud upstream credential.
- A **device credential** represents an enrolled Desktop/local-edge install.
  It is scoped to a User, device, upstream backend, credential version, and
  allowed operation families. It does not encode Team Membership, Workspace
  Access, Share Grants, lifecycle state, or commercial entitlements.
- An **upstream credential** is the local edge's private material for talking to
  a registered remote backend. It must not be exposed to the MCP Server,
  Supported Capture Hook, Explorer JavaScript runtime, ordinary config files, or
  support bundles. Ordinary status surfaces show existence, freshness, and
  revocation state only.
- A **Local-Edge Client Credential** is separate, revocable material scoped to
  one upstream backend and explicit operation families. MCP may use it to ask
  local `koed-server` for Team recall without receiving the upstream credential.
  It does not grant Team authority by itself; the Team Backend still checks
  Team Membership, Workspace Access, Share Grants, lifecycle, and entitlements.
- A **WorkOS API key** is an Operator/server configuration secret for hosted
  human auth. It is not a Koed API Token, device credential, upstream
  credential, Capture Hook credential, or AI-client credential.

Device enrollment is browser-mediated:

1. Desktop discovers backend capabilities from `/v1/capabilities`.
2. If the backend supports enrollment, Desktop opens Explorer against that
   backend and the User signs in with a browser session.
3. Local edge `koed-server` creates an enrollment challenge.
4. The authenticated backend binds the challenge to the current User,
   upstream backend, device metadata, and allowed operation families.
5. Local edge stores the resulting local credential material in an OS
   credential store where available. Headless/server installs use
   Operator-managed secrets.
6. Koed stores only verifier/public-key or equivalent non-reusable material on
   the server side.

7. For MCP Team recall, enrollment also creates a separate Local-Edge Client
   Credential. MCP presents only that credential to localhost. Local
   `koed-server` validates its backend and operation-family scope, loads the
   upstream credential from secure storage, and never treats a Personal API
   Token or a requested operation body as Team authority. Disconnect and
   re-enrollment remove or rotate both local credential classes independently of
   Personal API Tokens.
8. All remote operations still resolve current Koed authorization state at
   request time.

No enrollment flow may rely on email-only trust. External identity linking must
bind a verified provider subject to a Koed User. Email addresses are display and
matching hints, not proof of identity.

## Required API Contracts

The exact route names may evolve during implementation, but these contracts are
required before Team/cloud enrollment is considered complete:

- `GET /v1/capabilities`: public, safe discovery of deployment profile,
  supported auth providers, device enrollment availability, local-edge routing
  support, Team Workspace support, Share Grant support, and diagnostics
  availability. It must not expose paths, secrets, tenant details, or memory.
- `GET /v1/capabilities/authenticated`: session-authenticated extension point
  for identity-bound enrollment, entitlement, Team, and support/admin status.
- Browser auth routes for local auth and hosted WorkOS/AuthKit callback/session
  exchange. These create or resume Koed browser sessions; they do not directly
  authorize memory access.
- Device enrollment challenge routes. Challenge creation can be local-edge
  initiated, but challenge binding/redeem requires a browser session on the
  authority backend.
- Device credential status/revocation routes. Revocation is independent of API
  Token revocation and browser session logout.
- Local-edge upstream routing routes. These consume device/upstream credential
  status and cached upstream capabilities; they fail closed when stale,
  revoked, unsupported, or unauthorized.
- Team Workspace recall, graph, expansion, and Share Grant routes remain
  session-bound for Team scope. They may be reached through local edge, but the
  Team authority is always resolved by the backend that owns the Team state.

Self-hosted/local personal deployments may expose the local-simple subset:
local auth, API Token compatibility, local capabilities, local status,
diagnostics, MCP/Capture Hook setup, and personal Memory operations. They do
not need hosted WorkOS routes, remote device enrollment, commercial entitlement
routes, or support/admin routes unless the deployment profile advertises those
capabilities.

## Revocation And Enforcement

Revocation and access changes are request-time gates:

- Disabled Users cannot use browser sessions for protected operations.
- Removed Team members cannot recall Team Workspace memory, inspect Team graph
  data, create Share Grants, or manage Workspace access.
- Removed Workspace Access affects all active sessions and enrolled devices
  without credential rotation.
- Revoked Share Grants stop future Team recall for that source according to the
  Team retention policy.
- Revoked devices stop remote/upstream operations without revoking API Tokens or
  other devices.
- Revoked API Tokens stop personal AI-client compatibility operations without
  revoking browser sessions or enrolled devices.
- Stale or failed upstream capability caches fail closed for Team, Share Grant,
  sync/offload, admin, and capture-bearing remote operations, while local
  personal operations can continue locally.

Authorization must not be cached inside credentials. Credentials identify the
caller or device; Koed repository/core authorization predicates decide what that
caller can do now.

## Consequences

This model preserves a simple local personal path while creating a clean route
to Team/cloud use. Users keep localhost-oriented AI-client configuration for
normal operation, while local edge `koed-server` becomes the place where remote
routing, queueing, sync, and fail-closed policy can be added.

The implementation burden is higher than manually copying API Tokens, but the
security boundary is clearer: browser sessions prove the human, device
credentials prove the enrolled local edge, API Tokens serve legacy personal
AI-client compatibility, and Koed authorization records decide memory access.

Follow-up work should implement this in layers:

1. Capability/status fields for enrollment discovery.
2. WorkOS/AuthKit identity mapping to Koed Users and browser sessions.
3. Device enrollment and revocable device credentials.
4. Local-edge remote routing based on upstream capabilities and credential
   state.
5. Remote Team Workspace validation and launch smoke coverage.

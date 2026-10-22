# WorkOS Agent Registration

Agent Registration is an optional sign-in method for AI Clients connecting to
Koed's existing remote MCP endpoint. It uses WorkOS's hosted claim ceremony,
not a Koed-generated agent identity or a new recall service. Existing Koed OAuth
grants remain supported. The feature is disabled by default.

## Operator Setup

Use the existing WorkOS AuthKit application on a Team Self-Hosted or Koed-managed
cloud backend, with remote MCP enabled. Test in a separate WorkOS staging
environment first. Keep the server API key in the backend's secret store.

In the Dashboard, Agent Registration is under the top-level **Agents** section,
separate from Agent Auth blueprints. Enable **Service auth** under **Methods**.
Under **Configuration**, choose access-token credentials. Define the required
Koed permission slugs in **Authorization**, enable them under **Configuration →
Organization API key permissions**, and select them as **Trusted permissions**
for Agent Registration. Keep untrusted permissions empty. Creating permission
definitions alone does not include them in issued credentials.

Register the exact canonical MCP URI as a WorkOS MCP resource indicator. The
documented `/user_management/authkit_oauth_resources` API can add it without
replacing other resources or changing their default. An unregistered resource
causes token exchange to fail with `invalid_target`; omitting `resource` is not
a workaround because Koed requires the token audience to match its MCP URI.
For local staging tests, also register the exact browser callback in the WorkOS
application's Redirects settings, or run Koed at an already allowed callback.
The callback and MCP resource are separate allowlists.

In WorkOS, enable `service_auth` Agent Registration, configure the canonical MCP
resource and the allowed Koed permissions, and verify that those permissions are
present in issued access-token scopes. Do not enable anonymous access to memory.
Use the default AuthKit domain; no custom domain, SSO, Directory Sync or other
paid add-on is needed. Confirm the account's Agent Registration entitlement
before production enablement; AuthKit's free user allowance alone does not
establish the price of every WorkOS product. Koed cannot enforce an account-wide
WorkOS spending cap.

```dotenv
WORKOS_AGENT_REGISTRATION_ENABLED=true
WORKOS_AGENT_REGISTRATION_FREE_TIER_CONFIRMED=true
WORKOS_AGENT_REGISTRATION_ISSUER_URL=https://your-environment.authkit.app
WORKOS_AGENT_REGISTRATION_ALLOWED_ORGANIZATIONS=org_example
WORKOS_AGENT_REGISTRATION_SCOPES=koed:memory:read,koed:team:read
WORKOS_AGENT_REGISTRATION_REQUESTS_PER_MINUTE=120
```

The existing `WORKOS_AUTHKIT_ENABLED`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_REDIRECT_URI`, `WORKOS_PROVIDER_ENVIRONMENT`, `KOED_REMOTE_MCP_ENABLED`
and `KOED_REMOTE_MCP_PUBLIC_URL` settings are also required. The issuer, key,
client, organisation and stored identity namespace must refer to the same
environment. Read [Configuration](configuration.md) for defaults and bounds.

Route `/auth.md` through the same public origin as `/mcp`. Protected Resource
Metadata advertises the existing Koed issuer and the WorkOS issuer. Koed's
`/auth.md` explains its permissions and links to WorkOS's generated
`/agent/auth.md` for the current registration and exchange commands. Koed does
not reverse-proxy arbitrary upstream documents or replace its OAuth issuer.

## User Flow

1. Sign in to Koed using its existing WorkOS login once. This establishes the
   verified WorkOS-user-to-Koed-User link. Matching email addresses alone do not
   establish authority.
2. Ask the AI Client to read Koed's `/auth.md` and follow the linked hosted
   registration guide. The User completes sign-in and explicitly confirms the
   claim. The AI Client must not approve on the User's behalf.
3. Exchange for a short-lived access token bound to the canonical MCP resource,
   requesting only agreed scopes. Store credentials in the AI Client's protected
   credential storage, never in conversation, `AGENTS.md`, URLs or source code.
4. Connect to `/mcp`. Follow WorkOS's rotation instructions when credentials
   expire. The first successful request from a verified, User-claimed
   registration creates a Koed authorisation grant for the validated scopes.
5. Manage connections at `/auth/mcp/connections`, using a normal Koed browser
   session. Disconnect withdraws the connection's Koed access. After a disconnect
   or authorisation expiry, the User must explicitly authorise it again there.
   An AI Client must not create another registration to bypass a disconnect.

This does not install a local helper or enable capture. Memory Answers, LCM
Summaries and automatic capture still require the existing User-owned Local AI
Runtime, enrolled through the normal [remote setup](headless-remote-mcp.md).
Koed does not perform backend LLM synthesis or return raw evidence as a fallback
for a missing helper.

## Personal And Team Authority

`koed:memory:read` accesses the linked User's Personal Memory. Team recall also
requires `koed:team:read`, an explicit allowed organisation and a linked existing
WorkOS-organisation-to-Koed-Team mapping. Registration does not create or change
that mapping, Team Membership, Workspace Access, Share Grants or entitlements.

A WorkOS credential cannot access another Team merely because its User belongs
to both. That ceiling applies to Workspace discovery, retrieval, queued answer
admission and collection, helper claims, cancellation, history and cleanup.
Shared Memory node expansion uses the same bounded actor and checks the mapped
Team before decrypting the candidate, even when the User belongs to other Teams.
The existing repository authorization still checks membership and current
Shared Memory authority. Missing or disabled links fail closed. Existing Koed
OAuth grants retain their existing User-wide Team authorization behavior.

Personal-only WorkOS credentials cannot read Team answer history, including
legacy answers retained in the User's history. Missing Team scope is an explicit
denial, not permission to fall back to another Team or browser session.

Capture and local execution require separately enabled and issued
`koed:capture` and `koed:local-execution` scopes. These do not add administrative
authority or grant permission to publish or share Personal Memory.

## Revocation And Failure Behavior

For every authenticated HTTP request, Koed validates the exact token and
audience with WorkOS, checks the registration, and resolves the current local
identity and organisation mapping. It also checks a durable Koed authorisation
record in the existing remote MCP grant store. There is no positive cache
between requests.
Invalid, expired, revoked or improperly bound credentials receive `401`; missing
operation scopes or Team authority receive `403`. WorkOS outages fail closed
with `503`; local/upstream request limits return `429` with `Retry-After`.
Clients should retry later, not repeatedly register new connections.

### Koed Authorisation

The grant binds the configured issuer and provider environment, registration
`sub`, authorising User `act.sub`, organisation `org_id`, canonical MCP resource,
local User and approved Team mapping. Granted scopes are intersected with both
the current credential and configured ceiling. New tokens cannot widen scopes,
change the User/organisation/Team binding or extend the consent deadline.
Changing those bindings requires a new, deliberately authorised connection.

Authorisation lasts at most 30 days from the initial grant or explicit User
reauthorisation, matching the existing Koed OAuth grant lifetime. It is not
renewed by credential exchange or assertion rotation. Ordinary sign-out ends
the browser session, not these separately authorised connections.

The connection page lists both native OAuth and WorkOS grants. Only the owning
User's browser session can disconnect or reauthorise a connection. Actions use
same-origin, expiring, session-bound form proofs and an authorisation version
to reject stale submissions. Native OAuth clients reconnect through their usual
OAuth consent flow; they cannot restore a disconnected token family.

Disconnect rejects existing and replacement credentials at Personal/Team APIs,
MCP and queued Memory Answer admission/collection. Work already submitted is
User-owned and may still be processed by an independently authorised local
helper; disconnect does not delete memory, answers or other clients' work.
Disconnected or expired WorkOS grant records are retained through normal OAuth
cleanup and server restarts so a new token cannot recreate withdrawn consent.
They are removed when the owning local account is permanently deleted.

This is withdrawal of Koed access, not WorkOS registration or credential
revocation. WorkOS may continue to issue credentials, but Koed rejects them
until the User explicitly authorises that connection again. It does not require
deleting the User or relying on WorkOS session revocation.

Credential revocation and registration revocation are distinct. The WorkOS
auth.md protocol describes a form-encoded POST to the issuer's `/oauth2/revoke`
with `token` and `token_type_hint=access_token`. Revoking an access token does
not by itself revoke the underlying registration: a surviving identity
assertion may still issue replacement tokens. Verify the endpoint and its
authentication requirements for the configured environment before relying on
it as an operational control.

Upstream calls use a fixed WorkOS API destination, five-second timeouts,
32-KiB response limits and no redirects or automatic retries. The existing
rate-limit store bounds request volume, and each API process permits eight
concurrent verifications without an unbounded waiting queue. Validation is
reused only within one HTTP request; history reads require the same two provider
calls as other delegated requests, and the next request revalidates credentials.

Before spending provider API calls, Koed verifies the JWT locally using RS256
public keys from the configured issuer's fixed `/oauth2/jwks` endpoint. Tokens
cannot select a key URL or a different algorithm. Signature, issuer, resource
audience, expiry and not-before checks must pass before linked local identity
lookup or identity quotas. Unverified claims can only reject a request; they
cannot select another User's quota. The public key request sends no API key or
token, forbids redirects, and has the same timeout and response-size limits as
provider API requests. Key sets have at most 32 unique public RSA keys; private
key material is rejected. Keys are cached for five minutes, not credentials,
principals or authorisation decisions.

Signing-key refreshes are single-flight and limited to one attempt every 30
seconds per API process, including failures. New signing keys may therefore
require up to 30 seconds to become usable after a preceding refresh. Unknown
keys fail authentication; unavailable, malformed or timed-out key endpoints
return a retryable failure rather than accepting stale expired-cache keys.
Online WorkOS credential validation, verified registration checks and durable
Koed consent checks still run on every authenticated HTTP request. Local
signature verification alone does not detect provider-side revocation.

The existing rate-limit store enforces separate per-User and per-registration
quotas after signature verification and existing local account-link checks,
before provider API calls. The default is 30 requests per minute for each,
derived from one quarter of the 120-call provider budget. A request normally
costs two provider calls. The User key is the local Koed User ID, so rotating
registrations, linked provider identities, tokens, IPs or API/MCP routes does
not obtain a new User quota. Registration quotas may be lower than the User
quota. Denials include Retry-After and do not make another provider API call.
Distinct Users sharing one IP retain independent normal quotas.

A higher transport-peer limit is an outer guard against unauthenticated floods:
1200 JWT-bearing requests per minute by default. It uses a hash of the
server-resolved peer IP, not caller-supplied forwarding headers. Internal
MCP-to-API dispatch preserves the original peer rather than using a shared
loopback identity. Users behind a NAT or reverse proxy can still share this
outer limit. Configure it for the deployment, without using it as identity
fairness. See the quota variables in [configuration](configuration.md).

Use shared edge abuse protection and the existing Redis rate-limit store for
multi-instance deployments; in-memory counters are process-local. Redis
increments and expiry are atomic, and repair a counter missing its TTL.
Restricted Redis ACLs must allow `EVAL`, `INCR`, `PTTL` and `PEXPIRE` for rate-limit
keys. Store failures fail closed. The issuer-wide provider budget and eight
in-flight verifications per process remain final resource ceilings, not a
guarantee against distributed denial of service.

## Validation

The automated verifier tests use real asymmetric signatures with a simulated provider,
scope intersection, expiry, audience/issuer mismatch, revocation and upstream
failures, key rotation, bounded key refresh, forged identity claims and separate
User quotas behind one IP. Redis integration tests exercise concurrent counters
and TTL repair against an actual Redis server. The database/API integration suite uses the deterministic Team fixture
and a second Team accessible to the same User to exercise credential confinement.
These tests do not replace a real WorkOS staging claim, token exchange, MCP
connection and Koed disconnect/reauthorisation check before deployment. Tests
cover existing and replacement tokens, absolute expiry, retained revocation
state, browser action forgery, stale forms and cross-User management. Verify
provider token revocation separately from Koed authorisation withdrawal. Bulk
revocation of unverified registrations and Agent Auth instance-session revocation
are not substitutes for the Koed disconnect control.

References: [WorkOS Agent Registration](https://workos.com/docs/authkit/agent-registration),
[credential validation](https://workos.com/docs/reference/agents/registration),
[WorkOS pricing](https://workos.com/pricing).

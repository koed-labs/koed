# Headless Remote MCP

Koed can connect an AI Client directly to an existing remote backend without
Electron, a local API, Postgres, an Embedding Service, or a Privacy Filter
Service. This is an opt-in integration with the same backend, not a separate
memory service or a general remote API proxy.

The remote backend still owns storage, Projection, embeddings, recall, and
authorization. It never runs LLM synthesis. A User-owned Local AI Runtime is
still required for automatic capture, durable Personal and Team Memory Answers,
LCM Summaries, and other persistent local AI-client work. Neither answer scope
returns raw retrieval to the invoking agent as a substitute for helper synthesis.

## Operator Setup

Enable the transport on the existing backend:

```dotenv
KOED_REMOTE_MCP_ENABLED=true
KOED_REMOTE_MCP_PUBLIC_URL=https://memory.example/mcp
```

The public URL is the canonical OAuth resource and MCP endpoint. It must be an
absolute HTTPS URL with path `/mcp`, without credentials, query, or fragment.
Only literal `127.0.0.1` or `[::1]` HTTP is allowed outside production; a
`localhost` hostname is not accepted. Enablement requires the persistent
database-backed OAuth repository. Keep Postgres, queues, embedding endpoints,
and other internal services private. Route `/mcp` and the OAuth discovery,
authorization, client registration, token, revocation, and consent routes
through the same public deployment origin. Those routes are not mounted while
remote MCP is disabled. Requests must use the configured canonical Host;
browser Origins are limited to the configured CORS origins and resource origin.

On hosted deployments, Conversation Source Journal segments accepted through
delegated capture use `envelope_db`: the backend's configured envelope encryption
provider encrypts the signed segment and its source bytes before database
persistence. Missing encryption fails closed. These payloads are not written to
`KOED_HOME/source-journal`; local-personal journaling keeps its existing filesystem
storage. Protect the encryption keys and encrypted database backups.

Hosted journal access requires this opt-in transport and a current `koed:capture`
grant. Reads remain source-owner scoped. Ordinary Personal API Tokens do not gain
hosted journal access. The origin signature identifies the backend that accepted
the authenticated User's capture. It is not a client device enrollment, proof of
the client's filesystem, or proof of native AI-client source authenticity.

The User signs in through the backend's existing identity provider and approves
an OAuth authorization-code grant with PKCE. The grant is resource-bound,
revocable, and separate from a Personal API Token or web session cookie.

| Scope                  | Authority                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `koed:memory:read`     | Read the authenticated User's Personal Memory and use its recall/task contract.                 |
| `koed:capture`         | Capture activity into that User's Personal Memory and access their Conversation Source Journal. |
| `koed:local-execution` | Service that User's local AI-client memory work.                                                |
| `koed:team:read`       | Read Team Workspace memory allowed by current membership, Workspace Access, and Share Grants.   |

Scopes do not create Team Membership, Workspace Access, Share Grants, or
administrative authority. Every operation revalidates current backend access;
MCP caller metadata and local project paths do not confer authority.

WorkOS AuthKit deployments can also enable [Agent Registration](workos-agent-registration.md).
It adds a credential issuer, not another memory pipeline. Personal and Team
requests still use these APIs, the durable answer queue and the User-owned Local
AI Runtime. WorkOS Team credentials are additionally confined to the Koed Team
mapped to their WorkOS organisation. Existing Koed OAuth continues unchanged.

Users can manage native OAuth and WorkOS connections at
`/auth/mcp/connections` using their normal browser session. Disconnect withdraws
Koed access independently of provider token validity. WorkOS grants have a
30-day absolute authorisation lifetime, with explicit User reauthorisation
after expiry or disconnect. Registration bindings remain stored through normal
cleanup so replacement credentials cannot recreate withdrawn consent. See
[WorkOS Agent Registration](workos-agent-registration.md) for the distinction
between Koed authorisation and WorkOS credential revocation.

The pinned OAuth SDK limits public client registration to 20 requests per hour
and authorization requests to 100 per 15 minutes, per socket-peer IP. Forwarded
headers do not override that identity. Behind a proxy, these limits may be shared
by all clients of that proxy; retain appropriate public-edge abuse protection.
The backend prunes expired OAuth state at startup and every five minutes, with
at most 500 deletions per table per pass and no overlapping cleanup runs.
Unreferenced client registrations older than 30 days are removed; such clients
must register again. Consumed refresh credentials remain while their grant is
active, preserving replay detection. SDK rate-limit counters are process-local,
so deployments with multiple API instances also need shared edge protection.

## User Setup

Use a clean, dedicated `KOED_HOME` for remote integration. Do not point initial
enrollment at an existing local-personal profile or copy another profile's
watcher state. Keep the same home when restarting: it retains the capture
activation frontier and credential binding.

With the installed `koed` CLI and supported AI Client available:

```bash
export KOED_HOME=/path/to/dedicated-remote-profile
koed remote login --backend https://memory.example --consent --local-runtime
koed remote setup codex --consent
koed remote check codex
koed remote start
```

Use `claude` or `pi` in place of `codex` for those harnesses. `remote start` is
a foreground persistent helper; keep it running while capture and local memory
work are needed. A service manager may supervise that command. SIGINT or SIGTERM
closes the shared Local AI Runtime. This command does not start local backend
dependencies. Source checkouts must build the runtime artifacts before use.

Login opens the browser authorization flow when possible or reports its URL.
Without `--local-runtime`, login requests read-only Personal Memory access;
the flag explicitly requests the capture and local-execution scopes needed by
this helper. Add `--team-read` only when Team recall is wanted. Team execution
also requires the backend to advertise version 2 of `memory.answerTasks` with
Team support. Missing support fails explicitly rather than changing executors.
Deploy the backend and local helper from compatible releases: version 2 task
completion sends a prepared final question, not a previously persisted question
ID. Older helpers cannot service this completion contract.

Provider login is separate from the remote MCP grant. The selected AI Client
must also have usable model credentials. A stored login can still have an
expired or revoked refresh token. Pi native authentication failures report an
actionable sign-in error without exposing the provider's raw error text; they
do not silently switch models or move synthesis to the backend.
Unattended access-token renewal never opens a browser. Expired or revoked
grants require an explicit login rather than fallback to another credential
or deployment.

The descriptor at `KOED_HOME/config/headless-remote.json` contains the backend
URL, harnesses, future-only capture setting, and a credential reference, not
credentials. OAuth credentials live in the protected
`KOED_HOME/config/remote-mcp-credentials.json` file. AI-client MCP and Capture
Hook configuration contains `KOED_HOME` and entry points, not those credentials.
Do not copy the credential file between Users or deployments, put it in source
control, or paste it into AI-client configuration.

```bash
koed remote remove codex --consent
koed remote logout --consent
```

Removing a harness removes its Koed-owned integration. Logging out removes
remote authorization; neither operation deletes retained backend Memory.
Logout immediately disables local token use. If the backend cannot confirm
revocation, the protected credential file retains only the token and hint
needed to retry `koed remote logout --consent`; that material is unavailable to
the running helper. Login is blocked until pending revocation succeeds. A
`remoteRevoked: false` result is not confirmation that the backend grant ended.
Successful logout clears that retry material, retaining the non-secret backend
and User binding.
Use a new dedicated profile when changing either identity or backend.

## Capture Consent

Setup authorizes future capture only. The automatic historical coordinator is
disabled in this mode. Transcript Watchers retain local activation/baseline
frontiers, and source journals as well as Projection begin at those frontiers.
Previously existing transcript bodies are not automatically uploaded just
because a Conversation resumes. The existing Capture Policy and Capture Pause
checks remain in effect, and capture creates Personal Memory only.

For Pi future-only capture, the consent frontier stays immutable and a separate
persisted cursor marks activity excluded by Capture Pause. Resuming closes the
previous source generation and creates a linked successor beginning after the
excluded interval. Paused bytes are not uploaded, and already retained source
bytes are not rewritten. Restarting uses the same frontiers and generation chain.

Retain the dedicated profile when resuming the same backend and User. Backend
or User changes cannot reuse its credentials or capture state silently. A
remote source cursor that predates the consent frontier fails closed rather
than uploading the old backlog or inventing source IDs, offsets, or generations.
Review that condition before continuing capture. Historical import requires
separate explicit consent and is not provided by these remote setup commands.
Profiles created by an earlier prototype that advanced their consent baseline
during a pause still fail closed if that baseline conflicts with retained source.
The helper does not silently lower consent or infer permission to upload a backlog.

## Runtime Boundary

Remote MCP exposes the existing typed memory tools over an authenticated HTTP
transport. Personal and Team Memory Answer tasks use the backend's existing durable task
records and are serviced by the User's Local AI Runtime with the existing
scheduler and local provider workers. No parallel answer queue or backend LLM
worker is introduced. Team tasks are accepted by the backend that owns the
Team Workspace, not by a Personal backend acting on its behalf. The same worker
uses that backend's existing authorized retrieval routes.

Task claims default to Personal only. Team execution requires explicit scoped
claims and trusted credential authority. Enrolled native devices additionally
require the `memory_answer_execution` family, granted through explicit
`--memory-answers` enrollment consent; read-only enrollment is not silently
upgraded. OAuth helpers require the local-execution and Team-read scopes.

`KOED_TEAM_COLLABORATION_ENABLED=false` also denies Team task admission,
claims, stored-ID operations, local-edge forwarding and task-bound history.
Credential scopes cannot override the deployment switch. Browser history uses
the credential that actually authenticated the request; an unrelated header
does not turn a valid browser session into an API Token.

Native local-edge task forwarding is Team-only and requires both local execution
and Team-read authority. It narrows the stored upstream credential before the
backend reads protected task data, even when that credential has additional
permissions. Personal requests are not forwarded through this adapter.
Expired-task cleanup is restricted to this User's expired terminal Team tasks;
it cannot remove Personal tasks through a broader stored credential.

Team tasks freeze the existing Share Grant boundary at acceptance. New grants
cannot widen a running task. Current membership, Workspace access, and the
original grants and representations are checked before protected reads and
completion. A heartbeat renews the same boundary, not a broader one. Final
Memory Question persistence and the fenced task completion commit atomically.
Permission loss denies delivery of completed task-bound history as well as
pending work. Older Team history without task authority retains its existing
access policy; this change does not rewrite those historical rows.

Claims lock only eligible tasks, skip locked rows, and reconcile at most 16
candidates per call. Invalid Team authority permits a redacted terminal queue
transition, not protected payload access, so revoked tasks do not permanently
consume capacity. Owners with Team execution authority can also cancel their
denied tasks without reading their contents. History hydration overlaps at most
eight independent row operations while preserving list order and filtering
only authorization-denied rows; other failures still propagate.

The frozen Team boundary is bounded to 128 grants. Oversized boundaries fail
explicitly rather than silently dropping evidence. Validation reuses the
existing representation authorization checks and holds transaction locks through
protected work. Large Workspaces therefore add database round trips; measure
this cost with representative data before production rollout. This integration
does not replace those checks with a cross-request authorization cache.

The local helper binds its typed contract to authenticated loopback only. It
does not expose a public inbound endpoint or forward arbitrary remote API
requests. API Tokens retain their existing Personal-only authority; OAuth
delegation does not expand them into Team credentials.

# Headless Remote MCP

Koed can connect an AI Client directly to an existing remote backend without
Electron, a local API, Postgres, an Embedding Service, or a Privacy Filter
Service. This is an opt-in integration with the same backend, not a separate
memory service or a general remote API proxy.

The remote backend still owns storage, Projection, embeddings, recall, and
authorization. It never runs LLM synthesis. A User-owned Local AI Runtime is
still required for automatic capture, durable Personal Memory Answer work,
LCM Summaries, and other persistent local AI-client work. Team recall returns
authorized evidence for synthesis by the invoking AI Client.

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

## User Setup

Use a clean, dedicated `KOED_HOME` for remote integration. Do not point initial
enrollment at an existing local-personal profile or copy another profile's
watcher state. Keep the same home when restarting: it retains the capture
activation frontier and credential binding.

With the installed `koed-server` and supported AI Client available:

```bash
export KOED_HOME=/path/to/dedicated-remote-profile
koed-server remote login --backend https://memory.example --consent
koed-server remote setup codex --consent
koed-server remote check codex
koed-server remote start
```

Use `claude` or `pi` in place of `codex` for those harnesses. `remote start` is
a foreground persistent helper; keep it running while capture and local memory
work are needed. A service manager may supervise that command. SIGINT or SIGTERM
closes the shared Local AI Runtime. This command does not start local backend
dependencies. Source checkouts must build the runtime artifacts before use.

Login opens the browser authorization flow when possible or reports its URL.
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
koed-server remote remove codex --consent
koed-server remote logout --consent
```

Removing a harness removes its Koed-owned integration. Logging out removes
remote authorization; neither operation deletes retained backend Memory.

## Capture Consent

Setup authorizes future capture only. The automatic historical coordinator is
disabled in this mode. Transcript Watchers retain local activation/baseline
frontiers, and source journals as well as Projection begin at those frontiers.
Previously existing transcript bodies are not automatically uploaded just
because a Conversation resumes. The existing Capture Policy and Capture Pause
checks remain in effect, and capture creates Personal Memory only.

Retain the dedicated profile when resuming the same backend and User. Backend
or User changes cannot reuse its credentials or capture state silently. A
remote source cursor that predates the consent frontier fails closed rather
than uploading the old backlog or inventing source IDs, offsets, or generations.
Review that condition before continuing capture. Historical import requires
separate explicit consent and is not provided by these remote setup commands.

## Runtime Boundary

Remote MCP exposes the existing typed memory tools over an authenticated HTTP
transport. Personal Memory Answer tasks use the backend's existing durable task
records and are serviced by the User's Local AI Runtime with the existing
scheduler and local provider workers. No parallel answer queue or backend LLM
worker is introduced. Team Memory Answer provides evidence to the invoking
AI Client and does not claim durable Personal task ownership.

The local helper binds its typed contract to authenticated loopback only. It
does not expose a public inbound endpoint or forward arbitrary remote API
requests. API Tokens retain their existing Personal-only authority; OAuth
delegation does not expand them into Team credentials.

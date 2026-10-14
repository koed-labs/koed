# ADR 0056: Delegated Remote MCP And Headless Local Execution

## Status

Proposed; implemented locally for review.

## Context

Some Users need Koed memory tools in an existing AI Client without Electron or
local backend dependencies. Remote access must preserve current User and Team
authorization, capture consent, encrypted storage, and the prohibition on
backend LLM synthesis. Personal API Tokens must remain Personal-only.

## Decision

Add an opt-in authenticated HTTP transport to the existing API deployment.
Reuse the MCP factory, tool schemas, authorized API routes, retrieval services,
and storage repositories. Do not introduce a second memory service, a generic
API proxy, or a backend synthesis worker.

Use public-client OAuth authorization code flow with PKCE, existing User login,
explicit scoped consent, and a canonical resource audience. Persist hashes of
short-lived credentials and revocable grants. Scope restrictions supplement,
rather than replace, current User lifecycle and Team access checks. A delegated
credential is neither a Personal API Token nor an enrolled device credential.

Keep Personal and Team Memory Answer execution in the existing User-owned Local AI
Runtime and durable task system. Request closure detaches a waiter; it does not
cancel accepted work. No available local executor means a bounded pending
outcome, not backend synthesis or retrieval pushed into the main agent context.
Extend the existing durable task system rather than retaining a separate Team
executor. Team acceptance and terminal history belong to the authoritative
Team backend. Explicit scoped claims and credential permissions select eligible
helpers; task ownership alone never confers Team access. The amendment to
ADR 0043 defines frozen Team authorization and atomic terminal persistence.

With separate capture and local-execution consent, a dedicated local profile
can run the same runtime against the remote backend. Initial capture is
future-only. Credentials are protected locally and excluded from harness
configuration. A profile remains bound to one backend and User.

Hosted source capture uses the existing journal routes and encrypted database
envelope format, never the local plaintext filesystem provider. Capture Pause
and effective Capture Policy are checked before hosted source writes. The
backend signs accepted User captures; this is backend-origin provenance, not
proof of a particular capture device or native harness file.

## Consequences

- Electron and local API, database, and embedding services are unnecessary for
  this integration, but automatic capture and background synthesis still need
  a local helper and an available supported AI Client.
- The OAuth authorization-server adapter uses the SDK auth handlers separately
  from the pinned MCP v2 transport because the latter does not supply those
  handlers. Both dependencies need maintenance.
- Exact Personal source remains owner-scoped; delegated Team read authority
  does not grant access to that journal.
- Server and local helper deployment identity, backup, credential revocation,
  offline behavior, and capture activation frontiers are explicit operational
  concerns.
- Team execution requires explicitly enrolled device execution authority or
  delegated local-execution and Team-read consent. Older read-only credentials
  and backends without the versioned task capability cannot silently opt in.
- Task-bound Team history is checked against current access and its original
  frozen grant boundary before decryption. This does not migrate legacy history
  to a different retention or access policy.

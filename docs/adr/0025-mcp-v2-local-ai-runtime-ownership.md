# ADR 0025: MCP v2 and Local AI Runtime Ownership

## Status

Accepted.

## Context

MCP `2026-07-28` replaces protocol initialization sessions with self-describing
requests and adds discovery and cacheable list results. Koed's previous MCP
entry point also started transcript capture, LCM summarization, Curated Memory
review, Memory Answer workers, and an Explorer HTTP bridge. Each Codex session
could therefore create another copy of persistent local work.

Koed must preserve local AI-client synthesis, local-edge authorization, and the
existing Memory Answer and Curated Memory contracts while adopting the new
protocol. MCP caller metadata is diagnostic context and cannot confer Personal
or Team authority.

## Decision

Koed supports MCP `2026-07-28` through the pinned v2 TypeScript SDK packages.
The retired MCP initialization protocol has no compatibility path.

Codex launches a short-lived stdio MCP adapter. The adapter owns only protocol
negotiation, deterministic tool registration, input validation, and forwarding
to an authenticated loopback Local AI Runtime contract. It does not start
background services, hold upstream credentials, or call Team backends directly.

`koed-server` supervises one Local AI Runtime per `KOED_HOME`. That runtime owns:

- fresh isolated Codex workers for `memory_answer`;
- LCM Summary and captured-session title processing;
- Curated Memory review processing;
- transcript watcher lifecycle and content-free Capture Hook wake signals;
- bounded Memory Answer admission, cancellation, and shutdown.

The local contract binds only to loopback on an ephemeral port. Its registration
file is atomically written beneath `KOED_HOME/run`, owned by the current user,
non-symlinked, and mode `0600` on POSIX systems. Each request uses a random
bearer credential, a bounded body, a strict operation schema, and a timeout.
The contract is not a general API proxy.

The public MCP tools remain `memory_answer` and capability-gated
`memory_intake_propose`. Diagnostic tools remain hidden unless explicitly
enabled. `server/discover` and `tools/list` are deterministic and privately
cacheable for a bounded duration; tool execution always revalidates current
runtime capability and backend authority.

Persisted Memory Questions remain inspectable through the API. Desktop does not
submit them to a browser answer bridge or configure local synthesis workers.
Worker settings remain persisted backend settings consumed by the Local AI
Runtime.

## Consequences

- Multiple Codex sessions have independent stdio adapters but share one durable
  local runtime.
- Starting or stopping an adapter cannot start or stop capture, LCM, review, or
  transcript watching.
- Codex configuration contains `KOED_HOME`, not API or upstream credentials.
- Shared-channel stdio cancellation is enforced when the connection closes;
  request timeout and downstream HTTP cancellation are enforced by the Local AI
  Runtime. Future per-request transports can propagate cancellation by closing
  the request stream.
- The reusable Codex integration implementations may remain in the existing
  package until package boundaries are changed for an independent reason;
  operational ownership is determined by `koed-server` supervision, not source
  directory location.
- Backend LLM synthesis remains prohibited by ADR 0001.

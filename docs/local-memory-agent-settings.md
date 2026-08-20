# Local AI Runtime Settings

Koed performs synthesis through the connected AI Client. The backend stores
memory and evidence but does not run LLM synthesis.

## Flows

The supervised Local AI Runtime owns three services and four configurable flow
assignments:

- MCP Memory Answer: a fresh isolated worker for each `memory_answer` call.
- LCM Summary and Session Title: background LCM Summary and captured-session title work.
- Curated Memory Review: asynchronous source-linked proposal review.

Codex, Claude, and Pi are supported local providers. Each flow independently
selects AI Client instance, model, and supported model options. Pi model IDs
retain full underlying provider/model identity. Capability publication probes only
instances explicitly listed in `KOED_AI_CLIENT_INSTANCE_REGISTRY`; an empty or
missing registry publishes zero instances. Setup is responsible for registering
provider defaults. Desktop reads persisted settings and latest current or stale
capability snapshots immediately, then asks the authorized Local AI Runtime to
refresh capabilities asynchronously with a bounded timeout.

## Precedence

Memory Answer settings resolve in this order:

1. API user setting in `local_memory_agent_settings`.
2. `MEMORY_ANSWER_*` environment defaults.
3. Code defaults.

LCM Summary settings resolve in this order:

1. API user setting in `local_memory_agent_settings`.
2. `MEMORY_LCM_SUMMARY_*` environment defaults.
3. Code defaults.

Curated Memory Review settings resolve in this order:

1. API user setting in `local_memory_agent_settings`.
2. `MEMORY_CURATED_REVIEW_*` environment defaults.
3. Code defaults.

A persisted assignment is revalidated immediately before each execution against
enabled instance state, current capability snapshot, selected model, and
explicitly reported reasoning effort. Stale, unhealthy, unauthenticated, or
mismatched assignments fail closed; environment defaults are used only when no
persisted assignment exists. Settings or capability API failures never silently
fall back. Desktop exposes exactly `mcp_memory_answer` (Memory Answer),
`lcm_summary`, `session_title`, and `curated_memory_review`; `manual_memory_answer`
is intentionally hidden. Reset is an explicit DELETE for one flow assignment.
The Desktop surface for these selectors is **Preferences → AI Clients**, which is
configuration rather than diagnostics; **Preferences → Advanced Diagnostics**
retains only Operator diagnostics and integration setup, check, repair, and
removal actions.
The read model includes documented defaults so a missing assignment can be
identified without changing persisted state.

These are separate health gates, not one global provider check:

| Capability family                | Used by                                                                        | Independent failure boundary                  |
| -------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| Automatic Capture and MCP Recall | Provider-specific watcher and Memory Answer access                             | That AI Client's capture or recall path       |
| Local Synthesis                  | Memory Answer, LCM Summary, Session Title, or Curated Memory Review assignment | Selected flow only                            |
| Managed Conversation lifecycle   | Desktop start, resume, send, handoff, and fork                                 | Exact persisted owner and requested operation |

A client may be healthy for capture or Local Synthesis while unsupported for
Managed Conversation. A current core status does not override any per-client,
per-capability, or per-flow gate.

`MEMORY_CODEX_APP_SERVER_BINARY` selects the Codex app-server binary.
`KOED_CLAUDE_CODE_EXECUTABLE` selects a separately installed Claude Code
executable for Claude-backed flows. Claude execution uses only pinned official
TypeScript Claude Agent SDK and local subscription authentication.
`KOED_PI_EXECUTABLE` selects separately installed Pi `0.84.2+`. Pi execution
uses strict-LF JSONL RPC, ephemeral sessions, disabled user/project resources,
one Koed structured-result bridge, minimal environment, and Pi-managed auth. An
unavailable provider or model fails visibly; Koed does not cross provider or
fall back to backend synthesis.

## Ownership

`koed-server` starts one Local AI Runtime per `KOED_HOME`. The runtime reads
effective settings when work begins, so a short-lived MCP adapter never owns
worker configuration or persistent scheduling. Persisted Memory Question
results remain inspectable through the API, but Desktop does not run a browser
answer bridge or submit manual synthesis work.

See [ADR 0025](adr/0025-mcp-v2-local-ai-runtime-ownership.md).

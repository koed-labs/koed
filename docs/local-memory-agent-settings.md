# Local AI Runtime Settings

Koed performs synthesis through the connected AI Client. The backend stores
memory and evidence but does not run LLM synthesis.

## Flows

The supervised Local AI Runtime owns three synthesis flows:

- MCP Memory Answer: a fresh isolated worker for each `memory_answer` call.
- LCM Summary: background LCM Summary and captured-session title work.
- Curated Memory Review: asynchronous source-linked proposal review.

Codex, Claude, and Pi are supported local providers. Each flow independently
selects AI Client instance, model, and supported model options. Pi model IDs
retain full underlying provider/model identity.

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

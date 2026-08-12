# Local AI Runtime Settings

Koed performs synthesis through the connected AI Client. The backend stores
memory and evidence but does not run LLM synthesis.

## Flows

The supervised Local AI Runtime owns three synthesis flows:

- MCP Memory Answer: a fresh isolated worker for each `memory_answer` call.
- LCM Summary: background LCM Summary and captured-session title work.
- Curated Memory Review: asynchronous source-linked proposal review.

Codex is the only supported provider in this build.

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

`MEMORY_CODEX_APP_SERVER_BINARY` selects the Codex app-server binary for all
three flows. An unavailable provider or model fails visibly; Koed does not fall
back to backend synthesis.

## Ownership

`koed-server` starts one Local AI Runtime per `KOED_HOME`. The runtime reads
effective settings when work begins, so a short-lived MCP adapter never owns
worker configuration or persistent scheduling. Persisted Memory Question
results remain inspectable through the API, but Desktop does not run a browser
answer bridge or submit manual synthesis work.

See [ADR 0025](adr/0025-mcp-v2-local-ai-runtime-ownership.md).

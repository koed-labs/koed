# Rely on AI clients for LLM synthesis

Koed relies on the connected AI Client for LLM synthesis. The backend stores memory, retrieves evidence, manages embeddings and ranking, and returns evidence for synthesis, but this build must not make server-side LLM calls. Earlier `server_synthesis` code is legacy test/internal code and should be removed from the supported build because server-side model calls shift cost, credential handling, and provider responsibility onto the backend.

The durable local execution boundary is defined by
[ADR 0025](./0025-mcp-v2-local-ai-runtime-ownership.md): `koed-server`
supervises local AI-client workers while MCP adapters remain transport-only.

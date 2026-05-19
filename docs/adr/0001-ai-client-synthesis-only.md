# Rely on AI clients for LLM synthesis

Koed Self-Hosted relies on the connected AI client for LLM synthesis. The backend stores memory, retrieves evidence, manages embeddings and ranking, and returns evidence for synthesis, but this build must not make server-side LLM calls. Earlier `server_synthesis` code is legacy test/internal code and should be removed from the supported self-hosted build because server-side model calls shift cost, credential handling, and provider responsibility onto the backend.

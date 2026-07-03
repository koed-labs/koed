# Koed

## 0.3.0

### Minor Changes

- 5a84477: Add explicit bundled-local embedding and reranker model installers with SHA-256 verification before writing model assets.
- 5a84477: Add an isolated bundled-local smoke workflow for validating local runtime startup and model installer wiring.
- 6b1bd28: Add a public backend capabilities contract for clients that target self-hosted or cloud Koed deployments.
- 5b8590c: Install the default bundled-local embedding model without requiring manual model URL and checksum configuration.
- 5a84477: Added external dependency mode for `koed-server` so Koed can connect to Operator-managed Postgres, Redis/BullMQ, and Embedding Service resources without starting or stopping Docker Compose dependencies.
- 5a84477: Finalize bundled-local readiness gates and smoke coverage, including migration, pgvector, Postgres version, queue, embedding model checks, native full personal smoke, and stop-based smoke cleanup.
- e42d50b: Added guided client bootstrap commands for Koed, including a single end-to-end bootstrap path, a separate Explorer token bootstrap, and clearer setup output for first-time Codex integration.
- 5a84477: Introduced Koed Desktop and the `koed-server` local control plane for starting services, reporting setup status, running doctor checks, and wrapping Codex setup while keeping Docker Compose focused on local dependencies.
- 3106a50: Add the Team SaaS launch validation command and checklist for fixture-backed
  release readiness checks.
- 5a84477: Add optional native bundled-local Postgres runtime resolution and startup under KOED_HOME.
- 5a84477: Improve Koed Desktop status surfaces with dependency-graph cards for startup and sidebar health, including compact status summaries, expandable live output, and remediation actions.
- 427bb9e: Add Team retention state foundations and hard-delete safeguards for retained Team memory.
- 1d58887: Add deterministic Team SaaS synthetic memory fixture commands for reset, seed, and validation.
- c8fcb69: Add Team-visible summary source-boundary checks to prevent shared summaries from including unshared private memory.
- 7439e5c: Use Codex transcript JSONL as the source of truth for capture Projection, with signal-only hooks, DB-backed projection policy rules, detached catch-up, and API defaults aligned to port 3000.
- 9631d2a: Enforce Team Workspace authorization across recall, graph, and memory expansion surfaces.

### Patch Changes

- 6b516ab: Track question data for memory_answer MCP calls, add question.origin field.
- 6772c03: Bound embedding service health probes so access-check and status routes fail fast when the embedding service is unreachable.
- a8e6f4c: Tighten hosted tenant-boundary coverage by rejecting Team scope on deprecated memory browser routes and documenting tracked launch gaps.
- d476c11: Add LCM summary benchmark coverage and harden LCM summary prompts around secret redaction, conflict handling, field placement, and noisy output compression.
- 274cbdb: Fix semantic projection so agent turns seal as bundled memory events, preserve whole transcript items across token-limit rollover, record token counts, and suppress duplicate hook fallback semantic events.
- fd9a277: Filter Team Workspace memory expansion supporting context through the same shared-session boundary as the expanded memory source.
- 19c3c51: Add Qwen query instruction embeddings

## 0.2.0

### Minor Changes

- a987246: Integrate drizzle-orm for DB type safety
- 6c68e41: Migrate local embedding serving to supervised llama-server and remove the legacy direct llama-cpp-python embedding benchmark path.

## 0.1.1

### Patch Changes

- 3e0028a: Explorer rename to remove history language
- 460051c: Add single-tag release automation for Koed.

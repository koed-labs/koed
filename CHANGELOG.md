# Koed

## 0.4.2

### Patch Changes

- c1cba29: Make packaged Desktop stop/reopen wait for the previous supervisor to exit and preserve actionable smoke diagnostics when startup fails.

## 0.4.1

### Patch Changes

- 2ee0b35: Make macOS native runtime builds independent of Homebrew OpenSSL and publish releases only after required artifacts pass validation.

## 0.4.0

### Minor Changes

- ede1237: Add a Project-first Koed Desktop experience that combines local Project identity metadata with captured memory activity, progressively opens Projects, sessions, and raw conversations, and condenses local Personal Memory settings.
- 3bf29ac: Add production Cross-Identity Sync for explicitly selected Captured Sessions with encrypted resumable transfer, target-side processing, lifecycle controls, and operational diagnostics.
- 639f3a7: Add personal Curated Memory intake with source-linked proposals, asynchronous local-agent review, normal recall integration, and semantic benchmark coverage.
- 3dd600f: Redesign Koed Desktop Project inspection as a responsive master-detail workspace, increase Project and Captured Session information density, move technical metadata into secondary disclosures, and keep the UI focused on shipped local memory flows.
- ede1237: Automatically organize Captured Sessions by detected Personal Project while allowing persistent User moves, reset to automatic placement, and explicit Unassigned organization.
- 37f50f8: Add browser-based local-edge device enrollment approval UI and session-auth challenge approval APIs so Team Backend device enrollment can be approved without exposing reusable credential material.
- a6b54f9: Add a Koed-managed Codex app-server ingestion path that reconciles persisted transcript evidence into canonical conversation items before Projection, embedding, and LCM processing.
- 962efa7: Replace the embedded Explorer session view with a native Koed Desktop Conversation surface, share long-Conversation virtualization with Explorer, and refine the Project, Captured Session, Settings, and responsive Desktop layouts.
- bba555e: Remove the Embedding Service Python virtualenv and Python runtime files from bundled-local packaged native runtime procurement, staging, validation, and Desktop packaging.
- b4b5e72: Retire the legacy Python Embedding Service source, development tooling, and CI checks now that bundled-local supervision uses the TypeScript Embedding Service.
- 409c50d: Switch bundled-local Embedding Service supervision to the TypeScript implementation while preserving the existing HTTP contract and keeping Python runtime assets in place until the follow-up removal.
- 6a21dbe: Improve Desktop first-run reliability for bundled-local setup by enabling automatic local ports for source Desktop, repairing Codex setup to use active runtime URLs, avoiding blocking health on missing setup verification, and clarifying the README quickstart.
- 0397ffb: Add standalone `koed-server` app-runtime package build, install, Desktop first-run resolution, release publishing, and provenance verification support.
- 6d67a25: Add Team SaaS foundation hardening for koed-server Docker builds, upstream trust-boundary resets, local-edge credential isolation, restore-smoke target safety, and encrypted source redaction during backfill.
- 0a52f4a: Add Project-to-Team Workspace mapping, Captured Session sharing, and opt-in Team Workspace recall from the MCP Server.
- 37f50f8: Add local `koed-server` upstream enrollment orchestration commands for starting, checking, canceling, and disconnecting Team Backend device enrollment with fail-closed capability and route-policy checks.
- 9d904d2: Add Team Backend enrollment from Desktop through local koed-server, encrypted local upstream credentials, and project-linked Team Workspace recall through MCP memory_answer.

### Patch Changes

- 7c02ed7: Add a TypeScript Embedding Service implementation that preserves the existing local embedding and reranking HTTP contract ahead of the bundled-local runtime switch.
- 379ee7f: Use the active bundled-local Postgres connection when setting up the supported AI Client, even when the checkout `.env` has a different database port.
- 5bac071: Ship editable Koed prompt files with packaged MCP runtimes and preserve prompt override configuration and LCM prompt-version provenance.
- 962efa7: Prevent concurrent local supervisors from reallocating ports or stopping another daemon's Postgres, recover stale Desktop API Tokens, keep Codex verification state aligned, redact setup token output, and distinguish Project loading failures from empty Personal Memory.
- 6d55ffd: Fix packaged macOS DMG startup when the mounted volume path contains spaces.
- cb87540: Isolate Team launch validation from deployment configuration and run destructive repository gates in a separate disposable database.
- 4a0f018: Make LCM leaves and rollups compact semantic indexes while retaining detailed source evidence for drill-down.
- 7327d65: Fix remote Team Backend enrollment approval URLs, preserve local Desktop API routing, automatically reconcile approved device credentials, and show the approval URL when system browser opening is delayed or unavailable.

## 0.3.1

### Patch Changes

- 11ca885: Add Team Workspace storage and request-time access primitives for Team SaaS.
- d196ad6: Ensure Stop and SubagentStop hooks queue transcript catch-up even when earlier catch-up is active, preserving final turn sealing after existing token-limit rollover.

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

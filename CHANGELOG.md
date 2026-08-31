# Koed

## 0.6.2

### Patch Changes

- d574c76: Trigger a patch release after fixing draft release publication.

## 0.6.1

### Patch Changes

- c158536: Update CI to fix binary release.

## 0.6.0

### Minor Changes

- 55b9d83: Reduce the default embedding context from 32K to 8K tokens and migrate legacy local accelerator allocation defaults to reduce Metal memory pressure while preserving the 4K embedding input contract.
- c3f3b1c: Make Shared Memory privacy classification bounded and durable with chunked manifests, resumable work claims, deterministic scheduling, fail-closed publication, runtime diagnostics, and shared accelerator coordination.
- eef5c0d: Automatically discover and import bounded recent history from every supported
  AI Client. Claude Code and Pi now use independent resumable historical
  coordinators alongside Codex, preserve live-capture admission priority, and
  recover safely from provider-specific source conflicts and oversized records.
- 56f8a8b: Move the Git remote inline with each Project's session/event counts instead of a collapsed "Project details" disclosure, and let each Captured Session open its Git remote and reveal its local Project path directly.
- 5dd6baf: Add a General preference to launch packaged Koed at operating-system sign-in.
  Closed Desktop windows remain available from the menu bar or system tray.

  The MCP Server now starts when Koed is unavailable and reconnects without a
  Codex restart. Memory tools return a clear connection error until Koed is
  available.

- 924d813: Add the Personal Ask welcome page, durable Ask conversations and Recents, and
  the Personal Notes master-detail workspace. Project newly created Notes into
  Personal Memory so they are embedded and available to Ask. Keep Memory Answer
  synthesis in the Local AI Runtime and preserve the protected Desktop boundary.
- 924d813: Add sharing of immutable Personal Note snapshots to authorized Team Workspaces,
  including fixed review, Pending Share activation, Team recall, evidence,
  companion discussion, and revocation flows.
- 7bfbd11: Improve initial setup of client onboarding.
- 56f8a8b: Show each local Project's normalized Git remote in the Desktop Project list and details. Desktop now starts Personal-only by default; set `KOED_TEAM_COLLABORATION_ENABLED=true` to explicitly enable Team collaboration and Privacy Filter provisioning.

### Patch Changes

- ab336d9: Build the bundled Linux pgvector extension for portable x64 CPUs and preserve native runtime validation diagnostics when release checks fail.
- 8635cac: Improve server startup, desktop ready polling.

## 0.5.0

### Minor Changes

- 569285d: Add agent-directed hybrid Memory retrieval, exact-grounded LCM lexical anchors,
  Team-safe semantic evidence and expansion, and a reproducible Retrieval Arena
  covering quality, cost, performance, encryption, and resource behavior.
- bdf3b16: Decouple Koed core readiness from AI Clients: `setup core --json` now bootstraps the database, embedding runtime, and Personal API Token without requiring any AI Client, and zero configured AI Clients is a healthy state. Add a typed AI Client capability and readiness contract shared across the MCP Server, API, koed-server, worker, and Desktop, with per-instance capability snapshots, fail-closed assignment revalidation, and no cross-client fallback. Desktop onboarding is now client-neutral with optional multi-select AI Client setup (Codex, Claude Code, Pi), per-client consent, safe repair and removal, and snapshot-backed per-client readiness. Preferences gains per-flow AI Client and model selectors for Memory Answer, LCM Summary, session titles, and Curated Memory Review. Managed Conversations now bind to an explicit AI Client instance with capability-gated admission and config-identity binding; Pi managed Conversations remain explicitly unsupported.
- d4b3ea6: Add staged Shared Memory creation and representation changes with owner-visible
  progress, recovery controls, authorized candidate previews, and durable status
  updates. Exclude Approval Activity from Projection-derived semantic memory and
  sharing while retaining its exact-source audit display.
- 108fbc1: Automatically discover and import bounded recent Codex history during local onboarding with resumable progress and live-safe capacity admission.
- 0bd556a: Calibrate embedding capacity and expose authorized semantic backlog, throughput, coverage, and completion estimates for local and hosted operations.
- c76eeca: Add clone-safe local deployment and device identity with redacted inspection, explicit rotation, and fail-closed remote-operation gating.
- 00a2aaa: Add supervised continuous Codex transcript watching with durable live recovery, bounded rescans, Capture Policy enforcement, and Hook-independent Personal Memory capture.
- 5c1d845: Add Claude Code as a supported local AI Client, including transcript capture,
  managed Conversation resume, provider-selectable Memory workflows, and
  multi-component Conversation Source replication. Add independently authorized
  Team sharing for encrypted Conversation Source journals, including redacted
  manifests, exact segment access, durable live streams, revocation, and verified
  fork snapshots.
- 56c2e0f: Add policy-gated historical import with durable provenance, idempotent progress, and bounded backpressure that prioritizes interactive and live capture work across local and BullMQ queues.
- 7ca1b65: Add a reproducible Terminal-Bench 3.0 experience-replay benchmark covering
  canonical Memory ingestion, product Recall, isolated replay conditions,
  security controls, cost admission, and publication-safe reporting.
- 6e2e9f0: License Koed and its repository history under the Apache License 2.0.
- 01c62d2: Add Pi as a supported AI Client Integration with isolated RPC synthesis, Koed memory tools, persistent-session transcript capture, historical import, setup diagnostics, Pi-sourced Project threads in Desktop, and compact AI Client source marks on Captured Sessions. Improve Desktop first-run setup by detecting installed Claude Code and Pi profiles, showing every detected AI Client, and offering optional explicit per-client selection and consent for capture and recall alongside Codex; detection never configures a client automatically. Refresh Advanced Diagnostics whenever it opens so startup health does not remain stale after services become ready.
- 171dc13: Add toolbar koed-server status badge.
- 7a38929: Add push-based Team member presence with automatic activity levels and manual availability controls.
- 3153645: Use GPT-5.6 Luna with low reasoning by default for local Memory Answer, LCM Summary, session-title, and Curated Memory synthesis.
- d702b30: Install and diagnose managed Codex global guidance for proactive Personal and Team Memory recall.
- 18cda8d: Add authoritative collaboration unread counts and scalable aggregate sent,
  delivered, and read receipts with durable realtime updates.
- e4ea6c7: Move browser-mediated Step-up actions and device enrollment onto dedicated
  approval pages served by the existing Koed API.

  Operators upgrading from an Explorer deployment must remove the retired
  Explorer service and its health checks, then point `BROWSER_PUBLIC_URL` (or the
  `API_BROWSER_PUBLIC_URL` Compose setting) at the public origin of the existing
  Koed API. Approval pages, authentication, and approval JSON are now served from
  that same API origin; no separate browser service is required.

- e4ab0d5: Add selective PII protection for Team-shared transcripts, Memory Events, LCM
  summaries, semantic embeddings, evidence, and exports while preserving exact
  Personal Memory for its owner.
- b1999c8: Add independently authorized Team sharing for encrypted Conversation Source
  journals, including redacted manifests, exact segment access, durable live
  streams, revocation, and verified fork snapshots.
- 02d2b04: Adopt the MCP 2026-07-28 protocol with a stateless Codex adapter backed by a
  supervised Local AI Runtime. Keep transcript capture, LCM summaries, Curated
  Memory review, and Memory Answer execution in the local runtime, make Memory
  Questions terminal-owned, and remove the legacy asynchronous question bridge.
- 4b346ec: Add tiered approval flow across platform.
- a69b856: Add encrypted Personal and Team collaboration, durable realtime messaging,
  Shared Memory representations with companion discussions, and the Electron
  collaboration experience with guided setup and resilient recovery flows.
  Introduce verified source replication, managed Conversation continuation,
  development workspace snapshots, cross-platform protected Personal Device
  Sync, portable Memory Event, embedding, and LCM artifact reuse, and explicit
  same-network device pairing with one-use encrypted QR links.
- a7a3f4c: Add verified automatic CPU, Apple Metal, and NVIDIA CUDA acceleration for
  embedding and reranking, including pinned native runtime variants, independent
  resource policies, five-minute idle model unloading, a persistent Desktop
  acceleration control, reproducible CPU/GPU performance evidence, truthful
  capacity telemetry, and a CUDA Compose deployment path.

### Patch Changes

- de715fc: Update CI for fast fail, migrate cold build to version release.
- b22d28d: Prevent the retention purge worker from repeatedly querying an empty queue while preserving immediate processing for queued purge work.
- 108fbc1: Fix two historical-onboarding correctness bugs found in review: a recently active Conversation whose final JSONL record exceeds the transcript-activity scan window no longer gets wrongly excluded by the 30-day cutoff (it read the transcript's creation time instead of the record's own timestamp), and a trailing agent_message with no response_item yet in view is now deferred across historical batches instead of being committed as its own item, preventing a duplicate projected representation of the same assistant turn once the response_item arrives.
- 108fbc1: Fix Curated Memory Review assignment being permanently unsavable for Claude models (e.g. Haiku) that report no explicit reasoning-effort support: the "none" sentinel is now resolved consistently by the Claude capability publisher, the default assignment, and the Desktop settings UI instead of leaving the field stuck on an unsatisfiable value.
- 093b98f: Cleanup desktop UI components.
- 108fbc1: Allowlist historical-import resume state before persisting it: only the fields real Codex/Claude adapters actually produce for mid-parse resume are stored, so arbitrary or oversized content passed as parser state can no longer be written to or read back from the historical import cursor.
- 2f0659f: Harden Personal Device Sync governance retries, certificate repair, and final-device recovery Key Bundle access.
- 108fbc1: Fix bounded historical onboarding getting permanently stuck when a single Codex JSONL record cannot fit within the historical batch byte/row limits: the source is now marked skipped instead of retried forever, so newer Conversations in the cohort continue to import.
- 3ae1802: Harden collaboration selection reconciliation and Team Presence realtime event
  validation.
- 92ef240: Keep CPU embedding capacity identities valid when llama-server reports a generic device listing.
- 6d3bd83: Keep open Personal Memory conversations visible while realtime updates refresh their latest events.

## 0.4.4

### Patch Changes

- 2a8db88: Fix macOS Desktop release artifacts with bundled native runtime files so they retain valid code signatures and can be verified before publication.
- 93d8924: Accept current upstream capability metadata, route explicit Team Workspace recall through matching Project links, and recover supervisor locks safely after process reuse.

## 0.4.3

### Patch Changes

- d84b818: Fix unsigned macOS Desktop artifacts so their app bundles have a valid sealed code signature instead of being reported as damaged by macOS.

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

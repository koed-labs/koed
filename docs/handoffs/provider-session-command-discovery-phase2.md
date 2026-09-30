# Handoff: Phase 2 — API Route Wiring and Cross-Cutting Improvements

**Status:** Phase 1 (Gaps 1+3) committed on PR1 branch. PR2 (Gaps 2+4) is on a stacked branch.
**PR1 Branch:** `feat/ai-client-aware-slash-suggestions` (committed)
**PR2 Branch:** `feat/command-op-id-persistence` (stacked on PR1)
**PR2 Handoff:** See `docs/handoffs/provider-session-command-discovery-phase2-pr2.md`

## What's Done (Phase 1)

The session-side implementation is complete:

1. **Catalog types** — `managed-conversation-command-types.ts` defines the full contract: provider, scope, source, verification, invocation metadata, action registry, operation ID types, IPC messages.

2. **Codex session** — `listCommands()` queries App Server `skills/list` (nested cwd-grouping fixed), includes `/compact` builtin, scans custom prompts. `executeControlAction()` dispatches directly (no queuing) via `thread/compact/start` with generation fencing and active-turn rejection.

3. **Claude session** — `listCommands()` uses SDK `supportedCommands()` when query active, falls back to file scan. `executeControlAction()` rejects all actions.

4. **Pi session** — `listCommands()` from file scan. `executeControlAction()` rejects all.

5. **File adapter** — All three adapters tag entries with `source: "global-file"`/`"project-file"`, `verification: "unverified"`. Slash-free names.

6. **IPC validation** — Desktop IPC protocol validates `verification` and `invocation` fields.

7. **UI** — `applySlashCommandReplacement()` prepends `/` to slash-free catalog names.

## Gaps to Close (Phase 2)

### Gap 1: API route wiring

**Current:** `apps/api/src/managed-conversations/routes.ts` still calls the file-only `createCommandDiscoveryAdapter()` for command discovery. The live catalog, draft listing, and control-action dispatch have no end-to-end route.

**What to do:**
- Extend the existing `POST /v1/managed-conversations/commands` route (lines ~1465-1590) to support:
  - **Draft discovery:** call `listCodexDraftCommands()` / `listClaudeDraftCommands()` from the worker adapter layer
  - **Live discovery:** route through the process that owns the session (worker). The API process does NOT own the session handle. Consider adding a worker RPC or message-passing path, or having the desktop communicate with the worker directly for live commands.
  - **Control action dispatch:** accept the `command_action` IPC operation at the API, validate against `MANAGED_CONVERSATION_CONTROL_ACTIONS`, and relay to the session owner with operation ID persistence.

**Constraints:**
- Operation ID must persist with conversation history (not just session memory). Consider storing in the memory API or conversation source artifact.
- The API must not pretend to own a live session it doesn't have access to.
- Keep request validation strict: owner, instance, generation, project, capability checks on the server/runtime side.

**Reference files:**
- `apps/api/src/managed-conversations/routes.ts` (lines 1465-1590)
- `apps/worker/src/command-discovery-adapter-codex.ts` (draft listing)
- `apps/worker/src/command-discovery-adapter-claude.ts`
- `apps/worker/src/command-discovery-adapter-pi.ts`

### Gap 2: Operation ID durability

**Current:** `controlActionStates` map in each session class stores operation state in memory only. A restart loses the record; retry can dispatch duplicate actions.

**What to do:**
- Persist operation ID + state alongside conversation history. Options:
  a. Store in Memory API as a conversation-side artifact (like captured sessions)
  b. Store in the conversation source segment
  c. Store as a lightweight row in a local persistence table

**Requirements:**
- Record includes: operationId, actionId, executionGeneration, status, createdAt
- Same ID returns existing state on retry (never redispatches)
- Timeout means "still reconciling," not "safe to retry"
- Persists at least as long as conversation history

**Reference:** Resolved design decisions §1 in the Phase 0 handoff.

### Gap 3: Fallback dispatch revalidation

**Current:** Unverified file-sourced entries are presented in the catalog but may be dispatched without revalidation.

**What to do:**
- At dispatch time, check if the command is `verified` or `unverified`.
- For `unverified` entries: revalidate against the provider catalog (if session is live) or fail closed (if no session available).
- Do not present unverified entries as confirmed executable; label them for revalidation.

**Reference:** Resolved design decisions §3 in the Phase 0 handoff.

### Gap 4: Capability readiness update

**Current:** The capability publisher (`ai-client-runner.ts` lines ~907-950) reports `slash_command_discovery` ready for supported clients. This should also reflect the new session-backed discovery capability.

**What to do:**
- Update the capability publisher to indicate readiness based on session type:
  - Codex: ready if App Server protocol supports `skills/list` and/or `thread/compact/start`
  - Claude: ready if SDK version supports `supportedCommands()`
  - Pi: ready if file scanning is functional
- Update the MCP client `memory_access_check` response to expose command discovery capabilities.

**Reference file:** `packages/mcp-server/src/ai-client-runner.ts` (lines 900-960)

## Implementation Order

1. **Gap 1 (API route)** — biggest missing piece. Blocks acceptance criteria.
2. **Gap 3 (revalidation)** — pairs well with Gap 1 since both touch the dispatch path.
3. **Gap 2 (op ID durability)** — needs storage design decision first.
4. **Gap 4 (capability readiness)** — smaller update, can be done last.

## Testing Requirements

- API tests for draft/live command discovery with real providers
- IPC tests for control action dispatch with operation ID
- Integration test: Codex `/compact` calls dedicated method, never prompt path
- Desktop tests: no accidental ordinary send for control actions
- Edge cases: stale generation, active turn rejection, duplicate op ID retry

## Acceptance Criteria

- With Codex selected in a Project-free Chat, `/` shows applicable global commands and skills
- A Project Conversation additionally shows commands/skills for its verified Project context
- Discovery is tied to selected client/session; does not create a turn or mutate state
- Selecting `/compact` and submitting invokes the dedicated provider action (not prompt text)
- Ordinary prompts retain normal send behavior
- Unknown/stale/unavailable commands fail closed
- All providers tested where supported; limitations explicit

## Files to Touch

- `apps/api/src/managed-conversations/routes.ts` — primary wiring
- `apps/worker/src/command-discovery-adapter-codex.ts` — draft listing (already done)
- `apps/worker/src/command-discovery-adapter-claude.ts` — draft listing (already done)
- `apps/worker/src/command-discovery-adapter-pi.ts` — draft listing (already done)
- `packages/mcp-server/src/ai-client-runner.ts` — capability readiness
- New file for op ID persistence (location TBD)
- Test files for all layers

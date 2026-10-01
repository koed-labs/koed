# Handoff: PR2 — Op ID Persistence + Capability Readiness

**Status:** Ready for implementation. PR1 (API route wiring + revalidation) is committed on `feat/ai-client-aware-slash-suggestions` and stacked below this branch.
**Branch:** `feat/command-op-id-persistence` (stacked on `feat/ai-client-aware-slash-suggestions`)

## PR1 (Already Committed)

1. **Gap 1 + Gap 3 implemented:** API route draft discovery with `mode: "draft"`, control_action IPC protocol types + validation, unverified command blocking at dispatch point.
2. **Worker exports:** Provider-specific adapters exported (`command-discovery-adapter-codex`, `-claude`, `-pi`).
3. **Desktop tests:** 852 pass. 8 pre-existing API test failures (terminal + stale assertions).

## PR2 Gaps

### Gap 2: Operation ID durability

**Current:** `controlActionStates` is an in-memory `Map<string, ManagedConversationControlActionResult>` in each session class (Codex: line ~384 in `codex-managed-conversation.ts`). A restart loses all state; retry can redispatch the same action.

**Decision (from Phase 0 design):** Store in Memory API as a conversation-side artifact. Automatic with session history, no new DB schema, survives restarts.

**Requirements:**

- Record schema: `{ operationId, actionId, executionGeneration, status, createdAt }`
- Same `operationId` returns existing state on retry (never redispatches)
- Timeout means "still reconciling," not "safe to retry"
- Persists at least as long as conversation history

**Approach:** Store as a lightweight segment on the conversation source artifact.

The `MemoryApiClient` already has segment operations:

- `ensureConversationSourceArtifact({ sourceKind, externalSessionId, ... })` — create/get artifact
- `listConversationSourceArtifactSegments(artifactId, params)` — list segments
- `getConversationSourceArtifactSegmentContent(artifactId, segmentId, params)` — read segment
- `storeConversationSourceArtifactSegment(artifactId, params)` — write segment

**Design:**

1. Use the existing conversation source artifact (created when the managed conversation starts) as the persistence target.
2. Store op ID state as a JSON segment under a well-known key (e.g., `command_action_state` or per-operationId segment).
3. On `executeControlAction()`:
   - Check in-memory map first (hot path)
   - If not found in memory, read from segment artifact
   - If not in artifact either, accept and write to both memory and artifact
   - Return existing state on retry (memory or artifact)
4. On state update (accepted/rejected/unknown): upsert the segment

**Files to modify:**

- `packages/mcp-server/src/codex-managed-conversation.ts` — op ID persistence layer
- `packages/mcp-server/src/claude-managed-conversation.ts` — op ID persistence layer
- `packages/mcp-server/src/pi-managed-conversation.ts` — op ID persistence layer (if exists)
- Potentially a new shared module: `packages/mcp-server/src/command-op-id-store.ts`

**Key considerations:**

- The segment approach should use the same `MemoryApiClient` that the session already uses
- The artifact is keyed by conversation identity (sourceKind + externalSessionId)
- Segment writes must be idempotent (use conditional upsert or accept 409 conflict)
- The `controlActionStates` in-memory map becomes a cache, not the source of truth
- On session restart, repopulate the in-memory map from artifact on first access

**Reference types:**

- `ManagedConversationControlActionState` in `packages/mcp-server/src/managed-conversation-command-types.ts`
- `ControlActionState` is stored in `controlActionStates: Map<string, ManagedConversationControlActionResult>`

### Gap 4: Capability readiness update

**Current:** In `packages/mcp-server/src/ai-client-runner.ts`, the `capability()` function hardcodes `slashCommandDiscovery` readiness to `"ready"` for all drivers.

```typescript
: id === aiClientCapabilityIds.slashCommandDiscovery
  ? "ready"
```

**What to do:** Make readiness conditional per driver.

Per-provider readiness:

- **Codex:** Ready if App Server is running AND we have models (current discovery already checks this). Readiness follows the driver's health state.
- **Claude:** Ready if Claude code is available (`checkClaudeCodeAvailability()` returns available). During discovery, this is known from the probe.
- **Pi:** Ready if file scanning works. File scanning always succeeds on a functioning system with valid `PI_CODING_AGENT_DIR`.

**Implementation approach:**

1. Add a `slashCommandDiscoveryReady: boolean` parameter to `capability()` and `capabilitiesFor()`.
2. In each driver's `discover()` function, compute readiness:
   - Codex: `true` if discovery succeeded (we have models and the App Server responded)
   - Claude: `true` if `checkClaudeCodeAvailability()` returned available
   - Pi: `true` (always ready on functioning system)
3. For error cases (driver unavailable), set readiness to `"unavailable"` or `"not_ready"`.
4. Also update the `aiClientDiscoveryError()` path to set slash command discovery to `"unavailable"` (current behavior already sets all capabilities to unavailable on error, which is correct).

**Files to modify:**

- `packages/mcp-server/src/ai-client-runner.ts` — add readiness param, per-driver logic
- `packages/mcp-server/src/ai-client-runner.test.ts` — update tests for new parameter

**Simplified readiness logic:**

```typescript
// In capability():
const slashCommandDiscoveryReadiness = slashCommandDiscoveryReady
  ? "ready"
  : support === "supported"
    ? "not_ready"
    : "unsupported";

const readiness =
  support !== "supported"
    ? "not_ready"
    : id === aiClientCapabilityIds.localSynthesis ||
        id === aiClientCapabilityIds.durableMemoryAnswer
      ? synthesisReady
        ? "ready"
        : "not_ready"
      : id === aiClientCapabilityIds.slashCommandDiscovery
        ? slashCommandDiscoveryReadiness
        : managedCapabilityIds.has(id)
          ? implementedManagedCapabilityIds.has(id)
            ? "ready"
            : "not_ready"
          : "unknown";
```

## Testing Requirements

- Op ID persistence: test that state survives "restart" (simulated by clearing in-memory map and re-querying)
- Op ID persistence: test retry returns existing state, not a new dispatch
- Op ID persistence: test timeout returns "still reconciling" (not "safe to retry")
- Capability readiness: verify Codex reports ready/unavailable based on health state
- Capability readiness: verify Claude reports ready/unavailable based on availability
- Capability readiness: verify Pi reports ready
- Capability readiness: error path sets all capabilities to unavailable

## Files to Touch

- `packages/mcp-server/src/ai-client-runner.ts` — Gap 4 (capability readiness)
- `packages/mcp-server/src/codex-managed-conversation.ts` — Gap 2 (op ID persistence)
- `packages/mcp-server/src/claude-managed-conversation.ts` — Gap 2 (op ID persistence)
- `packages/mcp-server/src/command-op-id-store.ts` — Gap 2 (shared op ID store, new file)
- `packages/mcp-server/src/ai-client-runner.test.ts` — Gap 4 tests
- Test files for op ID persistence

## Implementation Order

1. **Gap 4 (capability readiness)** — smaller, no storage decisions, unblocks visibility
2. **Gap 2 (op ID persistence)** — needs Memory API segment approach, affects 3 session classes

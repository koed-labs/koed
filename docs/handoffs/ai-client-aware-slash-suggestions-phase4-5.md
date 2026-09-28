# Handoff: AI Client-Aware Slash Suggestions — Phase 4/5 Remaining Work

**Date:** 2025-10-01
**Branch:** `feat/ai-client-aware-slash-suggestions`
**Base commit:** `ae1681d` (Phase 3 starting point)
**Current HEAD:** `8d95713` (Phase 3 complete)

## Status

**Phase 1-3: COMPLETE** ✅

All infrastructure for provider-discovered slash commands is wired end-to-end:
- IPC protocol types, parsers, and union updates
- Desktop preload API (`discoverCommands`)
- Koed Server manager routing (`command_discovery` handler)
- API route with full scope validation, capability checking, cache validation
- Desktop React hook (`useSlashCommandDiscovery`) with debounce, stale-if-error, keyed cache, cancellation guards
- ConversationInput wired to hook output via autocomplete props
- Worker adapter interface + factory (stubbed per driver)
- Error message mapping in IPC handler
- Protocol parser tests + preload API tests + hook tests

## What's Done (Phase 1-3)

### Protocol & Types
- `ManagedConversationCommandDiscoveryRequest` / `ManagedConversationCommandDiscoveryResult` types in `managed-conversation-protocol.ts`
- Parsers in `parseManagedConversationRequest()` and `parseManagedConversationResult()` with full validation (driverId pattern, instanceId ≤128 chars, projectId ≤128 chars, cwd optional, status enum, command fields, 128-command limit)
- `discoverCommands()` method on `ManagedConversationDesktopApi` interface and preload implementation

### API Route
- `POST /v1/managed-conversations/commands` with Zod schema, rate limiting, auth, scope validation
- Validates: driverId via `isSupportedAiClientDriverId()`, instance ownership via `ownerUserId`, driver match, cwd is absolute path, capability snapshot exists and not expired, descriptor has `support="supported"` and `readiness="ready"`
- Returns structured results: `{ status: "ok"|"unavailable"|"stale"|"unauthorized", commands: [], message? }`
- Currently returns `{ status: "ok", commands: [] }` — stub awaiting adapter dispatch

### Desktop Hook
- `useSlashCommandDiscovery()` in `use-slash-command-discovery.ts`
- Parameters: `api`, `driverId`, `instanceId`, `projectId`, `cwd`
- Features: 500ms debounce, 30s stale-if-error, keyed cache (Map by `${driverId}:${instanceId}:${projectId}:${cwd}`), AbortController for in-flight cancellation, fail-closed on all error paths
- `executionOwner?.driverId` used for provider (not `usage?.provider`) for lifecycle consistency
- Cache invalidated on key change; `unauthorized`/`stale` explicitly delete cache entry (no stale fallback)

### UI Integration
- `PersonalMemoryViews.tsx` calls hook with resolved params, passes `commands`, `loading`, `error` to `ConversationInput` as `autocompleteOptions`, `autocompleteLoading`, `autocompleteError`
- `use-slash-command-autocomplete.ts` deleted (unused, replaced by discovery hook)

### Worker Adapter Interface
- `command-discovery-adapter.ts`: `CommandDiscoveryAdapter` interface + `createCommandDiscoveryAdapter` factory
- All drivers return `null` stub (Phase 4 to implement)

## Key Decisions & Rulings

### Repository Model Mismatch (Phase 3)
- Plan assumed `getAiClientInstance()` and `getAiClientCapabilitySnapshot()` methods — they don't exist
- Real API uses `listAiClientInstances()` and `listCurrentAiClientCapabilitySnapshots()` with `.find()` by instanceId
- `AiClientInstanceRecord` has NO `projectId` or `workingDirectory` fields — only `ownerUserId`, `driverId`, `enabled`, `configIdentityHash`
- Project validation limited to format check (1-128 chars); instance ownership via `ownerUserId`

### AbortSignal Contract
- Cannot pass `signal` into `discoverCommands()` — Electron IPC doesn't support it, protocol `exactKeys()` rejects unknown keys
- Cancellation handled via `AbortController` + signal guard on `.then()/.catch()` only (prevents stale state updates)

### Driver ID Resolution
- Hook uses `executionOwner?.driverId` (not `usage?.provider`) to maintain lifecycle consistency with instanceId source
- Prevents stale/disconnected provider when instance changes

### Failure Modes (all fail-closed)
| Scenario | Response |
|----------|----------|
| Instance not ready | `{ status: "unavailable", commands: [] }` |
| Capability expired/stale | `{ status: "unavailable", commands: [] }` |
| Unauthorized (wrong owner/driver) | `{ status: "unauthorized", commands: [] }` |
| Adapter returns empty | `{ status: "ok", commands: [] }` (no menu, submit unchanged) |
| IPC timeout (>5s) | IPC error → desktop catches → empty list |

### Cache Semantics
- Key: `cmd:<driverId>:<instanceId>:<projectId>:<cwdHash>` (worker side)
- TTL: 30s
- Trailing debounce: 500ms, scheduled via `setTimeout`
- Stale-if-error: keeps old commands for 30s while re-fetching
- `unauthorized`/`stale` results explicitly DELETE cache entry (no stale fallback)
- Scope change (new instanceId/projectId/cwd) invalidates previous cache keys

## Phase 4: Adapter Implementation

### Goal
Replace the hardcoded `{ status: "ok", commands: [] }` in the API route with actual provider-specific command discovery.

### Current State
```
Desktop IPC → Koed API POST /v1/managed-conversations/commands
  → validates auth/scope/capability
  → returns { status: "ok", commands: [] }  ← STUB HERE
```

### Required Changes

#### 4a. Wire API Route to Worker Adapter

**File:** `apps/api/src/managed-conversations/routes.ts`

After the capability readiness check (before `return { status: "ok", commands: [] }`), import and call the adapter:

```ts
import { createCommandDiscoveryAdapter } from "@koed/worker/command-discovery-adapter";

// ... after isReady check passes ...

const adapter = createCommandDiscoveryAdapter(body.aiClientDriverId);
let commands: ManagedConversationSlashCommand[] = [];

if (adapter) {
  try {
    commands = await adapter.discoverCommands({
      aiClientDriverId: body.aiClientDriverId,
      aiClientInstanceId: body.aiClientInstanceId,
      projectId: body.projectId,
      ...(body.cwd ? { cwd: body.cwd } : {})
    });
  } catch (err) {
    // Adapter error → unavailable, not unauthorized
    return {
      operation: "command_discovery",
      status: "unavailable",
      commands: []
    };
  }
} else {
  // No adapter for this driver → unavailable
  return {
    operation: "command_discovery",
    status: "unavailable",
    commands: []
  };
}

return {
  operation: "command_discovery",
  status: "ok",
  commands
};
```

**Important notes:**
- The adapter lives in `@koed/worker` package — verify the import path matches the package exports
- Adapter is synchronous (`createCommandDiscoveryAdapter`) but `discoverCommands()` is async
- Any adapter error must be caught and converted to `{ status: "unavailable" }` (fail-closed)
- If `adapter` is `null` (unrecognized driverId — shouldn't happen after driverId validation, but defensive), return unavailable

#### 4b. Implement Codex Adapter

**File:** `apps/worker/src/command-discovery-adapter-codex.ts`

The adapter should inspect the active Codex process's registered slash commands.

**Strategy:**
1. Check if Codex runtime is available via `checkCodexAppServerAvailability()` (already imported in `managed-conversation-service.ts`)
2. If not available, return empty array `[]`
3. If available, read the Codex app server's command definitions — look for registered slash commands from the Codex protocol

**Reference:** `checkCodexAppServerAvailability` in `@koed/shared` provides the availability check. The Codex app server protocol defines slash commands — inspect the available commands from the Codex instance configuration.

**Fallback:** Return `[]` (not an error) if discovery fails at any step.

#### 4c. Implement Claude Code Adapter

**File:** `apps/worker/src/command-discovery-adapter-claude.ts`

The adapter should read root commands and skills from Claude Code's SDK session state.

**Strategy:**
1. Check if Claude Code is available via `checkClaudeCodeAvailability()` (already imported in `managed-conversation-service.ts`)
2. If not available, return empty array `[]`
3. If available, inspect the Claude SDK session state for root commands and skills

**Reference:** `ClaudeManagedConversationSession` in `@koed/shared` manages Claude sessions. Look for exposed command/skill definitions.

**Preservation rules:**
- Preserve the distinction between root commands and skills (Claude distinguishes these)
- Root commands have broader scope; skills are more targeted

**Fallback:** Return `[]` if discovery fails.

#### 4d. Implement Pi Adapter

**File:** `apps/worker/src/command-discovery-adapter-pi.ts`

The adapter should inspect Pi SDK/runtime capabilities.

**Strategy:**
1. Check if Pi is available via `checkPiAvailability()` (already imported in `managed-conversation-service.ts`)
2. If not available, return empty array `[]`
3. If available, inspect the Pi SDK for available tool groups and capabilities

**Reference:** `PiManagedConversationSession` in `@koed/shared` manages Pi sessions. Inspect exposed tool groups.

**Fallback:** Return `[]` if discovery fails.

#### 4e. Register Adapters in Factory

**File:** `apps/worker/src/command-discovery-adapter.ts`

Update the factory to return actual adapter instances:

```ts
import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";
import { createCodexCommandDiscoveryAdapter } from "./command-discovery-adapter-codex.js";
import { createClaudeCommandDiscoveryAdapter } from "./command-discovery-adapter-claude.js";
import { createPiCommandDiscoveryAdapter } from "./command-discovery-adapter-pi.js";

export interface CommandDiscoveryAdapter {
  discoverCommands(args: {
    aiClientDriverId: SupportedAiClientDriverId;
    aiClientInstanceId: string;
    projectId: string;
    cwd?: string;
  }): Promise<ManagedConversationSlashCommand[]>;
}

export type CommandDiscoveryAdapterFactory = (
  driverId: SupportedAiClientDriverId
) => CommandDiscoveryAdapter | null;

export const createCommandDiscoveryAdapter: CommandDiscoveryAdapterFactory = (
  driverId: SupportedAiClientDriverId
): CommandDiscoveryAdapter | null => {
  switch (driverId) {
    case "codex":
      return createCodexCommandDiscoveryAdapter();
    case "claude":
      return createClaudeCommandDiscoveryAdapter();
    case "pi":
      return createPiCommandDiscoveryAdapter();
    default:
      return null;
  }
};
```

### Per-Adapter Contract

All adapters must implement:
```ts
export interface CommandDiscoveryAdapter {
  discoverCommands(args: {
    aiClientDriverId: SupportedAiClientDriverId;
    aiClientInstanceId: string;
    projectId: string;
    cwd?: string;
  }): Promise<ManagedConversationSlashCommand[]>;
}
```

Where `ManagedConversationSlashCommand` is defined in `command-discovery-adapter.ts`:
```ts
export type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider";
};
```

### Adapter Safety Rules
- **NO arbitrary shell execution** — adapters inspect running processes/state, don't spawn shells
- **NO transcript scraping** — discovery reads command definitions, not conversation history
- **Fail-closed** — all errors return `[]`, never throw to the caller
- **Timeout** — each adapter should have a reasonable timeout (≤2s); if exceeded, return `[]`
- **Sanitization** — command names must be ≤64 chars, descriptions ≤512 chars, kind must be "command" or "skill", source must be "provider"

## Phase 5: Tests and Documentation

### Required Tests

#### API Route Tests
Add to `apps/api/src/managed-conversations/routes.test.ts`:
- Adapter returns commands → route returns them with status "ok"
- Adapter throws → route returns status "unavailable"
- Adapter returns empty → route returns status "ok" with empty commands

#### Adapter Tests
Create `apps/worker/src/command-discovery-adapter.test.ts` and per-adapter test files:
- Factory returns correct adapter per driverId
- Factory returns null for unrecognized driverId
- Codex adapter returns commands when runtime available, `[]` when not
- Claude adapter returns commands when runtime available, `[]` when not
- Pi adapter returns commands when runtime available, `[]` when not
- All adapters return `[]` on error (not throw)
- Adapter timeouts return `[]`
- Command name/description/argumentHint field validation (length limits, sanitization)

#### Wire Integration Tests
Add to `apps/desktop/src/renderer/views/personal/PersonalMemoryViews.test.tsx` or a new file:
- Discovery fetches on mount when instance is active
- Autocomplete menu populates with discovered commands
- Instance switch clears cached commands
- Stale discovery keeps UI responsive
- Unavailable state shows no menu

### Documentation Updates

#### `docs/managed-conversation-ai-client-routing.md`
Add a section documenting the `command_discovery` IPC operation:
- Request/response types
- Routing path: Desktop IPC → Manager → Koed API POST → Adapter
- Cache semantics (worker-side, 30s TTL)
- Failure modes and their responses
- Per-adapter discovery strategies

#### `docs/handoffs/ai-client-aware-slash-suggestions-in-progress.md`
Update to reflect Phase 1-3 completion and document remaining Phase 4/5 work (this document).

## Handoff Completion Criteria

A follow-up agent is done when a User can:
1. Select an AI Client instance (Codex, Claude, or Pi)
2. Type `/` and see only commands discovered for that instance (not all commands)
3. Select a command without accidental submission
4. Send it as ordinary provider-recognized prompt text
5. Stale, unsupported, unauthorized, or unavailable discovery fails closed and leaves prompt submission behavior unchanged
6. Adapter-specific commands appear correctly (Codex slash commands, Claude root commands + skills, Pi SDK tools)

## Non-goals (unchanged)

- Binary image/file prompt attachments
- Clipboard image paste or drag/drop upload
- Paseo plugin system
- Arbitrary local path injection
- Server-side LLM synthesis
- Automatic execution of slash commands from suggestion menu
- Changing Conversation capture, Memory, Projection, or Recall semantics

## Files to Create/Modify for Phase 4

| File | Action |
|------|--------|
| `apps/api/src/managed-conversations/routes.ts` | Modify: wire adapter call after capability check |
| `apps/worker/src/command-discovery-adapter.ts` | Modify: register concrete adapter implementations |
| `apps/worker/src/command-discovery-adapter-codex.ts` | Create: Codex command discovery |
| `apps/worker/src/command-discovery-adapter-claude.ts` | Create: Claude command discovery |
| `apps/worker/src/command-discovery-adapter-pi.ts` | Create: Pi command discovery |

## Files to Create for Phase 5

| File | Action |
|------|--------|
| `apps/api/src/managed-conversations/routes.test.ts` | Add: adapter integration tests |
| `apps/worker/src/command-discovery-adapter.test.ts` | Create: factory + basic tests |
| `apps/worker/src/command-discovery-adapter-codex.test.ts` | Create: Codex adapter tests |
| `apps/worker/src/command-discovery-adapter-claude.test.ts` | Create: Claude adapter tests |
| `apps/worker/src/command-discovery-adapter-pi.test.ts` | Create: Pi adapter tests |
| `docs/managed-conversation-ai-client-routing.md` | Update: add command discovery contract section |
| `docs/handoffs/ai-client-aware-slash-suggestions-in-progress.md` | Update: mark Phase 1-3 complete, document Phase 4/5 |

## Next Steps for Follow-up Agent

1. Read the spec at `docs/superpowers/specs/2025-07-25-ai-client-aware-slash-suggestions-design.md`
2. Read the existing handoff at `docs/handoffs/ai-client-aware-slash-suggestions-in-progress.md`
3. Read `apps/worker/src/command-discovery-adapter.ts` to understand the current stub interface
4. Implement Phase 4 adapters (start with Codex, then Claude, then Pi)
5. Wire the API route to call the adapter
6. Add Phase 5 tests
7. Update documentation
8. Run full test suite: `pnpm --filter @koed/desktop test` and `pnpm --filter @koed/api test`
9. Update the handoff document to mark all phases complete

## Branch State

```
Current HEAD: 8d95713 feat(worker): add command discovery adapter interface and factory (stubbed)
Parent (Phase 3 start): ae1681d feat(manager): add command_discovery handler to managedConversation routing
```

11 commits from Phase 3:
- `8d95713` feat(worker): add command discovery adapter interface and factory (stubbed)
- `db34cea` fix(ui): resolve driverId from executionOwner for consistency
- `63337b6` fix(ui): correct hook parameter resolution to active instance only
- `7919b15` feat(ui): wire useSlashCommandDiscovery into ConversationInput
- `67e8aa9` fix(ui): remove signal from IPC call, invalidate cache on unauthorized
- `24ce184` fix(ui): fix unauthorized fail-closed, request signal, scope transition flash
- `656c4d9` fix(ui): correct cache logic, debounce, scope isolation, and fail-closed in useSlashCommandDiscovery
- `207525a` feat(ui): add useSlashCommandDiscovery hook, remove unused useSlashCommandAutocomplete
- `089ba0c` fix(api): handle malformed expiresAt and use platform-neutral cwd validation
- `999e389` feat(api): add /v1/managed-conversations/commands route for command discovery
- `ae1681d` feat(manager): add command_discovery handler to managedConversation routing

Previous 3 commits from Phases 1-2 (before `ae1681d`):
- `73637e0` docs: handoff for remaining slash suggestion phases
- `92c5320` feat(desktop): integrate slash command autocomplete into ConversationInput
- `36c306d` feat(desktop): add pure autocomplete helpers for slash commands

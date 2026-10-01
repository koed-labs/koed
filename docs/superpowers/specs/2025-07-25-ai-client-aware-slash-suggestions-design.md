# AI Client-Aware Slash Suggestions — Design Spec

**Date:** 2025-07-25
**Status:** Approved
**Handoff reference:** `docs/handoffs/ai-client-aware-slash-suggestions-in-progress.md`
**Base commit:** `ff5c7e1` (feat(pds): secure capability-based personal device enrollment)
**Current branch:** `feat/ai-client-aware-slash-suggestions`

## Summary

Phase 3 of AI Client-aware slash command suggestions. Wires provider-discovered commands into the existing UI (completed in Phases 1-2) via a typed, read-only IPC protocol backed by worker-side adapters. Discovery never affects prompt submission. Failure modes are all fail-closed.

## Non-goals (unchanged)

- Binary image/file prompt attachments
- Clipboard image paste or drag/drop upload
- Paseo plugin system
- Arbitrary local path injection
- Server-side LLM synthesis
- Automatic execution of slash commands from suggestion menu
- Changing Conversation capture, Memory, Projection, or Recall semantics

## Architecture & Data Flow

Discovery is a read-only, fail-closed diagnostic path.

```
Desktop (ConversationInput)
  └─ IPC: command_discovery { driverId, instanceId, projectId, cwd? }
    └─ Managed conversation preload (desktop)
      └─ Worker route: command_discovery
        └─ CommandDiscoveryAdapter interface
          ├─ Codex: inspect available slash commands from runtime
          ├─ Claude: preserve root commands vs skills distinction
          └─ Pi: inspect SDK/runtime capabilities
```

The Desktop calls `discoverCommands()` on the managed conversation IPC API. The worker validates the request against the authenticated user's active instance, checks capability readiness, applies scope validation, looks up a cache, and dispatches to the per-adapter implementation.

## Protocol Types & Validation

### Request type (`apps/desktop/src/ipc/managed-conversation-protocol.ts`)

```ts
export type ManagedConversationCommandDiscoveryRequest = {
  operation: "command_discovery";
  aiClientDriverId: SupportedAiClientDriverId;
  aiClientInstanceId: string;
  projectId: string;
  cwd?: string;
};
```

Validation:

- `operation` must be `"command_discovery"`
- `aiClientDriverId` validated via `isSupportedAiClientDriverId()`
- `aiClientInstanceId` validated as non-empty, trimmed, ≤128 chars, alphanumeric pattern
- `projectId` validated as non-empty, trimmed, ≤128 chars
- `cwd` is optional; if present, validated as non-empty, trimmed path

### Result type

```ts
export type ManagedConversationCommandDiscoveryResult =
  | {
      operation: "command_discovery";
      status: "ok";
      commands: ManagedConversationSlashCommand[];
    }
  | {
      operation: "command_discovery";
      status: "unavailable" | "stale" | "unauthorized";
      commands: [];
      message?: string;
    };
```

Validation:

- `status` must be one of `"ok"`, `"unavailable"`, `"stale"`, `"unauthorized"`
- `commands` must be an array
- When `status` is `"ok"`, commands bounded to max 128 entries
- Each command: `name` (≤64 chars), `description` (≤512 chars), `argumentHint` (optional), `kind` must be `"command"` or `"skill"`, `source` must be `"provider"`

### Desktop API addition

```ts
discoverCommands: (
  input: Omit<ManagedConversationCommandDiscoveryRequest, "operation">
) =>
  Promise<
    Extract<ManagedConversationResult, { operation: "command_discovery" }>
  >;
```

Implemented in `createManagedConversationPreloadApi` as `correlated("command_discovery", invoke(...))`.

## Worker Adapter Dispatch

### Capability addition

In `packages/shared/src/ai-client-contract.ts`, add to `aiClientCapabilityIds`:

```ts
slashCommandDiscovery: "slash_command_discovery",
```

### Worker route handler

The worker validates in order:

1. Request is bound to authenticated user's instance
2. Capability snapshot has `slashCommandDiscovery` with `support="supported"`, `readiness="ready"`
3. Instance matches `aiClientDriverId` + `aiClientInstanceId`
4. `projectId` matches instance's project binding
5. If `cwd` provided, it is within the instance's working directory boundary
6. Cache lookup: key = `"cmd:<driverId>:<instanceId>:<projectId>:<cwdHash>"`
7. If cache hit and not stale → return cached commands (30s TTL)
8. Call adapter's `discoverCommands()`
9. Store result in cache with 30s TTL
10. Return commands

### Adapter interface (`apps/worker/src/command-discovery-adapter.ts`)

```ts
import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";

export type ManagedConversationSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
  source: "provider";
};

export interface CommandDiscoveryAdapter {
  discoverCommands(args: {
    aiClientDriverId: SupportedAiClientDriverId;
    aiClientInstanceId: string;
    projectId: string;
    cwd?: string;
  }): Promise<ManagedConversationSlashCommand[]>;
}
```

### Per-adapter implementations

| Adapter         | Strategy                                                                                  | Fallback                                                |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Codex**       | Inspect active Codex process's registered slash commands via app-server protocol          | Empty list + diagnostic "command discovery unavailable" |
| **Claude Code** | Read root commands and skills from SDK session state; preserve root vs skills distinction | Empty list                                              |
| **Pi**          | Inspect SDK/runtime capabilities; map available tool groups to slash commands             | Empty list                                              |

All adapters return an empty array (not an error) on failure. The worker converts empty adapter results to `status: "unavailable"` or `status: "ok"` with an empty array based on whether the capability check passed.

### Sandbox enforcement

- No arbitrary shell execution
- No transcript scraping
- Discovery response cannot contain paths outside the instance's working directory
- Response bounded to max 128 commands
- Each command name ≤ 64 chars, description ≤ 512 chars

## Desktop Hook & Integration

### Discovery hook (`apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts`)

Replaces the existing unused `use-slash-command-autocomplete.ts`.

```ts
function useSlashCommandDiscovery(
  driverId: SupportedAiClientDriverId | null,
  instanceId: string | null,
  projectId: string | null,
  cwd: string | null
);
```

State: `commands[]`, `loading`, `error`, `lastFetchedAt`

Behavior:

- Refetches when any dependency changes
- No-op when any dependency is `null` → returns empty list
- Debounced: 500ms between fetches
- Stale-if-error: keeps old commands for 30s while re-fetching

### ConversationInput integration

The hook feeds into the existing `ConversationInput` props:

- `autocompleteOptions` ← from hook's `commands`
- `autocompleteLoading` ← from hook's `loading`
- `autocompleteError` ← from hook's `error` (displayed as inline hint in popover)

### Lifecycle interaction

When the lifecycle module detects an instance switch:

1. Clear cached commands (invalidate)
2. Reset autocomplete state in ConversationInput
3. On next slash keypress, trigger fresh discovery

### New Conversation startup

For brand-new Conversations (pre-start), discovery is not available. `autocompleteOptions` is `[]` until the Conversation starts and the instance becomes active. After start completes, commands populate within the discovery TTL window. The UI shows no menu items when commands is empty — prompt submission behavior is unchanged (raw text submitted as prompt).

## Error Handling & Failure Modes

All failure modes fail closed: no menu displayed, prompt submission unchanged.

| Scenario                           | Worker response                            | UI behavior |
| ---------------------------------- | ------------------------------------------ | ----------- |
| Instance not ready                 | `{ status: "unavailable", commands: [] }`  | No menu     |
| Capability snapshot stale/expired  | `{ status: "stale", commands: [] }`        | No menu     |
| Unauthorized (wrong user/instance) | `{ status: "unauthorized", commands: [] }` | No menu     |
| Adapter not implemented            | `{ status: "unavailable", commands: [] }`  | No menu     |
| Timeout (>5s)                      | `{ status: "unavailable", commands: [] }`  | No menu     |
| Invalid response from worker       | IPC error → desktop catches → empty list   | No menu     |

### Cache invalidation triggers

- Instance switch → clear all caches
- Capability snapshot expiry → clear
- Project change → clear caches scoped to that project
- `cwd` change → clear caches scoped to that cwd

### Worker scope validation

```
If request.instanceId !== activeSnapshot.instanceId → unauthorized
If request.driverId !== snapshot.driverId → unauthorized
If request.projectId not in instance's project binding → unauthorized
```

### Desktop timeout

- IPC invoke with 5s timeout
- On timeout: treat as `unavailable`, retry on next `/` keypress

## Handoff Completion Criteria

A follow-up agent is done when a User can:

1. Select an AI Client instance
2. Type `/` and see only commands discovered for that instance
3. Select a command without accidental submission
4. Send it as ordinary provider-recognized prompt text
5. Stale, unsupported, unauthorized, or unavailable discovery fails closed and leaves prompt submission behavior unchanged

## Files Changed

| File                                                                         | Change                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared/src/ai-client-contract.ts`                                  | Add `slashCommandDiscovery` capability ID        |
| `apps/desktop/src/ipc/managed-conversation-protocol.ts`                      | Add discovery request/result types + parsers     |
| `apps/desktop/src/ipc/managed-conversation-preload.ts`                       | Add `discoverCommands()` API method              |
| `apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts`    | New: discovery hook                              |
| `apps/desktop/src/renderer/views/personal/use-slash-command-autocomplete.ts` | Remove (unused, replaced)                        |
| `apps/desktop/src/renderer/views/personal/ConversationInput.tsx`             | Wire discovery hook output to autocomplete props |
| `apps/worker/src/managed-conversation-service.ts`                            | Add discovery route + cache                      |
| `apps/worker/src/command-discovery-adapter.ts`                               | New: adapter interface + factory                 |
| `apps/worker/src/command-discovery-adapter-codex.ts`                         | New: Codex adapter                               |
| `apps/worker/src/command-discovery-adapter-claude.ts`                        | New: Claude adapter                              |
| `apps/worker/src/command-discovery-adapter-pi.ts`                            | New: Pi adapter                                  |

## Test Plan

### Worker adapter tests

- Adapter factory returns correct adapter per driverId
- Codex adapter returns empty list when process not running
- Claude adapter preserves root commands vs skills distinction
- Pi adapter returns commands from SDK capability inspection
- All adapters return empty list (not errors) on failure

### Worker route tests

- Authorized request returns cached commands
- Stale cache (TTL expired) triggers adapter refresh
- Unauthorized request (wrong instance) returns unauthorized status
- Request for unknown instance returns unavailable status
- Scope validation: rejects project mismatch, rejects invalid cwd

### IPC protocol tests

- Parser accepts valid discovery request
- Parser rejects invalid driverId, missing projectId
- Parser accepts valid discovery result
- Parser rejects invalid status, missing commands array
- Parser rejects malformed command objects

### Desktop tests

- Autocomplete options populates when discovery resolves
- Autocomplete menu shows commands matching typed query
- Autocomplete menu hides when discovery returns empty
- Stale discovery keeps UI responsive with empty list
- Instance switch clears cached commands

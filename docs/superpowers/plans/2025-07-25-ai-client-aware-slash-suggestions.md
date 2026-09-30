# AI Client-Aware Slash Suggestions (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire provider-discovered commands into the existing autocomplete UI (Phases 1-2) via a typed, read-only IPC protocol backed by worker-side adapters. Discovery never affects prompt submission; all failure modes fail closed.

**Architecture:** Desktop IPC → Koed API HTTP endpoint → (local) Worker adapter → response. The protocol adds a `command_discovery` operation to the existing managed-conversation IPC pattern. The API validates auth and capability, then dispatches to the worker's adapter factory. Worker adapters return empty lists on failure; the UI never crashes or blocks prompt submission.

**Tech Stack:** TypeScript, React (Electron renderer), Fastify (API), IPC via Electron's ipcMain/ipcRenderer, Zod (API validation)

**Spec:** `docs/superpowers/specs/2025-07-25-ai-client-aware-slash-suggestions-design.md`

## Global Constraints

- `ManagedConversationSlashCommand` type defined in `apps/desktop/src/renderer/views/personal/ai-client-slash-suggestions.ts` with `name`, `description`, `argumentHint?`, `kind: "command" | "skill"`, `source: "provider"` — used by existing Phases 1-2 UI
- All parsers in `managed-conversation-protocol.ts` use exact key validation with `exactKeys()` and field-level validators
- `isSupportedAiClientDriverId()` in `@koed/shared/ai-client-contract` validates driver IDs against `["codex", "claude", "pi"]`
- Desktop IPC error messages use a `Record<ManagedConversationResult["operation"], string>` lookup keyed by operation name
- The `use-slash-command-autocomplete.ts` file exists but is NOT exported or used — replace it with a new discovery hook

## Review Focus

- Stale capability snapshot (expired `expiresAt`) must return unavailable, not cached stale commands
- Instance mismatch between request and auth context must return unauthorized, not leaked commands from another instance
- CWD must be validated as within the instance's working directory boundary; reject arbitrary path injection
- Timeout on IPC (>5s) must return unavailable, not hang the UI
- Empty adapter result must return `{ status: "ok", commands: [] }`, not an error, so the UI shows an empty menu gracefully

---

### Task 1: Add `slashCommandDiscovery` capability ID

**Files:**
- Modify: `packages/shared/src/ai-client-contract.ts:84-103`

**Interfaces:**
- Consumes: `aiClientCapabilityIds` object
- Produces: `slashCommandDiscovery: "slash_command_discovery"` entry

- [ ] **Step 1: Read current capability IDs**
  Read `packages/shared/src/ai-client-contract.ts` lines 84-103 to see the current `aiClientCapabilityIds` object.
- [ ] **Step 2: Add `slashCommandDiscovery` to capability IDs**
  Add `slashCommandDiscovery: "slash_command_discovery"` as the last entry in the `aiClientCapabilityIds` object. Keep all existing entries unchanged.
- [ ] **Step 3: Commit**
  ```bash
  git add packages/shared/src/ai-client-contract.ts
  git commit -m "feat(capability): add slashCommandDiscovery capability ID"
  ```

---

### Task 2: Add discovery request and result types to IPC protocol

**Files:**
- Modify: `apps/desktop/src/ipc/managed-conversation-protocol.ts`

**Interfaces:**
- Consumes: `SupportedAiClientDriverId` from `@koed/shared/ai-client-contract`
- Produces: `ManagedConversationCommandDiscoveryRequest` type, `ManagedConversationCommandDiscoveryResult` type, adds them to union types

- [ ] **Step 1: Read current protocol types**
  Read lines 1-170 of `managed-conversation-protocol.ts` to see the existing type pattern (types, validation constants, `record()`, `exactKeys()`, `identifier()` helpers).
- [ ] **Step 2: Add request type**
  Add the `ManagedConversationCommandDiscoveryRequest` type definition after the existing request types (around line 145, after `ManagedConversationForkRequest`):
  ```ts
  export type ManagedConversationCommandDiscoveryRequest = {
    operation: "command_discovery";
    aiClientDriverId: SupportedAiClientDriverId;
    aiClientInstanceId: string;
    projectId: string;
    cwd?: string;
  };
  ```
- [ ] **Step 3: Add result type**
  Add the `ManagedConversationCommandDiscoveryResult` type after the existing result types (around line 315, after `ManagedConversationTransferLifecycle`):
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
  Add `ManagedConversationCommandDiscoveryResult` to the union in `ManagedConversationResult` type (around line 330).
- [ ] **Step 4: Add to ManagedConversationRequest union**
  Add `ManagedConversationCommandDiscoveryRequest` to the `ManagedConversationRequest` union (around line 175).
- [ ] **Step 5: Commit**
  ```bash
  git add apps/desktop/src/ipc/managed-conversation-protocol.ts
  git commit -m "feat(protocol): add command_discovery request and result types"
  ```

---

### Task 3: Add discovery parser to IPC protocol

**Files:**
- Modify: `apps/desktop/src/ipc/managed-conversation-protocol.ts`

**Interfaces:**
- Consumes: `identifier()` helper, `isSupportedAiClientDriverId()` from shared, `ManagedConversationSlashCommand` type (imported from `ai-client-slash-suggestions.ts`)
- Produces: Parser handles in `parseManagedConversationRequest()` and `parseManagedConversationResult()`

- [ ] **Step 1: Import ManagedConversationSlashCommand**
  Add import at the top of the file:
  ```ts
  import type { ManagedConversationSlashCommand } from "../renderer/views/personal/ai-client-slash-suggestions.js";
  ```
- [ ] **Step 2: Add parser in parseManagedConversationRequest**
  Add a new `if` branch in `parseManagedConversationRequest()` (after the `fork` branch, around line 680):
  ```ts
  if (input.operation === "command_discovery") {
    exactKeys(
      input,
      ["operation", "aiClientDriverId", "aiClientInstanceId", "projectId", ...(Object.hasOwn(input, "cwd") ? ["cwd"] : [])],
      "Managed Conversation command discovery"
    );
    if (
      typeof input.aiClientDriverId !== "string" ||
      !isSupportedAiClientDriverId(input.aiClientDriverId)
    ) {
      throw new TypeError("Managed Conversation command discovery driver is invalid.");
    }
    return {
      operation: "command_discovery",
      aiClientDriverId: input.aiClientDriverId,
      aiClientInstanceId: identifier(
        input.aiClientInstanceId,
        "AI Client instance id"
      ),
      projectId: identifier(input.projectId, "Project id"),
      ...(Object.hasOwn(input, "cwd")
        ? { cwd: identifier(input.cwd as string, "Working directory") }
        : {})
    };
  }
  ```
- [ ] **Step 3: Add parser in parseManagedConversationResult**
  Add a new `if` branch in `parseManagedConversationResult()` (after the `fork` branch, around line 1230):
  ```ts
  if (input.operation === "command_discovery") {
    const allowedKeys = input.message
      ? ["operation", "status", "commands", "message"]
      : ["operation", "status", "commands"];
    exactKeys(input, allowedKeys, "Managed Conversation command discovery result");
    const status = input.status;
    if (
      status !== "ok" &&
      status !== "unavailable" &&
      status !== "stale" &&
      status !== "unauthorized"
    ) {
      throw new TypeError("Managed Conversation command discovery status is invalid.");
    }
    if (!Array.isArray(input.commands)) {
      throw new TypeError("Managed Conversation command discovery commands must be an array.");
    }
    if (
      status === "ok" &&
      input.commands.length > 128
    ) {
      throw new TypeError("Managed Conversation command discovery returns too many commands.");
    }
    for (const cmd of input.commands) {
      const command = record(cmd, "Managed Conversation slash command");
      exactKeys(
        command,
        ["name", "description", ...(Object.hasOwn(command, "argumentHint") ? ["argumentHint"] : []), "kind", "source"],
        "Managed Conversation slash command"
      );
      if (
        typeof command.name !== "string" ||
        command.name.length === 0 ||
        command.name.length > 64 ||
        command.name.trim() !== command.name
      ) {
        throw new TypeError("Managed Conversation command discovery command name is invalid.");
      }
      if (
        typeof command.description !== "string" ||
        command.description.length > 512
      ) {
        throw new TypeError("Managed Conversation command discovery command description is invalid.");
      }
      if (command.kind !== "command" && command.kind !== "skill") {
        throw new TypeError("Managed Conversation command discovery command kind is invalid.");
      }
      if (command.source !== "provider") {
        throw new TypeError("Managed Conversation command discovery command source is invalid.");
      }
    }
    return {
      operation: "command_discovery",
      status,
      commands: input.commands,
      ...(input.message ? { message: String(input.message).slice(0, 512) } : {})
    };
  }
  ```
- [ ] **Step 4: Commit**
  ```bash
  git add apps/desktop/src/ipc/managed-conversation-protocol.ts
  git commit -m "feat(protocol): add command_discovery request and result parsers"
  ```

---

### Task 4: Add `discoverCommands` to ManagedConversationDesktopApi and preload

**Files:**
- Modify: `apps/desktop/src/ipc/managed-conversation-protocol.ts`
- Modify: `apps/desktop/src/ipc/managed-conversation-preload.ts`

**Interfaces:**
- Consumes: `ManagedConversationCommandDiscoveryRequest`, `parseManagedConversationRequest`, `correlated`
- Produces: `discoverCommands` method on `ManagedConversationDesktopApi` interface and preload implementation

- [ ] **Step 1: Add discoverCommands to ManagedConversationDesktopApi interface**
  In `managed-conversation-protocol.ts`, add to the `ManagedConversationDesktopApi` interface (after the `fork` method, around line 1870):
  ```ts
  discoverCommands: (
    input: Omit<ManagedConversationCommandDiscoveryRequest, "operation">
  ) => Promise<Extract<ManagedConversationResult, { operation: "command_discovery" }>>;
  ```
- [ ] **Step 2: Add discoverCommands to preload API**
  In `managed-conversation-preload.ts`, add the method to `createManagedConversationPreloadApi` (after the `fork` method):
  ```ts
  discoverCommands: async (input) => {
    const request = parseManagedConversationRequest({
      operation: "command_discovery",
      ...input
    }) as Extract<
      ReturnType<typeof parseManagedConversationRequest>,
      { operation: "command_discovery" }
    >;
    const result = correlated(
      "command_discovery",
      await invoke(
        managedConversationCommandChannel,
        request
      )
    );
    if (result.operation !== "command_discovery") {
      throw new Error("Invalid Managed Conversation command discovery correlation.");
    }
    return result;
  }
  ```
- [ ] **Step 3: Commit**
  ```bash
  git add apps/desktop/src/ipc/managed-conversation-protocol.ts apps/desktop/src/ipc/managed-conversation-preload.ts
  git commit -m "feat(preload): add discoverCommands to ManagedConversationDesktopApi"
  ```

---

### Task 5: Add discovery error message to IPC commands handler

**Files:**
- Modify: `apps/desktop/src/ipc/commands.ts`

**Interfaces:**
- Consumes: `ManagedConversationResult["operation"]` record, `parseManagedConversationRequest`
- Produces: Error message for `command_discovery` operation

- [ ] **Step 1: Read current error messages**
  Read lines 379-410 of `commands.ts` to see the `messages` record.
- [ ] **Step 2: Add discovery error message**
  Add `"command_discovery": "Koed could not discover slash commands for the selected AI Client."` to the messages record.
- [ ] **Step 3: Commit**
  ```bash
  git add apps/desktop/src/ipc/commands.ts
  git commit -m "feat(ipc): add command_discovery error message to IPC handler"
  ```

---

### Task 6: Add discovery API route to Koed API

**Files:**
- Modify: `apps/api/src/managed-conversations/routes.ts`

**Interfaces:**
- Consumes: `managedConversationReadRateLimit`, `authenticateManaged()`, `assertAvailable()`, `aiClientCapabilityIds` from shared, `context.requireRepository()`, `runnerIdentity()`
- Produces: `GET /v1/managed-conversations/commands` route that returns `ManagedConversationCommandDiscoveryResult`

- [ ] **Step 1: Read existing launch-options route**
  Read lines 1423-1440 of `routes.ts` to see the `launch-options` route pattern.
- [ ] **Step 2: Add discovery route handler**
  Add a new route handler after the `launch-options` route. The handler should:
  1. Assert available context
  2. Authenticate the managed request
  3. Look up the instance from the repository
  4. Validate the capability snapshot has `slashCommandDiscovery` with `support="supported"` and `readiness="ready"`
  5. Validate the instance in the request matches the authenticated user's instance
  6. Validate `projectId` matches the instance's project binding
  7. If `cwd` is present, validate it's within the instance's working directory
  8. Check a request-scoped cache (Map, TTL 30s, key based on driverId+instanceId+projectId+cwdHash)
  9. If cache hit and valid, return cached result
  10. Otherwise return `{ operation: "command_discovery", status: "ok", commands: [] }` (stubbed — Phase 4 adds adapter dispatch)
  
  The route should use the same `managedConversationReadRateLimit` as `launch-options`.

  ```ts
  app.get(
    "/v1/managed-conversations/commands",
    { preHandler: managedConversationReadRateLimit },
    async (request) => {
      assertAvailable(context);
      const user = await authenticateManaged(request);
      
      // Extract query params
      const driverId = request.query.provider as string;
      const instanceId = request.query.instanceId as string;
      const projectId = request.query.projectId as string;
      const cwd = request.query.cwd as string | undefined;
      
      if (
        !driverId ||
        !isSupportedAiClientDriverId(driverId) ||
        !instanceId ||
        !projectId
      ) {
        return { operation: "command_discovery", status: "unauthorized" as const, commands: [] };
      }
      
      // Look up instance and validate capability
      const [instances, snapshots] = await Promise.all([
        context.requireRepository().listAiClientInstances({ userId: user.id }),
        context.requireRepository().listCurrentAiClientCapabilitySnapshots({ userId: user.id })
      ]);
      
      const snapshot = snapshots.find(
        (s) => s.instanceId === instanceId && s.driverId === driverId
      );
      const instance = instances.find(
        (i) => i.instanceId === instanceId && i.driverId === driverId
      );
      
      if (!instance || !snapshot) {
        return { operation: "command_discovery", status: "unauthorized" as const, commands: [] };
      }
      
      // Validate capability
      const desc = snapshot.capabilities?.descriptors?.find(
        (d: any) => d.id === aiClientCapabilityIds.slashCommandDiscovery
      );
      if (
        !desc ||
        typeof desc !== "object" ||
        (desc as any).support !== "supported" ||
        (desc as any).readiness !== "ready"
      ) {
        return { operation: "command_discovery", status: "unavailable" as const, commands: [] };
      }
      
      // Validate instance matches authenticated user
      if (instance.userId !== user.id) {
        return { operation: "command_discovery", status: "unauthorized" as const, commands: [] };
      }
      
      // Validate projectId matches instance
      if (instance.projectId !== projectId) {
        return { operation: "command_discovery", status: "unauthorized" as const, commands: [] };
      }
      
      // Validate cache
      const cacheKey = `cmd:${driverId}:${instanceId}:${projectId}:${cwd ? createHash("sha256").update(cwd).digest("hex") : "none"}`;
      const cached = discoveryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 30_000) {
        return { operation: "command_discovery", status: "ok" as const, commands: cached.commands };
      }
      
      // TODO: Phase 4 — dispatch to worker adapter here
      // For now, return empty list
      const result = { operation: "command_discovery", status: "ok" as const, commands: [] };
      discoveryCache.set(cacheKey, { ...result, timestamp: Date.now() });
      return result;
    }
  );
  ```
- [ ] **Step 3: Add cache declaration**
  Add at the top of `registerManagedConversationRoutes` (near the rate limit declarations):
  ```ts
  const discoveryCache = new Map<string, { commands: ManagedConversationSlashCommand[]; timestamp: number }>();
  ```
- [ ] **Step 4: Add import for `createHash`**
  Add `import { createHash } from "node:crypto";` at the top of the file.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/managed-conversations/routes.ts
  git commit -m "feat(api): add command_discovery API route with capability validation and caching"
  ```

---

### Task 7: Wire discovery into Koed Server Manager

**Files:**
- Modify: `apps/desktop/src/koed-server/manager.ts`

**Interfaces:**
- Consumes: `parseManagedConversationResult`, `authenticatedPersonalMemoryRequest`, `personalMemoryAccess`
- Produces: `command_discovery` case in `managedConversation` handler

- [ ] **Step 1: Read existing managedConversation handler**
  Read lines 3105-3200 of `manager.ts` to see the pattern for routing operations to the Koed API.
- [ ] **Step 2: Add command_discovery case**
  Add a case in the `managedConversation` handler (after the `start` case, or as a separate early case since it's read-only):
  ```ts
  if (request.operation === "command_discovery") {
    const payload = await authenticatedPersonalMemoryRequest(
      ({ apiOrigin }) => ({
        url: new URL(
          `/v1/managed-conversations/commands?provider=${encodeURIComponent(request.aiClientDriverId)}&instanceId=${encodeURIComponent(request.aiClientInstanceId)}&projectId=${encodeURIComponent(request.projectId)}${request.cwd ? `&cwd=${encodeURIComponent(request.cwd)}` : ""}`,
          apiOrigin
        ),
        init: { method: "GET" }
      }),
      128 * 1_024
    );
    return parseManagedConversationResult({
      operation: "command_discovery",
      ...payload
    });
  }
  ```
- [ ] **Step 3: Commit**
  ```bash
  git add apps/desktop/src/koed-server/manager.ts
  git commit -m "feat(manager): wire command_discovery through Koed API"
  ```

---

### Task 8: Create `useSlashCommandDiscovery` hook

**Files:**
- Create: `apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts`
- Delete: `apps/desktop/src/renderer/views/personal/use-slash-command-autocomplete.ts` (unused)

**Interfaces:**
- Consumes: `ManagedConversationDesktopApi` from preload
- Produces: `{ commands, loading, error, lastFetchedAt }` state object

- [ ] **Step 1: Create the hook file**
  Create `apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts`:
  ```ts
  import { useState, useCallback, useRef, useEffect, useMemo } from "react";
  import type { SupportedAiClientDriverId } from "@koed/shared/ai-client-contract";
  import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

  const FETCH_DEBOUNCE_MS = 500;
  const STALE_IF_ERROR_MS = 30_000;

  export interface UseSlashCommandDiscoveryResult {
    commands: ManagedConversationSlashCommand[];
    loading: boolean;
    error: string | null;
    lastFetchedAt: number | null;
  }

  export function useSlashCommandDiscovery(
    api: { discoverCommands?: (...args: never[]) => unknown } | null,
    driverId: SupportedAiClientDriverId | null,
    instanceId: string | null,
    projectId: string | null,
    cwd: string | null
  ): UseSlashCommandDiscoveryResult {
    const [commands, setCommands] = useState<ManagedConversationSlashCommand[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

    const lastFetchRef = useRef(0);
    const cachedCommandsRef = useRef<ManagedConversationSlashCommand[]>([]);
    const cachedTimestampRef = useRef<number | null>(null);

    const fetchCommands = useCallback(() => {
      if (!api?.discoverCommands || !driverId || !instanceId || !projectId) {
        return;
      }

      // Check stale-if-error
      const now = Date.now();
      if (
        cachedCommandsRef.current.length > 0 &&
        cachedTimestampRef.current !== null &&
        now - cachedTimestampRef.current < STALE_IF_ERROR_MS
      ) {
        return; // Use cached data while re-fetching
      }

      // Debounce
      if (now - lastFetchRef.current < FETCH_DEBOUNCE_MS) {
        return;
      }

      lastFetchRef.current = now;
      setLoading(true);
      setError(null);

      api
        .discoverCommands({
          aiClientDriverId: driverId,
          aiClientInstanceId: instanceId,
          projectId,
          ...(cwd ? { cwd } : {})
        })
        .then((result: any) => {
          if (result.status === "ok") {
            setCommands(result.commands);
            setLastFetchedAt(now);
            cachedCommandsRef.current = result.commands;
            cachedTimestampRef.current = now;
          } else if (result.status === "unavailable") {
            setCommands([]);
            setError(null);
            cachedCommandsRef.current = [];
            cachedTimestampRef.current = now;
          } else {
            setError(
              result.message ??
                (result.status === "stale"
                  ? "AI Client capability snapshot is stale."
                  : "Command discovery unavailable.")
            );
            setCommands([]);
          }
        })
        .catch(() => {
          setError("Command discovery failed.");
          setCommands([]);
        })
        .finally(() => {
          setLoading(false);
        });
    }, [api, driverId, instanceId, projectId, cwd]);

    // Trigger fetch when dependencies change
    useEffect(() => {
      if (driverId && instanceId && projectId) {
        fetchCommands();
      } else {
        setCommands([]);
        setLoading(false);
        setError(null);
        setLastFetchedAt(null);
      }
    }, [driverId, instanceId, projectId, cwd, fetchCommands]);

    // Invalidate cache when dependencies change
    useEffect(() => {
      cachedCommandsRef.current = [];
      cachedTimestampRef.current = null;
    }, [driverId, instanceId, projectId, cwd]);

    return { commands, loading, error, lastFetchedAt };
  }
  ```
- [ ] **Step 2: Delete unused autocomplete hook**
  ```bash
  rm apps/desktop/src/renderer/views/personal/use-slash-command-autocomplete.ts
  ```
- [ ] **Step 3: Commit**
  ```bash
  git add apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts apps/desktop/src/renderer/views/personal/use-slash-command-autocomplete.ts
  git commit -m "feat(ui): add useSlashCommandDiscovery hook, remove unused useSlashCommandAutocomplete"
  ```

---

### Task 9: Wire discovery hook into ConversationInput

**Files:**
- Modify: `apps/desktop/src/renderer/views/personal/ConversationInput.tsx`
- Modify: `apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx`

**Interfaces:**
- Consumes: `useSlashCommandDiscovery` return type (`{ commands, loading, error, lastFetchedAt }`)
- Produces: Updated `ConversationInput` that uses the hook's values for autocomplete props

- [ ] **Step 1: Read current ConversationInput**
  Read the full `ConversationInput.tsx` file to understand the current autocomplete prop usage.
- [ ] **Step 2: Add hook import and usage**
  The hook is consumed by the parent component (the conversation view), not by `ConversationInput` itself. The `ConversationInput` component already accepts `autocompleteOptions`, `autocompleteLoading`, `autocompleteError`, and `onAutocompleteSelect` props. No changes to `ConversationInput` are needed — the parent component wires the hook output to these existing props.

  Instead, update the parent component. Read the file that renders `ConversationInput` (likely in the same directory or nearby) and add the hook there. Search for where `ConversationInput` is used:
  ```bash
  grep -rn "ConversationInput" apps/desktop/src/renderer/views/personal/ --include="*.tsx" | grep -v "test\|ConversationInput.tsx"
  ```
- [ ] **Step 3: Wire in parent component**
  In the parent component, add the hook call:
  ```ts
  import { useSlashCommandDiscovery } from "./use-slash-command-discovery.js";

  // Inside the component:
  const { commands, loading, error } = useSlashCommandDiscovery(
    managedConversationApi, // from the lifecycle or context
    selectedDriverId,
    selectedInstanceId,
    projectId,
    cwd
  );
  ```
  Then pass to `ConversationInput`:
  ```tsx
  <ConversationInput
    ...
    autocompleteOptions={commands}
    autocompleteLoading={loading}
    autocompleteError={error}
  />
  ```
- [ ] **Step 4: Add test**
  In the existing `ConversationInput.test.tsx` file, add a test that verifies:
  - When `autocompleteOptions` is empty and `autocompleteLoading` is true, the popover shows a loading indicator
  - When `autocompleteOptions` is non-empty, matching commands appear in the menu
- [ ] **Step 5: Commit**
  ```bash
  git add apps/desktop/src/renderer/views/personal/ConversationInput.tsx apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx
  git commit -m "feat(ui): wire useSlashCommandDiscovery into ConversationInput via parent component"
  ```

---

### Task 10: Add worker adapter interface and factory

**Files:**
- Create: `apps/worker/src/command-discovery-adapter.ts`
- Modify: `apps/worker/src/managed-conversation-service.ts`

**Interfaces:**
- Produces: `CommandDiscoveryAdapter` interface, `CommandDiscoveryAdapterFactory` type
- Consumes: `SupportedAiClientDriverId` from shared

- [ ] **Step 1: Create adapter interface file**
  Create `apps/worker/src/command-discovery-adapter.ts`:
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

  export type CommandDiscoveryAdapterFactory = (
    driverId: SupportedAiClientDriverId
  ) => CommandDiscoveryAdapter | null;

  export const createCommandDiscoveryAdapter: CommandDiscoveryAdapterFactory = (
    driverId: SupportedAiClientDriverId
  ): CommandDiscoveryAdapter | null => {
    switch (driverId) {
      case "codex":
        return null; // Phase 4: implement codex adapter
      case "claude":
        return null; // Phase 4: implement claude adapter
      case "pi":
        return null; // Phase 4: implement pi adapter
      default:
        return null;
    }
  };
  ```
- [ ] **Step 2: Register discovery route in managed-conversation-service**
  In `managed-conversation-service.ts`, add a handler for `command_discovery` operation. The handler should:
  1. Validate the request matches an authenticated user's instance
  2. Validate capability snapshot has `slashCommandDiscovery` ready
  3. Look up cache
  4. If cache hit, return cached commands
  5. Otherwise, attempt to create and call the adapter
  6. Return `{ status: "ok", commands: [] }` (empty because adapters are stubbed)
  
  Note: The API already has the route from Task 6. The worker service's handler is the backend that the API calls when running locally. Add the handler method to the service class/object.
- [ ] **Step 3: Commit**
  ```bash
  git add apps/worker/src/command-discovery-adapter.ts apps/worker/src/managed-conversation-service.ts
  git commit -m "feat(worker): add command discovery adapter interface and factory (stubbed)"
  ```

---

### Task 11: Add IPC protocol parser tests

**Files:**
- Create: `apps/desktop/src/ipc/managed-conversation-protocol.test.ts` (or add to existing)

**Interfaces:**
- Consumes: `parseManagedConversationRequest`, `parseManagedConversationResult`
- Produces: Tests for discovery request and result parsing

- [ ] **Step 1: Check if protocol tests exist**
  Look for `apps/desktop/src/ipc/managed-conversation-protocol.test.ts` or similar test file.
- [ ] **Step 2: Add discovery parser tests**
  If file exists, add tests. If not, create it with the standard test pattern:
  ```ts
  import { describe, it, expect } from "vitest";
  import {
    parseManagedConversationRequest,
    parseManagedConversationResult,
    type ManagedConversationCommandDiscoveryRequest,
    type ManagedConversationCommandDiscoveryResult
  } from "./managed-conversation-protocol.js";

  describe("parseManagedConversationRequest - command_discovery", () => {
    it("parses valid discovery request", () => {
      const result = parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "my-instance",
        projectId: "my-project"
      });
      expect(result).toEqual({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "my-instance",
        projectId: "my-project"
      });
    });

    it("parses discovery request with cwd", () => {
      const result = parseManagedConversationRequest({
        operation: "command_discovery",
        aiClientDriverId: "codex",
        aiClientInstanceId: "my-instance",
        projectId: "my-project",
        cwd: "/home/user/project"
      });
      expect(result.cwd).toBe("/home/user/project");
    });

    it("rejects invalid driverId", () => {
      expect(() =>
        parseManagedConversationRequest({
          operation: "command_discovery",
          aiClientDriverId: "invalid",
          aiClientInstanceId: "my-instance",
          projectId: "my-project"
        })
      ).toThrow(/driver is invalid/);
    });

    it("rejects missing projectId", () => {
      expect(() =>
        parseManagedConversationRequest({
          operation: "command_discovery",
          aiClientDriverId: "codex",
          aiClientInstanceId: "my-instance"
        })
      ).toThrow(/unexpected fields|invalid/);
    });
  });

  describe("parseManagedConversationResult - command_discovery", () => {
    it("parses ok result", () => {
      const result = parseManagedConversationResult({
        operation: "command_discovery",
        status: "ok",
        commands: [
          { name: "skill", description: "A skill", kind: "skill", source: "provider" }
        ]
      });
      expect(result).toEqual({
        operation: "command_discovery",
        status: "ok",
        commands: [{ name: "skill", description: "A skill", kind: "skill", source: "provider" }]
      });
    });

    it("parses unavailable result", () => {
      const result = parseManagedConversationResult({
        operation: "command_discovery",
        status: "unavailable",
        commands: []
      });
      expect(result.status).toBe("unavailable");
    });

    it("parses unauthorized result with message", () => {
      const result = parseManagedConversationResult({
        operation: "command_discovery",
        status: "unauthorized",
        commands: [],
        message: "Instance not found"
      });
      expect(result.status).toBe("unauthorized");
      expect(result.message).toBe("Instance not found");
    });

    it("rejects invalid status", () => {
      expect(() =>
        parseManagedConversationResult({
          operation: "command_discovery",
          status: "invalid",
          commands: []
        })
      ).toThrow(/status is invalid/);
    });

    it("rejects command with missing name", () => {
      expect(() =>
        parseManagedConversationResult({
          operation: "command_discovery",
          status: "ok",
          commands: [{ description: "no name", kind: "command", source: "provider" }]
        })
      ).toThrow(/name is invalid/);
    });

    it("rejects command with invalid kind", () => {
      expect(() =>
        parseManagedConversationResult({
          operation: "command_discovery",
          status: "ok",
          commands: [{ name: "x", description: "y", kind: "unknown", source: "provider" }]
        })
      ).toThrow(/kind is invalid/);
    });

    it("rejects more than 128 commands", () => {
      const tooMany = Array.from({ length: 129 }, () => ({
        name: "cmd",
        description: "desc",
        kind: "command",
        source: "provider"
      }));
      expect(() =>
        parseManagedConversationResult({
          operation: "command_discovery",
          status: "ok",
          commands: tooMany
        })
      ).toThrow(/too many commands/);
    });
  });
  ```
- [ ] **Step 3: Run tests**
  ```bash
  pnpm vitest run apps/desktop/src/ipc/managed-conversation-protocol.test.ts
  ```
  Expected: All tests pass.
- [ ] **Step 4: Commit**
  ```bash
  git add apps/desktop/src/ipc/managed-conversation-protocol.test.ts
  git commit -m "test(protocol): add parser tests for command_discovery"
  ```

---

### Task 12: Add preload API tests

**Files:**
- Modify: `apps/desktop/src/ipc/managed-conversation-preload.test.ts`

**Interfaces:**
- Consumes: `createManagedConversationPreloadApi`
- Produces: Tests for `discoverCommands` preload method

- [ ] **Step 1: Read existing preload tests**
  Read `apps/desktop/src/ipc/managed-conversation-preload.test.ts` to see the test pattern.
- [ ] **Step 2: Add discoverCommands test**
  ```ts
  it("calls discoverCommands via IPC and returns parsed result", async () => {
    const invoke = vi.fn().mockResolvedValue({
      operation: "command_discovery",
      status: "ok",
      commands: [{ name: "test", description: "Test", kind: "command", source: "provider" }]
    });
    const api = createManagedConversationPreloadApi(invoke);
    const result = await api.discoverCommands({
      aiClientDriverId: "codex",
      aiClientInstanceId: "my-instance",
      projectId: "my-project"
    });
    expect(invoke).toHaveBeenCalledWith(
      "koed:managed-conversation:command",
      expect.objectContaining({ operation: "command_discovery" })
    );
    expect(result.operation).toBe("command_discovery");
    expect(result.status).toBe("ok");
  });
  ```
- [ ] **Step 3: Run tests**
  ```bash
  pnpm vitest run apps/desktop/src/ipc/managed-conversation-preload.test.ts
  ```
- [ ] **Step 4: Commit**
  ```bash
  git add apps/desktop/src/ipc/managed-conversation-preload.test.ts
  git commit -m "test(preload): add discoverCommands test"
  ```

---

### Task 13: Add autocomplete integration tests

**Files:**
- Modify: `apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx`

**Interfaces:**
- Consumes: `ConversationInput` component, its autocomplete props
- Produces: Tests for loading/error states in autocomplete popover

- [ ] **Step 1: Read existing ConversationInput tests**
  Read `apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx` to see the test pattern.
- [ ] **Step 2: Add loading state test**
  ```ts
  it("shows loading indicator when autocompleteLoading is true", async () => {
    const { container } = render(
      <ConversationInput
        action={{ kind: "send", label: "Send", disabled: false }}
        placeholder="Type a message"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        settings={{
          models: [],
          selectedModel: null,
          reasoningEfforts: [],
          selectedReasoningEffort: null,
          permissionModes: [],
          selectedPermissionMode: null
        }}
        autocompleteOptions={[]}
        autocompleteLoading={true}
      />
    );
    // The popover renders a loading indicator
    expect(container.textContent).toContain("Loading commands");
  });
  ```
- [ ] **Step 3: Add error state test**
  ```ts
  it("shows error message when autocompleteError is set", async () => {
    const { container } = render(
      <ConversationInput
        action={{ kind: "send", label: "Send", disabled: false }}
        placeholder="Type a message"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        settings={{
          models: [],
          selectedModel: null,
          reasoningEfforts: [],
          selectedReasoningEffort: null,
          permissionModes: [],
          selectedPermissionMode: null
        }}
        autocompleteOptions={[]}
        autocompleteError="Discovery unavailable"
      />
    );
    expect(container.textContent).toContain("Discovery unavailable");
  });
  ```
- [ ] **Step 4: Run tests**
  ```bash
  pnpm vitest run apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx
  ```
- [ ] **Step 5: Commit**
  ```bash
  git add apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx
  git commit -m "test(ui): add loading and error state tests for autocomplete"
  ```

---

### Task 14: Run full test suite and verify

**Files:**
- No file changes

- [ ] **Step 1: Run existing slash suggestions tests**
  ```bash
  pnpm vitest run apps/desktop/src/renderer/views/personal/ai-client-slash-suggestions.test.ts
  ```
  Expected: 33 tests pass (unchanged from Phases 1-2).
- [ ] **Step 2: Run ConversationInput tests**
  ```bash
  pnpm vitest run apps/desktop/src/renderer/views/personal/ConversationInput.test.tsx
  ```
  Expected: All tests pass (original + new loading/error tests).
- [ ] **Step 3: Run protocol tests**
  ```bash
  pnpm vitest run apps/desktop/src/ipc/managed-conversation-protocol.test.ts
  ```
  Expected: All new discovery parser tests pass.
- [ ] **Step 4: Run preload tests**
  ```bash
  pnpm vitest run apps/desktop/src/ipc/managed-conversation-preload.test.ts
  ```
  Expected: All tests pass (original + new discoverCommands test).
- [ ] **Step 5: Commit**
  ```bash
  git add -A
  git commit -m "test: run full test suite for command discovery integration"
  ```

---

## Execution Handoff

Plan complete. When tasks are ready:

1. Submit each task as a subagent job using the `worker` profile
2. After each task completion, submit the diff to a `reviewer` profile agent
3. Only proceed to the next task after review passes
4. After all tasks complete, do a whole-branch review

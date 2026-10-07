# ACP Cross-Agent Command Discovery

**Status:** Scoping / draft plan
**Branch:** `feat/ai-client-aware-slash-suggestions`
**Created:** 2025-08-20

## Problem

Koed manages three AI clients (Codex, Claude Code, Pi), each with a different
command discovery mechanism:

| Client | Current method                                                        | Limitation                                                |
| ------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Codex  | `skills/list` App Server request + file scan of `$CODEX_HOME/prompts` | Skips built-in `/compact`; requires App Server round-trip |
| Claude | File scan of `$CLAUDE_CONFIG_DIR/commands` and `skills`               | No SDK-level command listing                              |
| Pi     | Native `get_commands` RPC (just implemented)                          | Tied to `--mode rpc`; not portable across transports      |

Each adapter is bespoke. Adding a new client requires writing a new adapter from
scratch. There is no shared interface for command discovery across transports
(file scan, RPC, HTTP, SDK).

## ACP Concept

**Agent Communication Protocol (ACP)** is a thin abstraction layer that normalizes
command discovery into a single interface:

```typescript
interface AgentCommandCatalog {
  provider: string; // "codex" | "claude" | "pi" | ...
  instanceId: string;
  scope: "global" | "project";
  commands: AgentCommand[];
  capabilities: string[]; // ["slash_suggestions", "control_actions"]
}

interface AgentCommand {
  name: string; // invocation name, no leading "/"
  description: string;
  kind: "command" | "skill";
  argumentHint?: string;
  scope: "global" | "project";
  source: "provider" | "builtin" | "global-file" | "project-file";
  verification: "verified" | "unverified";
  invocationType: "prompt" | "control_action";
  actionId?: string; // when invocationType is "control_action"
}
```

ACP itself does not dictate how each provider supplies its catalog. Instead, ACP
defines:

1. **A unified result type** — all providers return `AgentCommandCatalog`.
2. **A transport-agnostic discovery interface** — `AgentCommandDiscovery.list()`
   accepts an `AgentContext` (instance, scope, cwd) and returns a catalog.
3. **A control-action dispatch interface** — `AgentCommandDispatch.execute()`
   routes control actions to the correct provider operation.

## ACP Interface Design

```typescript
interface AgentCommandDiscovery {
  list(context: AgentContext): Promise<AgentCommandCatalog>;
}

interface AgentCommandDispatch {
  execute(action: ControlAction): Promise<ControlActionResult>;
}

interface AgentContext {
  provider: string;
  instanceId: string;
  scope: "global" | "project";
  projectRoot?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  sessionId?: string; // for live-session discovery
}

interface ControlAction {
  actionId: string;
  arguments: string[];
  executionGeneration: number;
  operationId: string;
}

interface ControlActionResult {
  status: "accepted" | "already_accepted" | "unknown" | "rejected";
  reason?: string;
  executionGeneration?: number;
}
```

## Provider Implementation

Each provider implements the two interfaces. The ACP adapter hides provider
differences from Koed's core.

### Codex ACP Adapter

- **Discovery:** Spawn a temporary Codex RPC session (`--no-session`) → call
  `skills/list` equivalent → merge with `$CODEX_HOME/prompts` scan. For live
  sessions, query the App Server directly.
- **Control Actions:** Map `codex.compact` → App Server `thread/compact/start`.

### Claude ACP Adapter

- **Discovery:** If Claude Agent SDK provides `supportedCommands()`, use it.
  Fall back to file scan of `$CLAUDE_CONFIG_DIR/commands` and `skills`.
- **Control Actions:** None currently supported (Claude Code has no Koed-owned
  control actions).

### Pi ACP Adapter

- **Discovery:** Already implements native `get_commands` RPC. Wrap it in the
  `AgentCommandDiscovery.list()` interface. This is the implementation just
  committed.
- **Control Actions:** None currently supported.

### File-Based Fallback Adapter

- **Discovery:** Current `createCommandDiscoveryAdapter()` logic. Used only when
  no provider session is available and no ACP adapter is installed.
- **Control Actions:** None.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Koed Core                            │
│                                                             │
│  useSlashCommandDiscovery  ──→  ACP CommandDiscovery.list()  │
│  ConversationInput            ──→  ACP CommandDispatch.exec()│
│  managed-conversation-       ──→  ACP CommandDiscovery.list()│
│    routes.ts                 ──→  ACP CommandDispatch.exec() │
└──────────────┬──────────────────────────────────────────────┘
               │
    ┌──────────▼──────────┐
    │  AgentCommandDiscovery  │
    │  (ACP Interface)        │
    │                         │
    │  ┌─────────────────────┼──────────────────┐
    │  │                     │                  │
    │  ▼                     ▼                  ▼
    │ CodexAdapter       ClaudeAdapter        PiAdapter
    │                     │                  │
    │ skills/list +     file scan           get_commands
    │ file scan         (optional)          (native RPC)
    └─────────────────────┴──────────────────┘
```

## Implementation Phases

### Phase 1: Interface and Pi adapter (current)

- [x] Define `AgentCommandCatalog` and `AgentCommandDiscovery` interfaces
- [x] Implement Pi ACP adapter (native `get_commands` RPC)
- [x] Wire Pi into API routes for draft discovery
- [ ] Export ACP types from `@koed/shared`

### Phase 2: Codex ACP adapter

- [ ] Implement Codex ACP adapter with temporary session discovery
- [ ] Add `/compact` control action dispatch via App Server
- [ ] Wire Codex into ACP interface

### Phase 3: Claude ACP adapter

- [ ] Implement Claude ACP adapter with SDK fallback
- [ ] Wire Claude into ACP interface

### Phase 4: Unification

- [ ] Remove bespoke adapter code from API routes
- [ ] Route all command discovery through ACP interface
- [ ] Add control-action dispatch through ACP
- [ ] Update IPC protocol to use ACP types

### Phase 5: Hardening

- [ ] Add comprehensive provider tests
- [ ] Add integration tests for each provider
- [ ] Add cache invalidation logic
- [ ] Add ACP plugin system for third-party adapters

## Trade-offs

### vs current approach

| Aspect           | Current               | ACP                        |
| ---------------- | --------------------- | -------------------------- |
| New client cost  | Write bespoke adapter | Implement 2 interfaces     |
| Discovery source | Per-provider logic    | Unified `list()` call      |
| Control actions  | Ad-hoc in routes      | Centralized dispatch table |
| Transport        | Mixed (file/RPC/HTTP) | Abstracted by ACP          |
| Complexity       | Scattered             | Focused in adapter layer   |
| Risk             | Low (existing works)  | Medium (new abstraction)   |

### Why ACP over other approaches

1. **SDK integration is not viable** — Codex's App Server API is private. Claude's
   Agent SDK is not stable. Pi's SDK is TypeScript-only and tightly coupled to
   its process model.
2. **Pure file scanning is insufficient** — misses built-in commands, cannot
   reflect live session state.
3. **Provider-specific RPC is fragile** — each provider's protocol changes
   independently. ACP shields Koed from downstream changes.

### Migration path

The ACP interface is additive. No existing code needs to change in Phase 1.
The Pi adapter replaces the existing file-based adapter incrementally. Code is
retired by phase, not all at once.

## Open Questions

1. **Should ACP also cover model catalog discovery?** Currently Koed uses
   `get_available_models` for Pi and `launch-options` for the others. A unified
   model catalog interface would be useful but is out of scope for this plan.

2. **Should ACP use MCP as the transport?** MCP's `/tools/list` is a natural
   match for command discovery. However, MCP requires a running server process,
   which adds latency. ACP could optionally use MCP when available, falling
   back to native transport otherwise.

3. **What about extension/plugin commands?** Pi's `get_commands` already returns
   extension commands. Should ACP also support dynamic extension loading for
   command discovery? This has security implications and should be gated behind
   an explicit policy.

4. **How does ACP handle session-scoped commands?** Some commands are only valid
   within a specific session or conversation context. Should ACP support
   per-session command metadata?

## Files to modify

| File                                                                      | Phase | Change                           |
| ------------------------------------------------------------------------- | ----- | -------------------------------- |
| `packages/shared/src/ai-client-contract.ts`                               | 1     | Add ACP types                    |
| `packages/mcp-server/src/agent-command-discovery.ts`                      | 1,2,3 | ACP interface + adapters         |
| `apps/worker/src/command-discovery-adapter-pi.ts`                         | 1     | Already implemented, wrap in ACP |
| `apps/worker/src/command-discovery-adapter-codex.ts`                      | 2     | New Codex ACP adapter            |
| `apps/worker/src/command-discovery-adapter-claude.ts`                     | 3     | New Claude ACP adapter           |
| `apps/api/src/managed-conversations/routes.ts`                            | 4     | Route through ACP                |
| `apps/desktop/src/renderer/views/personal/use-slash-command-discovery.ts` | 4     | Use ACP types                    |
| `apps/desktop/src/ipc/managed-conversation-protocol.ts`                   | 4     | Use ACP result types             |

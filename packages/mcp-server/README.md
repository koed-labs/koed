# Koed MCP Server

The MCP server is Koed Self-Hosted's local Codex integration. It gives Codex
tools for memory recall, starts local background workers for answer synthesis
and LCM summaries, and provides the capture hook binary used by Codex lifecycle
hooks.

The backend stores memory, graph data, questions, and retrieval evidence. This
package runs on the user's machine and uses Codex app-server mode for local
synthesis.

## Binaries

Build the package before using the binaries:

```bash
pnpm --filter @koed/mcp-server build
```

After build, the package exposes:

- `koed-mcp`: stdio MCP server for Codex.
- `koed-memory-answer-bridge`: standalone local HTTP bridge for History Browser
  questions. Normal MCP startup runs its own bridge.
- `koed-capture-hook`: Codex lifecycle hook for automatic capture.

For direct checkout usage, run the built files from `dist/`:

```bash
node packages/mcp-server/dist/cli.js
node packages/mcp-server/dist/answer-bridge.js
node packages/mcp-server/dist/capture-hook.js
```

## MCP Setup

Configure Codex with a custom stdio MCP server:

```text
Name: koed-selfhost
Command: node
Argument: /path/to/koed-self-hosted/packages/mcp-server/dist/cli.js
Working directory: /path/to/koed-self-hosted
Environment:
  MEMORY_API_URL=http://localhost:3000
  MEMORY_API_TOKEN=<koed-api-token>
  MEMORY_CODEX_APP_SERVER_BINARY=codex
  MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000
```

Run a quick health check from the package:

```bash
MEMORY_API_URL=http://localhost:3000 \
MEMORY_API_TOKEN=<koed-api-token> \
node packages/mcp-server/dist/cli.js doctor
```

## Tools

The MCP server exposes one normal recall tool by default:

- `memory_answer`: retrieves memory evidence and asks local Codex to synthesize
  a compact answer. It is intended for recall from prior conversations,
  remembered preferences, user-provided facts, project history, decisions, and
  cross-session context. It defaults to project search, uses session search only
  for a known captured conversation, and uses global search only for broad
  cross-project or personal-history recall.

Use the `doctor` command above for setup and health checks without expanding the
normal agent-facing MCP schema.

Diagnostic and low-level tools are hidden by default. Set this to expose the MCP
diagnostic access check tool:

```bash
MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS=true
```

Set this to expose low-level search and expand tools:

```bash
MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS=true
```

Those diagnostic tools are intended for development and operator inspection.
Normal agents should use `memory_answer` so the local memory-answer worker owns
retrieval planning and expansion.

## Codex App-Server Binary

The local answer and LCM summary workers start Codex app-server mode when they
need synthesis. By default Koed calls `codex`, so the process that starts
`koed-mcp` must have the Codex binary on `PATH`.

Alternatively, point Koed at the binary explicitly:

```bash
MEMORY_CODEX_APP_SERVER_BINARY=/absolute/path/to/codex
```

## History Browser Answer Bridge

When `koed-mcp` starts, it also starts a local HTTP bridge on
`http://localhost:3210` by default. The History Browser uses this bridge for
Questions; users do not need to run a separate app-server or answer bridge
process for normal operation:

1. The browser creates a pending question in the backend.
2. The bridge claims the question.
3. The backend retrieves evidence through local embeddings.
4. The bridge asks Codex app-server mode to synthesize the answer locally.
5. The backend stores the answer and diagnostics.

Useful bridge settings:

```bash
MEMORY_ANSWER_BRIDGE_ENABLED=true
MEMORY_ANSWER_BRIDGE_HOST=0.0.0.0
MEMORY_ANSWER_BRIDGE_PORT=3210
MEMORY_ANSWER_BRIDGE_CORS_ORIGINS=http://localhost:5174,http://127.0.0.1:5174
MEMORY_QUESTION_ANSWER_MAX_ATTEMPTS=3
```

Check the bridge:

```bash
curl http://127.0.0.1:3210/health
lsof -nP -iTCP:3210 -sTCP:LISTEN
```

If questions remain pending with `localMemoryWorker.skippedReason=codex_failed`,
first check that the process owning port `3210` can resolve `codex` or that
`MEMORY_CODEX_APP_SERVER_BINARY` points at the correct binary. Prefer the
MCP-owned bridge; avoid running a second standalone bridge on the same port.

## Capture Hook

The capture hook reads Codex lifecycle payloads from stdin and writes personal
memory events to the Koed API.

Use the built hook path in Codex hook configuration:

```text
/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js
```

Recommended hook events:

```text
SessionStart
UserPromptSubmit
PostToolUse
Stop
SubagentStart
SubagentStop
```

Common hook settings:

```bash
MEMORY_HOOK_STRICT=false
MEMORY_HOOK_TRIGGER_LCM_SUMMARY=true
MEMORY_HOOK_LCM_SUMMARY_DELAY_MS=10000
MEMORY_HOOK_LCM_SUMMARY_LIMIT=2
```

Verify capture from the repo root:

```bash
MEMORY_API_URL=http://localhost:3000 \
MEMORY_API_TOKEN=<koed-api-token> \
pnpm codex:verify-capture
```

## Local Commands

From the repo root:

```bash
pnpm --filter @koed/mcp-server build
pnpm --filter @koed/mcp-server test
pnpm --filter @koed/mcp-server typecheck
```

Run one LCM summary pass:

```bash
MEMORY_API_URL=http://localhost:3000 \
MEMORY_API_TOKEN=<koed-api-token> \
node packages/mcp-server/dist/cli.js lcm-summarize --limit 2
```

## Key Files

- `src/cli.ts`: stdio MCP server, command parsing, MCP tool registration.
- `src/index.ts`: API client, config defaults, access diagnostics.
- `src/answer-worker.ts`: local Codex answer planner and synthesis runner.
- `src/answer-bridge.ts`: local HTTP bridge for browser questions.
- `src/answer-bridge-lifecycle.ts`: bridge startup/retry behavior from MCP.
- `src/capture-hook.ts`: Codex lifecycle capture hook.
- `src/lcm-summary-worker.ts`: local Codex summarization for pending LCM nodes.
- `src/lcm-summary-service.ts`: background summary service lifecycle.

## Troubleshooting

- `doctor` fails: check `MEMORY_API_URL`, `MEMORY_API_TOKEN`, and backend health.
- Browser question says `Failed to fetch`: check the bridge health endpoint and
  CORS origins.
- Question stays pending with `codex_failed`: check `which codex` in the same
  environment that started the MCP server, or set
  `MEMORY_CODEX_APP_SERVER_BINARY`.
- Backend returns evidence but no final answer: the backend is working; local
  Codex synthesis is failing or unavailable.

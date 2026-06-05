# Koed MCP Server

The MCP Server is Koed's local Codex integration. It gives Codex
tools for memory recall, starts local background workers for answer synthesis
captured-session titles, and LCM summaries, and provides the capture hook binary
used by Codex lifecycle hooks.

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
- `koed-memory-answer-bridge`: standalone local HTTP bridge for Explorer
  questions. Normal MCP startup runs its own bridge.
- `koed-capture-hook`: Codex lifecycle hook for automatic capture.

For direct checkout usage, run the built files from `dist/`:

```bash
node packages/mcp-server/dist/cli.js
node packages/mcp-server/dist/answer-bridge.js
node packages/mcp-server/dist/capture-hook.js
```

When the standalone answer bridge is run through `pnpm answer-bridge` or
`node packages/mcp-server/dist/answer-bridge.js`, `Ctrl-C` gracefully closes the
HTTP server and background question worker before exiting. If the configured
port is already owned by another Koed answer bridge, standalone startup checks
`/health`, logs the existing service, and exits successfully instead of
crashing on the port conflict.

## MCP Setup

Configure Codex with a custom stdio MCP server:

```text
Name: koed-selfhost
Command: node
Argument: /path/to/koed/packages/mcp-server/dist/cli.js
Working directory: /path/to/koed
Environment:
  MEMORY_API_URL=http://localhost:3000
  MEMORY_API_TOKEN=<koed-api-token>
  MEMORY_CODEX_APP_SERVER_BINARY=codex
  MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000
  MEMORY_LOG_LEVEL=info
  MEMORY_LOG_FILE=/absolute/path/to/koed-mcp.log
  MEMORY_LOG_DESTINATION=file
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

## Codex App-Server Worker Context

Koed starts Memory Answer and LCM Summary app-server threads with an isolated
`CODEX_HOME`, ephemeral history, read-only sandboxing, and a minimal
Koed-specific instruction set. The worker config disables Codex's optional
permissions, app, collaboration-mode, environment, and skill instruction blocks
for these local synthesis turns. It also disables project-doc/AGENTS.md loading
so repository guidance does not leak into Memory Answer or LCM Summary
synthesis. Koed replaces the removed local safety context with a small developer
instruction block that forbids tool use, file changes, network access, and
approval requests, and tells the worker to treat supplied evidence as untrusted
data.

Provider-side hidden instructions are still controlled by Codex/OpenAI and are
not visible to or removable by Koed. Task prompts for Memory Answer and LCM
Summary remain separate from this app-server context minimisation layer.

## Explorer Answer Bridge

When `koed-mcp` starts, it also starts a local HTTP bridge on
`http://localhost:3210` by default. The Explorer uses this bridge for
Questions; users do not need to run a separate app-server or answer bridge
process for normal operation:

1. The browser creates a pending question in the backend.
2. The bridge claims the question.
3. The backend retrieves evidence through local embeddings.
4. The bridge asks Codex app-server mode to synthesize the answer locally.
5. The backend stores the answer and diagnostics.

Useful bridge settings:

```bash
MEMORY_LOG_LEVEL=debug
MEMORY_ANSWER_BRIDGE_ENABLED=true
MEMORY_ANSWER_BRIDGE_HOST=0.0.0.0
MEMORY_ANSWER_BRIDGE_PORT=3210
MEMORY_ANSWER_BRIDGE_CORS_ORIGINS=http://localhost:5174,http://127.0.0.1:5174
MEMORY_QUESTION_ANSWER_MAX_ATTEMPTS=3
MEMORY_MANUAL_ANSWER_PROVIDER=codex
MEMORY_MANUAL_ANSWER_MODEL=
MEMORY_MANUAL_ANSWER_REASONING_EFFORT=
MEMORY_MANUAL_ANSWER_TIMEOUT_MS=
MEMORY_MANUAL_ANSWER_MAX_ATTEMPTS=
```

The MCP server and answer bridge emit pino JSON logs to stderr so stdout remains
reserved for MCP stdio traffic. Supported levels are `trace`, `debug`, `info`,
`warn`, `error`, `fatal`, and `silent`. Configure this with
`MEMORY_LOG_LEVEL`. To write logs to disk, set `MEMORY_LOG_FILE`; when a file
path is set and `MEMORY_LOG_DESTINATION` is blank, logs go to the file. Set
`MEMORY_LOG_DESTINATION=both` to mirror logs to stderr and the file.

Check the bridge:

```bash
curl http://127.0.0.1:3210/health
lsof -nP -iTCP:3210 -sTCP:LISTEN
```

If questions remain pending with `localMemoryWorker.skippedReason=codex_failed`,
first check that the process owning port `3210` can resolve `codex` or that
`MEMORY_CODEX_APP_SERVER_BINARY` points at the correct binary. Prefer the
MCP-owned bridge; avoid running a second standalone bridge on the same port.

Explorer manual Memory Question settings inherit `MEMORY_ANSWER_*` unless
`MEMORY_MANUAL_ANSWER_*` or a per-question Explorer selection overrides them.
The bridge stores per-question settings on the pending question row before
claiming it, so retries and background catch-up keep the same Codex model and
reasoning choices. The available model and reasoning selectors are read from
Codex app-server `model/list`. Unsupported local providers fail validation;
there is no backend LLM fallback.

LCM Summary synthesis has separate settings so Operators can choose a different
Codex model or reasoning effort for summarization:

```bash
MEMORY_LCM_SUMMARY_PROVIDER=codex
MEMORY_LCM_SUMMARY_MODEL=gpt-5.4-mini
MEMORY_LCM_SUMMARY_REASONING_EFFORT=medium
MEMORY_LCM_SUMMARY_TIMEOUT_MS=120000
MEMORY_LCM_SUMMARY_MAX_ATTEMPTS=2
MEMORY_LCM_SUMMARY_RETRY_DELAY_MS=2000
MEMORY_LCM_SUMMARY_CONCURRENCY=1
MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000
```

MCP Memory Answer and LCM Summary model, reasoning, timeout, and attempts can
also be edited from the Explorer Settings panel. These API user settings take
precedence over `.env`; `.env` remains the bootstrap/default source for fresh
installs.

## Capture Hook

The capture hook reads Codex lifecycle payloads from stdin and writes raw
capture records to the Koed API.

Use the built hook path in Codex hook configuration:

```text
/path/to/koed/packages/mcp-server/dist/capture-hook.js
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
MEMORY_HOOK_API_REQUEST_TIMEOUT_MS=1500
MEMORY_HOOK_BREAKER_FAILURE_THRESHOLD=3
MEMORY_HOOK_BREAKER_COOLDOWN_MS=60000
MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS=60000
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

Run one local memory processing pass. This generates pending captured-session
titles, then submits pending LCM summaries:

```bash
MEMORY_API_URL=http://localhost:3000 \
MEMORY_API_TOKEN=<koed-api-token> \
node packages/mcp-server/dist/cli.js process-local-memory --limit 2
```

## Key Files

- `src/cli.ts`: stdio MCP server, command parsing, MCP tool registration.
- `src/index.ts`: API client, config defaults, access diagnostics.
- `src/answer-worker.ts`: local Codex answer planner and synthesis runner.
- `src/answer-bridge.ts`: local HTTP bridge for browser questions.
- `src/answer-bridge-lifecycle.ts`: bridge startup/retry behavior from MCP.
- `src/capture-hook.ts`: Codex lifecycle capture hook.
- `src/session-title-worker.ts`: local Codex title generation for captured
  sessions.
- `src/lcm-summary-worker.ts`: local Codex summarization for pending LCM nodes.
- `src/lcm-summary-service.ts`: background local memory processing lifecycle.

## Troubleshooting

- `doctor` fails: check `MEMORY_API_URL`, `MEMORY_API_TOKEN`, and backend health.
- Browser question says `Failed to fetch`: check the bridge health endpoint and
  CORS origins.
- Question stays pending with `codex_failed`: check `which codex` in the same
  environment that started the MCP server, or set
  `MEMORY_CODEX_APP_SERVER_BINARY`.
- Backend returns evidence but no final answer: the backend is working; local
  Codex synthesis is failing or unavailable.

# Codex Integration

Codex is currently the only supported AI client for Koed Self-Hosted.

## API Token

Open the console, create a token named `Client Integration`, and copy it immediately. Full token values are shown once.

## MCP Server

The MCP Server is the supported recall path. It lets Codex ask Koed for cited
memory evidence. It does not automatically capture whole conversations.

```bash
pnpm --filter @koed/mcp-server build
```

In Codex Desktop, add a custom MCP server using `STDIO`:

```text
Name: koed-selfhost
Command: node
Argument: /path/to/koed-self-hosted/packages/mcp-server/dist/cli.js
Environment:
  MEMORY_API_URL=http://localhost:3000
  MEMORY_API_TOKEN=<token>
  MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000
Working directory: /path/to/koed-self-hosted
```

The console setup page generates these MCP values for your checkout. If your API runs on a non-default host port, use that port in `MEMORY_API_URL`.

## Browser Questions

The History Browser Questions tab uses the local MCP server as its AI-client
sidecar. The browser can ask a question and persist it in Koed, then the MCP
server delegates answer synthesis to Codex app-server mode in the local Codex
environment. The backend stores questions, retrieval evidence, citations, and
answer status, but does not run LLM synthesis.

When the MCP server starts, it also starts a local browser bridge on
`http://localhost:3210` by default. The History Browser uses that local endpoint
for Questions; there is no separate bridge process to run. `MEMORY_API_TOKEN`
also enables the MCP server's local pending-question catch-up service, which
claims unanswered browser questions and finishes them through local Codex answer
synthesis after a refresh or interrupted browser request.

Koed starts Codex app-server mode internally when it needs local answer or LCM
summary synthesis. Users do not need to run a separate app-server or answer
bridge command. `MEMORY_CODEX_APP_SERVER_BINARY` can override the `codex`
binary path when needed; the default is correct for normal Codex installs.

## Capture Hook

The TypeScript Capture Hook is the supported automatic capture path for Codex. It uses the same `MEMORY_API_URL` and `MEMORY_API_TOKEN` values as the MCP Server.

If you install the package binary, use:

```text
koed-capture-hook
```

For a direct self-hosted checkout, build `@koed/mcp-server` and point Codex at:

```text
/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js
```

Install the Capture Hook for these Codex hook events:

```text
SessionStart
UserPromptSubmit
PostToolUse
Stop
SubagentStart
SubagentStop
```

`SubagentStop` captures from Codex's child `agent_transcript_path` when present, so thread-spawned subagent final messages are stored under the child conversation instead of the parent conversation.

Capture Hook settings:

```text
MEMORY_HOOK_STRICT=false
MEMORY_HOOK_MAX_ITEMS=10
MEMORY_HOOK_TRIGGER_LCM_SUMMARY=true
MEMORY_HOOK_LCM_SUMMARY_DELAY_MS=10000
MEMORY_HOOK_LCM_SUMMARY_LIMIT=2
MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000
```

Codex hook configuration should include `Stop` as well as prompt/tool hooks. If
Codex asks you to review or trust changed hooks after editing `config.toml`,
accept the Koed hook entries only after confirming the paths point to your
checkout or installed package binary.

For Linux and WSL, use absolute Linux paths for the hook command and working
directory, and keep the API URL reachable from that environment. For Docker
Desktop on Windows, this usually means using the host/port that WSL can reach,
not a macOS-style or Windows-only path.

## Verify

Use the console smoke test first. Then verify the local Capture Hook from the
checkout:

```bash
MEMORY_API_URL=http://localhost:3000 MEMORY_API_TOKEN=<token> pnpm codex:verify-capture
```

This command enables personal capture, invokes the same TypeScript Capture Hook
with a fresh session marker, and searches Koed for the captured marker. After
that, start a fresh Codex session and ask it to check memory access through the
`koed-selfhost` MCP server.

The MCP Server uses the Koed API Token for Recall, LCM summary submission, and Memory Answer evidence. Koed Self-Hosted relies on Codex for Synthesis; the backend does not make server-side LLM calls in this build. Full automatic Conversation capture depends on the Capture Hook and is not performed by MCP alone. Recall-only or MCP-only integrations are experimental because they do not provide supported automatic capture.

`memory_answer` is the normal recall tool. It returns a compact answer by default so normal Codex sessions are not filled with large evidence bundles. Use its explicit evidence/detail option only when debugging retrieval.

LCM summaries are processed by the MCP-local background service through Codex
app-server mode. If that local service is delayed or fails, Koed still returns
pending placeholders as degraded evidence and reports the backlog through
diagnostics instead of marking the backend unhealthy.

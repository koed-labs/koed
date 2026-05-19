# Codex Integration

Codex is currently the only supported AI client for Koed Self-Hosted.

## API Token

Open the console, create a token named `Client Integration`, and copy it immediately. Full token values are shown once.

## MCP Server

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
Working directory: /path/to/koed-self-hosted
```

The console `AI Clients` tab generates these values for your checkout. If your API runs on a non-default host port, use that port in `MEMORY_API_URL`.

## Capture Hook

The TypeScript Capture Hook is the supported automatic capture path for Codex. It uses the same `MEMORY_API_URL` and `MEMORY_API_TOKEN` values as the MCP Server.

For a self-hosted checkout, build `@koed/mcp-server` and point Codex at:

```text
/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js
```

Capture Hook settings:

```text
MEMORY_HOOK_STRICT=false
MEMORY_HOOK_MAX_ITEMS=10
MEMORY_HOOK_TRIGGER_LCM_SUMMARY=true
MEMORY_HOOK_LCM_SUMMARY_DELAY_MS=10000
MEMORY_HOOK_LCM_SUMMARY_LIMIT=2
```

## Verify

Use the console smoke test first. Then start a fresh Codex session and ask it to check memory access through the `koed-selfhost` MCP server.

The MCP Server uses the Koed API Token for Recall, LCM summary submission, and Memory Answer evidence. Koed Self-Hosted relies on Codex for Synthesis; the backend does not make server-side LLM calls in this build. Full automatic Conversation capture depends on the Capture Hook and is not performed by MCP alone.

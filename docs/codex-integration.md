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

## Verify

Use the console smoke test first. Then start a fresh Codex session and ask it to check memory access through the `koed-selfhost` MCP server.

The MCP server uses the Koed API token for recall, LCM summary submission, and memory answer evidence. Koed Self-Hosted relies on Codex for LLM synthesis; the backend does not make server-side LLM calls in this build. Full automatic conversation capture depends on client-specific hooks or transcript integration and is not performed by MCP alone.

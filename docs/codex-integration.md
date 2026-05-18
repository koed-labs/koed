# Codex Integration

Codex is currently the only supported AI client for Koed Self-Hosted.

## API Token

Open the console, create a token named `Codex MCP`, and copy it immediately. Full token values are shown once.

## MCP Server

```bash
pnpm --filter @codex-memory/mcp-server build
```

In Codex Desktop, add a custom MCP server using `STDIO`:

```text
Name: koed-selfhost
Command: node
Argument: /path/to/koed-self-hosted/packages/mcp-server/dist/cli.js
Environment:
  CODEX_MEMORY_BASE_URL=http://localhost:3000
  CODEX_MEMORY_API_TOKEN=<token>
Working directory: /path/to/koed-self-hosted
```

The console `AI Clients` tab generates these values for your checkout. If your API runs on a non-default host port, use that port in `CODEX_MEMORY_BASE_URL`.

## Verify

Use the console smoke test first. Then start a fresh Codex session and ask it to check memory access through the `koed-selfhost` MCP server.

The MCP server uses the Koed API token for recall, LCM summary submission, and memory answer evidence. Full automatic conversation capture depends on Codex hooks or transcript integration and is not performed by MCP alone.

## Automatic Capture Hooks

The easiest path is to let the repo write the Codex MCP and hook block:

```bash
CODEX_MEMORY_API_TOKEN=<token> pnpm codex:configure
```

Then restart Codex.

Manual setup is also supported.

Create a private hook config file:

```bash
mkdir -p ~/.koed-memory
chmod 700 ~/.koed-memory
cat > ~/.koed-memory/config.json <<'JSON'
{
  "apiUrl": "http://localhost:3000",
  "apiToken": "<token>",
  "captureEnabled": true
}
JSON
chmod 600 ~/.koed-memory/config.json
```

Add the hook blocks to `~/.codex/config.toml`:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node /path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js --config ~/.koed-memory/config.json"
timeout = 10

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "node /path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js --config ~/.koed-memory/config.json"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node /path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js --config ~/.koed-memory/config.json"
timeout = 30
```

Restart Codex after changing the config. The console `AI Clients` tab generates these hook snippets with your local checkout path and API URL.

## Capture Control

Hooks are the automatic ingestion path. MCP is the retrieval and local
summarisation path. Installing MCP alone does not capture full conversations.

The capture hook checks Koed's backend capture policy before every write. Use
the local console `Memory` tab to enable, pause, or disable automatic capture
without editing Codex config. Disabling capture stops new hook ingestion; it does
not delete existing memories.

For other AI clients, Koed should keep the same backend policy and API token
model, but each client still needs a small adapter for whatever lifecycle hook,
transcript, or extension mechanism that client supports.

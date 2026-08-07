# Claude Code Integration

Codex is currently the only Supported AI Client Integration for Koed. A
Supported AI Client Integration provides automatic capture through a Capture
Hook plus Recall through Koed memory tools. Claude Code has no Capture Hook in
this build, so this page documents an experimental recall-only integration:
Claude Code sessions can call Memory Answer over memory captured from Codex
activity, but they do not create new Captured Sessions.

Set up [Codex integration](codex-integration.md) first. This page assumes a
running Koed deployment with capture already verified, and it reuses the same
API Token.

## Requirements

- A running Koed API, either supervised by `koed-server` or started directly.
  The default API host port is `3300`.
- A built MCP Server: `pnpm --filter @koed/mcp-server build`.
- A Koed API Token. Create one with `pnpm api-token:create` if needed.
- A local Codex install that is signed in. The MCP Server starts Codex
  app-server mode internally for Memory Answer and LCM summary Synthesis; the
  Koed backend does not run server-side LLM calls.
- Claude Code installed.

## Add the MCP Server

From the Project directory where recall should be available, register the MCP
Server at the default local scope:

```bash
claude mcp add koed-selfhost \
  --env MEMORY_API_URL=http://localhost:3300 \
  --env MEMORY_API_TOKEN=<token> \
  --env MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS=48000 \
  -- node /path/to/koed/packages/mcp-server/dist/cli.js
```

Use `--scope user` to make the server available across all of your projects.
For a shared project setup, `--scope project` writes `.mcp.json` at the project
root; keep the token value out of version control with environment variable
expansion:

```json
{
  "mcpServers": {
    "koed-selfhost": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/koed/packages/mcp-server/dist/cli.js"],
      "env": {
        "MEMORY_API_URL": "${MEMORY_API_URL:-http://localhost:3300}",
        "MEMORY_API_TOKEN": "${MEMORY_API_TOKEN}"
      }
    }
  }
}
```

Do not commit API Token values. `${VAR}` expansion resolves from the
environment where Claude Code runs.

## Verify

Check connection status from the terminal:

```bash
claude mcp list
```

`koed-selfhost` should report as connected. Inside a Claude Code session,
`/mcp` shows the server and its tools. The default recall tool appears to the
model as `mcp__koed-selfhost__memory_answer`.

The same doctor check used for Codex setup validates the API URL and API Token
directly:

```bash
MEMORY_API_URL=http://localhost:3300 MEMORY_API_TOKEN=<token> node packages/mcp-server/dist/cli.js doctor
```

Then start a Claude Code session in a Project with captured history and ask
about prior work in that Project. Claude Code should call `memory_answer` and
return a cited Memory Answer.

## Search Domain behavior

`memory_answer` defaults to the project Search Domain. Project search resolves
from the MCP Server process working directory; pass `project_id` explicitly
when that working directory does not match the captured Project. Session search
requires a backend `session_id`, and global search spans all memory visible to
the API Token. The tool guidance in
[Codex integration](codex-integration.md) applies to any connected AI Client.

## Running alongside Codex

Codex and Claude Code can attach separate MCP Server instances to the same Koed
API with the same API Token. The MCP Server also starts the local Memory
Question bridge on port `3210`. When another
instance already holds that port, the new instance logs the conflict, retries
in the background, and continues serving MCP recall. Set
`MEMORY_ANSWER_BRIDGE_ENABLED=false` on the Claude Code instance if the
Codex-attached instance should keep owning the bridge. See
[Configuration](configuration.md) for the bridge settings.

## Limitations

- Claude Code conversations are not captured. The Capture Hook is the only
  supported automatic capture path in this build, and it is Codex-specific.
- Memory Answer synthesis runs through the local Codex environment. If Codex is
  unavailable, recall fails even when asked from Claude Code.
- Recall-only integrations are experimental and are not Supported AI Client
  Integrations.

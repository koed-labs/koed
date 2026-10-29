---
"@koed-labs/server": patch
---

Connecting Claude Code no longer fails with "MCP server koed already exists in user config" on a busy Mac. Setup now also reads the existing `koed` entry from Claude Code's user config, so it replaces it even when `claude mcp get` times out.

---
"@koed/desktop": patch
"@koed/api": patch
"@koed/mcp-server": patch
"@koed/db": patch
"@koed-labs/server": patch
---

The Chief of Staff feels quicker:
- After your first message, the conversation no longer checks for updates every half second for as long as the window stays open. It checks often only while a reply is on its way.
- New Chief of Staff conversations use a low reasoning effort where the model offers one, so replies start in seconds instead of after ten or more seconds of thinking.
- Importing a Codex conversation from your history registers its transcript once, instead of rereading it before every batch.
- `koed status` asks again within 20 seconds after an AI Client check fails, so a check that failed only because Koed was still starting no longer keeps Koed marked unhealthy for minutes.
- The MCP Server health check waits up to 30 seconds for the Local AI Runtime, so a runtime that is busy importing history no longer marks Koed as needing attention.

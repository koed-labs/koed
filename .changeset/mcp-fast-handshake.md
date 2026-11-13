---
"@koed-labs/koed": patch
---

Keep the koed MCP server from timing out its client's connect when the Local AI Runtime is busy. The stdio server now waits at most 2 seconds for runtime capabilities before it answers `initialize`. Capability-gated tools register later and the client receives `notifications/tools/list_changed`.

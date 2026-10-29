---
"@koed-labs/server": patch
---

`koed status` no longer starts Claude Code, Codex, Pi and the MCP doctor on every run. It reuses their answers for up to a minute (15 seconds after a timeout), so Desktop's regular status checks stop keeping a busy Mac busy. Setup, repair and doctor clear the reused answers first.

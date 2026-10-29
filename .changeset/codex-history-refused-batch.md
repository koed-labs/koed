---
"@koed/mcp-server": patch
---

Importing your Codex history no longer gets stuck retrying the same batch every few seconds when Koed's API refuses it as invalid. Koed now retries that part of the conversation in smaller batches, and if even one record is refused, it skips that conversation and moves on to the next.

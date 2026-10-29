---
"@koed/mcp-server": patch
---

Importing your Codex history no longer gets stuck retrying the same batch every few seconds when Koed's API refuses it as invalid. Koed now retries that part of the conversation in smaller batches, and if even one record is refused, it skips that conversation and moves on to the next.

When the import run a conversation belongs to has already finished, Koed now continues that conversation under a new run instead of asking the API every few seconds.

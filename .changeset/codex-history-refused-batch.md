---
"@koed/mcp-server": patch
---

Importing your Codex history no longer gets stuck retrying the same batch every few seconds when Koed's API refuses it as invalid. Koed now retries that part of the conversation in smaller batches, and if even one record is refused, it skips that conversation and moves on to the next.

When the import run a conversation belongs to has already finished, Koed now continues that conversation under a new run instead of asking the API every few seconds.

A skipped conversation now records the API's reason code, so it is clear why it was skipped.

If the API refuses three conversations in a row with none completing in between, Koed stops importing history until it next starts instead of reading every remaining conversation only to have it refused. The refusal reason is in the log.

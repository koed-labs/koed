---
"@koed-labs/koed": patch
---

Import large Codex and Pi transcript records from the verified Conversation Source Journal. Codex no longer skips the rest of a Conversation at such a record, or stalls when a pending assistant event precedes it, and Pi no longer replaces it with a gap unless the record cannot be imported at all.

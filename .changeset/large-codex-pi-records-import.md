---
"@koed-labs/koed": patch
---

Import large Codex and Pi transcript records from the verified Conversation Source Journal during automatic history import. Codex imports such a record instead of skipping the rest of the Conversation, and no longer stalls when a pending assistant event and the record that resolves it fall into different journal segments. Pi imports the record instead of leaving a gap, unless the API cannot import it.

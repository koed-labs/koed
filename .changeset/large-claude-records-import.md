---
"@koed-labs/koed": patch
---

Fix Claude Code history import getting stuck on a large transcript record, such as a message with pasted screenshots. Koed now imports that record from the verified Conversation Source Journal and continues with later Conversations.

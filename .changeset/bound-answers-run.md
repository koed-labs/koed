---
"@koed-labs/koed": patch
---

Fix Memory Answers requested from Claude Code and Codex failing immediately with `personal_selection_incompatible`. Accepted tasks that carry the current Conversation binding now run instead of being rejected before retrieval.

---
"@koed/koed": minor
---

AI Clients can continue to work while a Personal Memory Answer runs and receive
the result in the same Conversation without another prompt. Pi does this by
default, and Claude Code and Codex turn it on with
`koed-server setup claude --background-recall` or
`koed-server setup codex --deferred-recall`.

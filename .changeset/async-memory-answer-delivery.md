---
"@koed/koed": minor
---

AI Clients can continue to work while a Personal Memory Answer runs and receive
the result in the same Conversation without another prompt. Pi and Codex do
this by default; Codex can opt out with
`koed-server setup codex --blocking-recall`. Claude Code turns it on with
`koed-server setup claude --background-recall`, because that setting applies
to every MCP Server in Claude Code.

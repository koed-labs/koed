---
"@koed/worker": patch
"@koed/desktop": patch
"@koed/mcp-server": patch
---

If the AI Client's session cannot start in time for a message (for example on a busy computer), Koed now reports that the message was not sent and puts it back in the box, so you can send it again. It used to mark delivery as uncertain and lock the conversation until it was checked. Koed also logs why a session could not be recovered after a restart.

Reopening a Codex conversation after a restart now waits up to a minute for Codex to open the thread, instead of giving up after ten seconds. On a busy Mac that limit kept the Chief of Staff from coming back after a restart.

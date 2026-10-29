---
"@koed/worker": patch
"@koed/desktop": patch
---

If the AI Client's session cannot start in time for a message (for example on a busy computer), Koed now reports that the message was not sent and puts it back in the box, so you can send it again. It used to mark delivery as uncertain and lock the conversation until it was checked. Koed also logs why a session could not be recovered after a restart.

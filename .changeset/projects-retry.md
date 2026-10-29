---
"@koed/desktop": patch
---

If Koed is not ready when the app first lists your Projects, it now tries again on its own (after 2, 4, 8… seconds, up to every 30), instead of showing "Projects could not be loaded" and keeping the Chief of Staff on "Opening Juno…" until you press Retry.

Likewise, if Koed's secure storage does not answer yet when the app opens, the conversation keeps trying instead of showing "Secure Conversation recovery is unavailable. Sending is paused." until the app restarts.

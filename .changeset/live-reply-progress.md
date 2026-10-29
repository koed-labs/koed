---
"@koed/desktop": patch
"@koed/mcp-server": patch
"@koed/worker": patch
---

Conversations show what is happening while a reply is on its way. The AI Client's current step ("Checking memory…", "Running a command…", "Thinking…") replaces "is working…", and the reply appears as it is written, checked every half second while a reply is coming and every few seconds otherwise. A finished reply no longer disappears for a moment before the saved one replaces it. While a Memory Answer runs, importing past conversations waits, and suggested actions are rechecked when a turn changes instead of every five seconds.

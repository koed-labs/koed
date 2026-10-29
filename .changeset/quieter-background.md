---
"@koed/desktop": patch
"@koed/mcp-server": patch
---

Koed keeps your Mac less busy in the background. While a service is not healthy, Desktop now checks status less and less often (up to every 30 seconds) instead of every 1.5 seconds for as long as the app is open. The Codex capture watcher no longer asks the API about every idle past conversation on every pass. The Chief of Staff's conversation also says "Juno is working…" instead of "The AI Client is working…".

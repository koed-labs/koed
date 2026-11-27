---
"@koed-labs/koed": patch
---

Fix Codex Conversations never being captured when Koed Desktop is started from Finder and Codex is installed outside the inherited `PATH`, for example with Homebrew on Apple Silicon. The Transcript Watcher now reads history metadata through the Codex executable that setup registered.

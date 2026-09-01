---
"@koed/koed": patch
---

Fix Codex, Claude Code, and Pi discovery for packaged macOS apps by searching common installation directories, storing canonical executable paths, and safely invoking Node-based CLI entries without relying on an interactive-shell `PATH`.

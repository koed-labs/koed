---
"@koed/koed": patch
---

Fix Codex, Claude Code, and Pi discovery for packaged macOS apps by searching common installation directories, storing stable absolute launcher paths, and safely invoking their current Node-based CLI targets without relying on an interactive-shell `PATH`.

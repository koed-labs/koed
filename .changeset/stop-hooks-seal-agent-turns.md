---
"@koed/koed": patch
---

Ensure Stop and SubagentStop hooks queue transcript catch-up even when earlier catch-up is active, preserving final turn sealing after existing token-limit rollover.

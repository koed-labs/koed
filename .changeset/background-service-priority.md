---
"@koed-labs/koed": patch
---

Run local Koed services at lower scheduling priority (nice 10) so foreground apps stay responsive while Koed works in the background. Set `KOED_BACKGROUND_NICE` from `0` to `19` to change it; `0` keeps normal priority. Server deployments in `external` runtime mode are unchanged.

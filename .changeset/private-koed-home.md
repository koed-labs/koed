---
"@koed-labs/server": patch
---

Koed now makes its own KOED_HOME and config folders private (0700) when it prepares the device identity. A KOED_HOME created beforehand with the usual 0755 used to make the API stop at startup with "A verified local deployment identity is required for collaboration realtime".

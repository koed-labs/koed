---
"@koed-labs/koed": patch
"@koed-labs/server": patch
---

Stop the API and Worker from repeatedly launching the Personal Device Sync secret provider while `KOED_PERSONAL_DEVICE_SYNC_ENABLED` is off, which is the default. Existing Personal Device Groups and stored data are unchanged, but they sync only when the switch is `true` for the supervisor, API, and Worker.

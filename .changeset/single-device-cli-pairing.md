---
"@koed-labs/server": patch
---

Make `koed pair` and `koed personal-sync` opt-in for this single-device release. They are hidden from `koed --help` and refuse to run unless `KOED_PERSONAL_DEVICE_SYNC_ENABLED=true` is set. Existing Personal Device Groups and stored data are unchanged.

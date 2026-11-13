---
"@koed-labs/koed": patch
---

Reduce background CPU use. With Personal Device Sync enabled, secret reads no longer block the API or worker. The worker reuses a missing-secret result for up to 15 seconds and refreshes it after pairing. `/v1/capabilities` reuses recent readiness results. Desktop reuses package status between refreshes and pauses animations and its Kin companion while another app has focus.

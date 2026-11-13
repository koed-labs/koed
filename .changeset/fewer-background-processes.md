---
"@koed-labs/koed": patch
---

Cut background CPU use. With Personal Device Sync on, the API and worker read its secret without blocking, and an unpaired worker checks for it every 15 seconds instead of every few seconds. `/v1/capabilities` reuses a recent readiness answer, so MCP connects faster. Desktop reuses package status between refreshes, and pauses looping animations and the Kin companion while another app has focus.

---
"@koed-labs/koed": patch
---

Cut background CPU use. The API and worker read the device sync secret without blocking, and an unpaired worker checks for it every 15 seconds instead of every few seconds. `/v1/capabilities` reuses a recent readiness answer, so MCP connects faster. Desktop reuses package status between refreshes, and pauses looping animations and the Kin companion while another app has focus.

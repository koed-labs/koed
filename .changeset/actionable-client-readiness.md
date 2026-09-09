---
"@koed/koed": minor
---

Allow Claude Code and Pi capture setup before execution authentication is
available. Keep automatic capture readiness separate from authenticated Recall,
Local Synthesis, and Managed Conversation capabilities.

Add clickable AI Client status details with recovery guidance and a copyable
Claude Code login command. Clear superseded sign-in guidance, avoid redundant
capability scans, and explain inspection timeouts without assuming repair is
required.

Label previously observed readiness and its timestamp when a new check fails,
keeping verification warnings separate from confirmed capability failures.

Keep AI Client status updates available during capture/import bursts by giving
status and settings requests a separate bounded rate limit. Explain throttled
capability publication instead of showing a generic refresh failure.

Use the same Pi model discovery for startup status and execution. Keep usable
models available after individual model failures, avoid duplicate catalog
queries, and show a pending state while discovery has not yet completed.

Keep all refresh failures unverified, including registration and network errors.
Show sign-in requirements and capability failures consistently in client cards
and details, with check errors scoped to the affected client.

---
"@koed/koed": minor
---

AI Clients can discover authorized Team Workspaces through `memory_workspaces`
and recall shared memory using the existing Koed enrollment. MCP can resolve
an explicitly selected Workspace's backend without manual backend configuration.
Desktop and headless `koed-server` use the same credential custody. Personal
Memory remains the default, and ambiguous or unavailable Team routes fail closed.

MCP detects support for the new Team features before calling a running runtime.
Workspace matching accepts equivalent UUIDs with different letter case.

Malformed Memory Answer worker output is reported as a validation failure
instead of a resource-limit message when retries are exhausted.
Saved structured diagnostics report the same validation failure.

---
"@koed/koed": minor
---

Run Personal Memory Answer as durable, encrypted PostgreSQL tasks owned by the
Local AI Runtime. Keep MCP, Claude Code, and Pi adapters stateless while they
wait for host-delivered completion, add fenced leases, cancellation, recovery,
progress-aware watchdogs, and replace the former single answer timeout with
separate no-progress and hard execution ceilings.

---
"@koed/koed": minor
---

Decouple Koed core readiness from AI Clients: `setup core --json` now bootstraps the database, embedding runtime, and Personal API Token without requiring any AI Client, and zero configured AI Clients is a healthy state. Add a typed AI Client capability and readiness contract shared across the MCP Server, API, koed-server, worker, and Desktop, with per-instance capability snapshots, fail-closed assignment revalidation, and no cross-client fallback. Desktop onboarding is now client-neutral with optional multi-select AI Client setup (Codex, Claude Code, Pi), per-client consent, safe repair and removal, and snapshot-backed per-client readiness. Preferences gains per-flow AI Client and model selectors for Memory Answer, LCM Summary, session titles, and Curated Memory Review. Managed Conversations now bind to an explicit AI Client instance with capability-gated admission and config-identity binding; Pi managed Conversations remain explicitly unsupported.

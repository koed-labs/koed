---
"@koed/koed": minor
---

Add opt-in WorkOS Agent Registration for the existing remote MCP endpoint,
supporting Personal and Team Memory through the current authorization and
local-execution pipeline. Confine WorkOS Team credentials to their mapped Team,
retain Koed OAuth, and provide hosted-registration discovery with bounded online
credential validation. Require explicit Operator enablement and entitlement
confirmation. Add User-owned connection management with durable per-registration
disconnect, explicit reauthorisation and a 30-day absolute authorisation lifetime
independent of WorkOS credential renewal.

---
"@koed/koed": minor
---

Move browser-mediated Step-up actions and device enrollment onto dedicated
approval pages served by the existing Koed API.

Operators upgrading from an Explorer deployment must remove the retired
Explorer service and its health checks, then point `BROWSER_PUBLIC_URL` (or the
`API_BROWSER_PUBLIC_URL` Compose setting) at the public origin of the existing
Koed API. Approval pages, authentication, and approval JSON are now served from
that same API origin; no separate browser service is required.

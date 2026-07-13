---
"@koed/koed": patch
---

Use the active bundled-local Postgres connection when setting up the supported AI Client, even when the checkout `.env` has a different database port.

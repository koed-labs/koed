---
"@koed/worker": patch
---

The worker reads its device sync key from Koed's local secret store directly instead of starting the Koed command-line tool for it on every sync check. Each of those starts was a separate program that held up the worker for a second or more.

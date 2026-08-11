---
"@koed/koed": patch
---

Prevent the retention purge worker from repeatedly querying an empty queue while preserving immediate processing for queued purge work.

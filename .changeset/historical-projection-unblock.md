---
"@koed/koed": patch
---

Keep historical Projection moving during real use.

- A single turn larger than the historical batch row or byte cap is now
  projected by itself, instead of blocking every later imported turn.
- Live rows that are only waiting for an open agent turn to finish no longer
  pause historical import and Projection. Completed and stale turns still give
  live capture priority.
- Historical-import 409 responses now carry machine-readable codes. Importers
  retry only a pending completion, accept an already-applied one, and report
  other conflicts without stopping work on later sources.

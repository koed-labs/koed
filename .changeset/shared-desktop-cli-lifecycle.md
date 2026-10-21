---
"@koed/koed": minor
"@koed-labs/server": minor
---

The `koed` launcher installed from Koed Desktop now manages Desktop's own
instance: `status`, `doctor`, `setup`, client repair, `start`, `stop`, and
`restart` work whether Desktop is open or closed, and Desktop reconnects to a
supervisor started by the launcher without starting a duplicate. Desktop shows
an externally stopped instance as stopped with a Start action. An independently
installed CLI keeps its own instance. Reinstall the launcher from Desktop to
upgrade an existing one.

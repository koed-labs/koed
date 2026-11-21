---
"@koed-labs/server": patch
---

Use the environment file selected by `KOED_ENV_PATH` for the API, Worker, and
Embedding Service, and read it with the same rules as Koed Server. Keep values
already set in the process environment. `koed start --daemon` and
`koed restart` now resolve a relative path from the directory where you run
them.

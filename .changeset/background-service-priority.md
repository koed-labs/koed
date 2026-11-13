---
"@koed-labs/koed": minor
---

Reduce Koed's impact on foreground apps. Local services now run at lower scheduling priority (nice 10); set `KOED_BACKGROUND_NICE` from `0` to `19` to change it, where `0` keeps normal priority. llama-server now defaults to half the logical CPUs instead of all of them; set `EMBEDDING_LLAMA_N_THREADS` to override. Server deployments in `external` runtime mode keep normal priority.

---
"@koed-labs/koed": minor
---

Reduce Koed's impact on foreground apps. Local services run at lower scheduling priority (nice 10; `KOED_BACKGROUND_NICE`, `0` keeps normal priority). llama-server defaults to half the logical CPUs (`EMBEDDING_LLAMA_N_THREADS` overrides). New `resourceProfile` in `server.json` or `KOED_RESOURCE_PROFILE`: `low`, `balanced` (default), or `full` sets priority, embedding threads, and Codex transcript polling. `external` runtime mode is unchanged.

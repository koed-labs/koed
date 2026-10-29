---
"@koed/embedding-service": patch
"@koed/desktop": patch
---

Embedding your past conversations now uses at most half of your computer's cores (up to four) by default, instead of all of them, so Koed and the rest of your Mac stay responsive while it works. `LLAMA_N_THREADS` still overrides this. The Chief of Staff's conversation also no longer shows a reply twice while it is being saved.

---
"@koed/embedding-service": patch
---

Quitting or restarting Koed no longer leaves the embedding model server (llama-server) running in the background. A stop that arrives while the model is still loading now ends it, and if one is ever left behind after a forced quit, the next start ends it before starting a new one. Before, each forced restart could leave another copy holding memory and CPU.

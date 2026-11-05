---
"@koed-labs/server": minor
---

Add an optional Linux CUDA package to each product release. The CLI installs the CPU core by default. Use `koed runtime install --provider release --dependency-mode bundled-local --with-cuda` to add CUDA while Koed is stopped.

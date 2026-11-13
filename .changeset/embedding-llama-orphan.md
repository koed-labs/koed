---
"@koed-labs/koed": patch
---

Stop llama-server together with the Embedding Service in source runtimes on macOS and Linux. Previously, llama-server could keep running after the Embedding Service exited without a clean shutdown, and hold its port and memory until it was stopped by hand.

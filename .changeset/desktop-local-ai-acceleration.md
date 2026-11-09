---
"@koed/koed": minor
"@koed-labs/server": minor
---

Add Desktop onboarding hardware detection and shared CPU/GPU processing controls in the Hardware Acceleration section under Services settings. Supported Macs can choose Metal or CPU; supported Linux NVIDIA devices can explicitly opt into the optional CUDA runtime when a qualified release catalog is available.

Keep the embedding model unchanged, show the verified active backend separately from the saved preference, and report Privacy Filter's provider independently. Coordinate runtime installation and preference changes through owned stop/start operations, with progress, cancellation, CPU recovery, and interruption reconciliation across window reloads.

Keep generated Desktop defaults editable, distinguish native runtime overrides from the Docker binary placeholder, and use the shared Settings selector for processing changes.

Recognise source-installation ownership so Settings can switch CPU and GPU processing from the same checkout, while preserving packaged and foreign-installation ownership checks.

Prevent queued embedding requests from restarting the model during shutdown, and stop replaying finished processing failures after an app restart. Show operation progress in the existing Settings footer without adding a row.

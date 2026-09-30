---
"@koed/koed": patch
---

Fix Personal Device Sync checkpoint publication and source export for Pi and Codex. Prevent tunneled wake requests and stale replies from blocking bidirectional sync, defer package work during membership transitions, and complete device revocation. Preserve historical membership certificates so retained checkpoint signatures remain verifiable after epoch rotation.

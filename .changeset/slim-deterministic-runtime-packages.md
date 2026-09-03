---
"@koed/koed": minor
---

Reduce standalone and Desktop package sizes. Use shared runtime staging, target-specific Privacy Filter assets, deterministic manifests, bounded extraction, and stricter release validation.

Package manifests now require schema 2. Rebuild packages that use the earlier manifest schema before installation.

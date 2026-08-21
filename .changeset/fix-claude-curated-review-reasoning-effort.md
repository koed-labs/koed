---
"@koed/koed": patch
---

Fix Curated Memory Review assignment being permanently unsavable for Claude models (e.g. Haiku) that report no explicit reasoning-effort support: the "none" sentinel is now resolved consistently by the Claude capability publisher, the default assignment, and the Desktop settings UI instead of leaving the field stuck on an unsatisfiable value.

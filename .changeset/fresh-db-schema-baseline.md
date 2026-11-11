---
"@koed-labs/koed": major
"@koed-labs/server": major
---

Stable database setup now starts from a single fresh-install schema. Existing pre-release and alpha database histories are not supported as in-place upgrade sources, and no alpha-to-stable conversion is provided. The old database is left untouched; Operators must retain a backup separately and initialize a fresh database for the stable release.

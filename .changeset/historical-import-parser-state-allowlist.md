---
"@koed/koed": patch
---

Allowlist historical-import resume state before persisting it: only the fields real Codex/Claude adapters actually produce for mid-parse resume are stored, so arbitrary or oversized content passed as parser state can no longer be written to or read back from the historical import cursor.

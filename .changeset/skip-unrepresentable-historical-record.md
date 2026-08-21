---
"@koed/koed": patch
---

Fix bounded historical onboarding getting permanently stuck when a single Codex JSONL record cannot fit within the historical batch byte/row limits: the source is now marked skipped instead of retried forever, so newer Conversations in the cohort continue to import.

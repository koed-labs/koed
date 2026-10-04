---
"@koed/koed": patch
---

Fix Claude slash suggestions dropping synced skills with long storage paths. Preserve the CLI secure-storage identity across managed Conversation config canonicalization and SDK SessionStore resume relocation. Add regression coverage for version-qualified Claude model labels without changing model identifiers.

Bound file-backed slash discovery by visited entries, including non-command files and directories, and cancel all root scans when the adapter deadline expires.

---
"@koed/shared": patch
"@koed/worker": patch
"@koed/api": patch
---

A Chief of Staff (Project HQ) conversation no longer fails with "Koed cannot prove whether the last command reached the AI Client" when KOED_HOME sits inside a git repository. Folders in KOED_HOME are not treated as a checkout of a repository around it, so a prompt no longer tries to checkpoint that whole repository first.

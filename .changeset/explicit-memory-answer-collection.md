---
"@koed/koed": minor
---

Add explicit non-blocking Memory Answer submission and result collection over
the existing local task runtime, with cancellation tools and guidance for doing
independent work before collecting an answer. Preserve blocking recall and
replace Codex answer-delivery Stop hooks with ordinary tool results.

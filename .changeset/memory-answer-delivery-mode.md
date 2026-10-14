---
"@koed/koed": minor
---

AI Clients can choose how each Memory Answer is delivered with the new
`delivery_mode` option on `memory_answer`. Use `blocking` to wait for the
answer, or `non_blocking` to continue independent work while it runs where
deferred delivery is available. Leaving it out keeps the configured default.

# Database TODO

## Drizzle Hybrid Adoption

- Memory Question repository methods were reviewed on 2026-06-08. Keep them
  raw SQL for now: `claimPendingMemoryQuestions` and `updateMemoryQuestion`
  are lease/concurrency-sensitive, while splitting only create/list/get would
  add hybrid complexity without enough payoff.
- Keep graph, vector search, retrieval, LCM, chronology, and projection queries
  raw SQL unless a specific conversion has a clear correctness, readability, or
  testability payoff.

## Audit Events

- Current durable audit coverage includes API Token creation/revocation and
  Capture Policy upsert/deletion, memory deletion, graph event invalidation,
  and memory presentation updates.
- Audit metadata must not include token secrets, token hashes, session cookies,
  passwords, memory content, or raw request bodies.

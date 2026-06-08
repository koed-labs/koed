# Database TODO

## Drizzle Hybrid Adoption

- Memory Question repository methods were reviewed on 2026-06-08 and extracted
  to `memory-question-repository.ts`. Keep them raw SQL for now:
  `claimPendingMemoryQuestions` and `updateMemoryQuestion` are
  lease/concurrency-sensitive.
- Repository decomposition has moved captured sessions, conversation items,
  local embedding diagnostic status, Memory Questions, Memory Node browser/CRUD,
  and workflow token usage into dedicated fragments. The remaining
  `repository.ts` core is graph/vector/retrieval/LCM/projection-heavy and should
  be split only along those runtime boundaries.
- Keep graph, vector search, retrieval, LCM, chronology, and projection queries
  raw SQL unless a specific conversion has a clear correctness, readability, or
  testability payoff.

## Audit Events

- Current durable audit coverage includes API Token creation/revocation and
  Capture Policy upsert/deletion, memory deletion, graph event invalidation,
  and memory presentation updates.
- Audit metadata must not include token secrets, token hashes, session cookies,
  passwords, memory content, or raw request bodies.

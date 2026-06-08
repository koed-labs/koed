# Database TODO

## Drizzle Hybrid Adoption

- Consider Memory Question shell CRUD only after checking whether the current
  lease/claim/update behavior remains clearer with raw SQL.
- Keep graph, vector search, retrieval, LCM, chronology, and projection queries
  raw SQL unless a specific conversion has a clear correctness, readability, or
  testability payoff.

## Audit Events

- Current durable audit coverage includes API Token creation/revocation and
  Capture Policy upsert/deletion, memory deletion, graph event invalidation,
  and memory presentation updates.
- Audit metadata must not include token secrets, token hashes, session cookies,
  passwords, memory content, or raw request bodies.

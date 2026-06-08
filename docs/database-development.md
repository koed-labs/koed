# Database Development

Koed uses Drizzle in codebase-first mode for schema and migration management.
The source of truth for database shape is
`packages/db/src/schema.ts`; generated SQL lives in `packages/db/drizzle/`.

When changing the schema:

1. Edit `packages/db/src/schema.ts`.
2. Generate a migration with `pnpm --filter @koed/db migrate:generate`.
3. Review the generated SQL in `packages/db/drizzle/`.
4. Check migration metadata with `pnpm db:migrate:check`.
5. Run a clean migration smoke test with `pnpm db:migrate:smoke`.

`pnpm db:migrate:smoke` uses `DATABASE_URL` to connect to a Postgres server,
creates a temporary database, runs the packaged Drizzle migrations, verifies the
latest Drizzle journal timestamp was recorded, and drops the temporary database.
The Postgres user in `DATABASE_URL` must be allowed to create and drop
databases, and the server must have the `vector` extension available.

Do not add new migrations under `packages/db/src/migrations/`; that directory
was replaced by the Drizzle migration folder.

## Hybrid Query Policy

Use Drizzle for schema ownership, migrations, and table-shaped repository
fragments where typed columns reduce drift. Current Drizzle-backed fragments
cover Users, API Tokens, auth sessions, Audit Events, Capture Policies, and
Local Memory Agent Settings.

Keep dense graph, vector search, retrieval, LCM, chronology, and projection
queries as raw SQL unless converting them clearly improves correctness,
readability, or testability. These queries often rely on Postgres-specific
ranking, recursive relationships, vector operators, expression indexes, or
careful result shaping that Drizzle would not simplify today.

The db package implementation backlog lives in `packages/db/TODO.md`.

When adding a Drizzle-backed fragment:

1. Keep the public `MemorySourceRepository` method contract unchanged.
2. Put the fragment in `packages/db/src/*-repository.ts`.
3. Compose the fragment in `createMemorySourceRepository`.
4. Add focused real-DB tests for the moved behavior.
5. Leave unrelated raw SQL paths alone.

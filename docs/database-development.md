# Database Development

Koed uses Drizzle in codebase-first mode for schema and migration management.
The source of truth for database shape is
`packages/db/src/schema.ts`; generated SQL lives in `packages/db/drizzle/`.

When changing the schema:

1. Edit `packages/db/src/schema.ts`.
2. Generate a migration with `pnpm --filter @koed/db migrate:generate`.
3. Review the generated SQL in `packages/db/drizzle/`.
4. Check migration metadata with `pnpm db:migrate:check`.
5. Run the migration acceptance matrix with
   `pnpm db:migrate:acceptance` (the `pnpm db:migrate:smoke` alias remains
   available).

`pnpm db:migrate:acceptance` uses `DATABASE_URL` to connect to a Postgres
server and creates a separate disposable database for every acceptance case.
It fails closed unless all of these cases pass:

- a clean run of the full migration journal;
- the exact populated current-main `0000` through `0012` schema upgraded by the
  single current `0013`, with Personal Memory and Team/Workspace fixture data
  retained;
- transaction rollback and a successful retry after the migration statement is
  cancelled mid-`0013`;
- a real `pg_dump` backup before upgrade, `pg_restore` into a fresh database,
  retained-data verification, and upgrade of the restored database;
- an idempotent migration rerun with unchanged migration ledger, schema, and
  retained data; and
- executable alpha compatibility boundaries: current collaboration queries are
  unavailable before `0013`, the discarded experimental Team Chat schema is
  unavailable after it, and current-main-shaped stable writes remain valid
  after the forward migration.

The Postgres user in `DATABASE_URL` must be allowed to create and drop
databases. The server must have the `vector` extension available. Matching
`pg_dump` and `pg_restore` binaries must be on `PATH`; use `PG_DUMP_BIN` and
`PG_RESTORE_BIN` to select explicit binaries. Every disposable database is
force-dropped in cleanup, including on failure.

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

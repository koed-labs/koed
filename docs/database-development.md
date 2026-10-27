# Database Development

Koed uses Drizzle in codebase-first mode for schema and migration management.
The source of truth for database shape is
`packages/db/src/schema.ts`; generated SQL lives in `packages/db/drizzle/`.

When changing the schema:

1. Edit `packages/db/src/schema.ts`.
2. Generate a migration with `pnpm --filter @koed/db migrate:generate`.
3. Review the generated SQL in `packages/db/drizzle/`.
4. Check migration metadata with `pnpm db:migrate:check`.
5. Run current-build migration acceptance with
   `pnpm db:migrate:acceptance` (the `pnpm db:migrate:smoke` alias remains
   available).

`pnpm db:migrate:acceptance` uses `DATABASE_URL` to connect to a Postgres
server and creates a separate disposable database for every acceptance case.
The complete checked-in migration journal determines the current schema; the
runner does not pin a historical migration number. Acceptance covers:

- a clean run of the full migration journal;
- current column, constraint, index, and security-trigger contracts;
- concurrent migration startup against the same clean database;
- transaction rollback after a deliberate statement failure or cancellation,
  with unchanged schema, data, and ledger, followed by a successful retry;
- a real current-build `pg_dump` backup, `pg_restore` into a fresh database,
  exact public-table data and schema comparison, and restart of the restored
  database;
- an idempotent migration rerun with unchanged migration ledger, schema, and
  retained data; and
- current schema guards, including the absence of discarded Team Chat objects
  and removed source-path columns.

The former `--current-schema-only` argument remains accepted and selects the same
checks. Historical alpha schema layouts are no longer part of this default gate.
Dedicated Project and sync cutover tests retain their distinct migration evidence.
SQL migration history is unchanged.

The Postgres user in `DATABASE_URL` must be allowed to create and drop
databases. The server must have the `vector` extension available. Matching
`pg_dump` and `pg_restore` binaries must be on `PATH`; use `PG_DUMP_BIN` and
`PG_RESTORE_BIN` to select explicit binaries. Every disposable database is
force-dropped in cleanup, including on failure.

Project recall uses one consolidated migration, `0046_project_scoped_recall`,
after main's unchanged `0045_agent_seal_waiting_marker`. Migration `0046` includes
the Project schema, database guards, sync profile support, and the one-time
transition that marks existing Personal Sessions unresolved. Main databases can
upgrade normally. Databases that used the earlier unreleased recall migrations
require a reset. Startup rejects that discarded history before changing data.
Do not use this build with an old branch database that contains data you need.

Migration startup serializes concurrent upgrades. Workers wait for every expected
migration hash before they use the schema. The migration tests cover populated
main upgrades, transaction rollback, repeated runs, and the reset diagnostic.

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

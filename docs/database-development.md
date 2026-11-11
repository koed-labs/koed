# Database Development

Koed uses Drizzle in codebase-first mode for schema and migration management.
The source of truth for database shape is
`packages/db/src/schema.ts`; generated SQL lives in `packages/db/drizzle/`.
The current journal contains only `0000_clean_initial_schema`, a fresh-install
baseline. Stable installation starts with an empty database; existing alpha
databases are not supported migration or conversion sources. After this baseline,
future stable changes add ordered migrations and upgrade from the stable schema.

When changing the schema:

1. Edit `packages/db/src/schema.ts`.
2. Generate a migration with `pnpm --filter @koed-labs/db migrate:generate`.
3. Review the generated SQL in `packages/db/drizzle/`.
4. Check migration metadata with `pnpm db:migrate:check`.
5. Run current-build migration acceptance with
   `pnpm db:migrate:acceptance` (the `pnpm db:migrate:smoke` alias remains
   available).

Migration generation formats only `packages/db/drizzle/meta/*.json` with the
repository's Oxfmt configuration. To format existing metadata separately, run
`pnpm --filter @koed-labs/db migrate:format`.

`pnpm db:migrate:acceptance` uses `DATABASE_URL` to connect to a Postgres
server and creates a separate disposable database for every acceptance case.
The checked-in journal contains the single initial baseline and determines the
current schema; acceptance covers:

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
checks. Historical alpha schema layouts are not part of this gate. Alpha-only
operational cleanup or reconciliation instructions do not define stable upgrade
support. The current-schema gate also compares function bodies, view definitions
and trigger state.

The Postgres user in `DATABASE_URL` must be allowed to create and drop
databases. The server must have the `vector` extension available. Matching
`pg_dump` and `pg_restore` binaries must be on `PATH`; use `PG_DUMP_BIN` and
`PG_RESTORE_BIN` to select explicit binaries. Every disposable database is
force-dropped in cleanup, including on failure.

## Historical alpha Project reconciliation

The Project consolidation and its migration-reconciliation procedure were
alpha-only. They do not provide a stable upgrade path and are not run by stable
installation. Existing alpha databases are unsupported as stable migration
sources; use a fresh empty database for stable. Preserve any desired alpha
backup separately for reference or recovery within a compatible alpha setup.

Application repositories require the complete current schema. Retired Session
move/reset and Project-routing endpoints are removed. Assignment reviews support
inspection and dismissal; source context changes use the reviewed per-Conversation
correction workflow. Capture retains existing Capture Target bindings independently
of Project membership. Historical tests seed their earlier schemas directly.

Do not add new migrations under `packages/db/src/migrations/`; that directory
was replaced by the Drizzle migration folder.

## Shared Memory test isolation

`SHARED_MEMORY_TEST_DATABASE_URL` supplies an administrative connection for the
Shared Memory repository suite. Its role needs `CREATEDB`. The suite creates one
uniquely named migrated template with classifier/policy seed data, then clones a
fresh database for each case. It closes and drops each clone after that case and
removes the template at the end. The database named by the URL is not seeded or
reset. Separate connections within each case still exercise real concurrency.
This prevents global work queues and deliberately different encryption keys from
leaking across cases.

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

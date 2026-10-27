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
The current-schema gate also compares function bodies, view definitions and trigger state.

The Postgres user in `DATABASE_URL` must be allowed to create and drop
databases. The server must have the `vector` extension available. Matching
`pg_dump` and `pg_restore` binaries must be on `PATH`; use `PG_DUMP_BIN` and
`PG_RESTORE_BIN` to select explicit binaries. Every disposable database is
force-dropped in cleanup, including on failure.

## Unreleased Project migration consolidation

Main's migrations through `0046_external_agent_grants` are unchanged.
The initial `0047_project_scoped_recall` also remains byte-for-byte unchanged;
it includes repository identity, sync profile support and the one-time historical
assignment transition. The later branch migrations are consolidated into:

- `0048_personal_project_model`: Personal membership, source context, Capture
  Target preservation, LCM change observation and default Projects;
- `0049_continuous_sharing`: final sharing reasons, publications, rule controls,
  admissions, deliveries and Workspace exclusions.

The journal now contains 50 entries. Fresh and main databases upgrade normally.
The six unused alpha-upgrade staging tables and retired `personal_project_routes`
table are absent from the final schema. Existing routes are copied into active
Capture Target records before the old routing table is removed.

An existing local database at the exact former 77-entry branch head or the 49-entry cleanup head before the main merge needs explicit
reconciliation before starting this build. Preserve that database. Use a Local
Operator Script with its actual `DATABASE_URL` and a new absolute backup path:

```bash
pnpm db:migrate:reconcile-projects --backup /absolute/path/pre-cleanup.dump
```

The script accepts local development databases only. It creates a full private
custom-format backup, verifies the archive, and writes a SHA-256 receipt beside it.
Existing backup paths are never overwritten. `PG_DUMP_BIN` and `PG_RESTORE_BIN`
select matching PostgreSQL tools. For bundled-local operation, use the supervised
runtime's database connection; the root `.env` can describe a different server.

Reconciliation takes the migration lock and requires an exact ordered known old
ledger, the verified old schema including functions/views/triggers, empty unused
upgrade tables, and an exact retained Capture Target for each old Project route.
For the 77-entry history it removes only those retired objects and normalizes the
remaining admission primary key name. Both transitions apply main’s external-agent
grant migration once, verify the complete surviving schema, and replace the ledger
tail after the original main prefix through 0045. It never replays sharing backfills.
All changes commit together; failed checks roll back. The original main ledger
entries through 0045 remain unchanged; the three Project SQL bodies are unchanged
and are recorded after main’s new migration. Repeating the command against the
canonical history is a no-op.

Normal startup continues rejecting unknown migration histories. A different schema,
nonempty staging table or unmatched route needs explicit data preservation and
inspection. The script does not reset a database or guess a compatible history.
Retain the backup: returning to an older build requires restoration into an
appropriate database rather than replaying the discarded branch migration chain.

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

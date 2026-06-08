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

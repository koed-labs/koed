# Koed DB Package

`@koed/db` owns Koed's Postgres schema, migrations, repository factories, and
Local Operator Scripts for API Token management. It is the shared persistence
layer used by the API, Worker, tests, and operator commands.

The package should preserve Koed's domain boundaries: raw source activity is
stored separately from projected semantic memory, Projection creates Koed
semantic memory structures, and Recall reads Evidence Bundles without implying
backend Answer Synthesis.

## Responsibilities

- Define the Drizzle schema and generated migrations.
- Create database pools and run or wait for migrations.
- Provide repository fragments for Users, API Tokens, auth sessions, Capture
  Policies, captured sessions, raw conversation items, Memory Questions, Memory
  Nodes, settings, audits, token usage, and embedding status.
- Provide the main `createMemorySourceRepository` used for Projection, graph
  reads, Recall, LCM compaction, expansion, and embedding storage.
- Provide Local Operator Scripts for creating, listing, and revoking API
  Tokens.

## Key Modules

- `src/schema.ts`: Drizzle schema definitions and table enums.
- `drizzle/`: checked-in SQL migrations and migration metadata.
- `src/connection.ts`: database pool creation and migration readiness checks.
- `src/migrate.ts` and `src/migrate-cli.ts`: migration execution.
- `src/repository.ts`: core graph, vector search, retrieval, LCM, chronology,
  Projection, and embedding repository behavior.
- `src/conversation-semantic-projection.ts`: semantic Projection helpers.
- `src/conversation-item-repository.ts`: raw `conversation_items` repository.
- `src/memory-node-repository.ts`: Memory Node browser/CRUD repository.
- `src/memory-question-repository.ts`: Memory Question persistence and leasing.
- `src/workflow-token-usage-repository.ts`: workflow token usage attribution.
- `scripts/`: Local Operator Scripts for API Token management and migration
  smoke testing.

## Local Commands

From the repository root:

```bash
pnpm --filter @koed/db build
pnpm --filter @koed/db test
pnpm --filter @koed/db typecheck
```

Migration commands:

```bash
pnpm --filter @koed/db migrate:generate
pnpm --filter @koed/db migrate:check
pnpm --filter @koed/db migrate:smoke
pnpm --filter @koed/db migrate:up
```

API Token Local Operator Scripts:

```bash
pnpm --filter @koed/db api-token:create --owner-email local@koed.ai --name "Client Integration"
pnpm --filter @koed/db api-token:list
pnpm --filter @koed/db api-token:revoke
```

## Repository Guidance

Keep simple table-shaped repository fragments small and focused. Dense graph,
vector search, retrieval, LCM, chronology, and Projection queries currently
remain raw SQL because they rely on Postgres-specific ranking, recursion,
expression indexes, and carefully shaped result sets.

See `packages/db/TODO.md` for current repository decomposition notes.

## Related Documentation

- `CONTEXT.md`: domain glossary and relationship map.
- `docs/database-development.md`: database development conventions.
- `docs/database-row-boundary-safeguards.md`: row-boundary safeguards.
- `docs/raw-ingestion-projection.md`: raw ingestion and Projection behavior.
- `docs/token-usage-attribution.md`: workflow token usage model.
- `docs/backup-restore.md`: backup and restore guidance.

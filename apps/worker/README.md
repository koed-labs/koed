# Koed Worker

The Worker is Koed's background processing service. It consumes BullMQ jobs,
runs raw Projection catch-up, embeds Memory Events and Memory Nodes, and keeps
LCM Placeholder nodes moving toward retrievable summaries.

The Worker does not perform Answer Synthesis or LCM Summary creation. LCM
Summaries are created locally through the MCP Server and connected AI Client,
then submitted back to the API for storage and embedding.

## Responsibilities

- Consume embedding and LCM compaction queues.
- Run a periodic raw Projection catch-up loop for pending or previously failed
  `conversation_items`.
- Embed Memory Events and Memory Nodes through the Embedding Service.
- Store embedding chunks and metadata in Postgres.
- Schedule LCM compaction from newly projected Memory Events.
- Process semantic-memory rebuild jobs after source deletion invalidates
  affected Memory Events.

## Key Modules

- `src/index.ts`: process entry point, queue workers, database setup, shutdown.
- `src/env-config.ts`: Worker runtime configuration.
- `src/job-workflows.ts`: queue names and job handlers for embedding and
  compaction work.
- `src/raw-projection-service.ts`: periodic raw Projection catch-up and semantic
  rebuild processing.
- `src/embedding-workflow.ts`: Embedding Service client and embedding storage.
- `src/backfill-embeddings.ts`: one-off embedding backfill script.
- `src/logging.ts`: Worker log formatting.

## Local Commands

From the repository root:

```bash
pnpm --filter @koed/worker build
pnpm --filter @koed/worker dev
pnpm --filter @koed/worker test
pnpm --filter @koed/worker typecheck
```

Production entry point after build:

```bash
pnpm --filter @koed/worker start
```

Run an embedding backfill:

```bash
pnpm --filter @koed/worker embeddings:backfill
```

## Configuration

Use `apps/worker/.env.example` for process-local development values. For the
full Operator-facing environment reference, see `docs/configuration.md`.

Important runtime dependencies:

- Postgres via `DATABASE_URL`.
- Redis via `REDIS_URL` for BullMQ queues.
- The Embedding Service URL, token, model key, and dimensions.
- Raw Projection catch-up limits:
  `MEMORY_RAW_PROJECTION_INTERVAL_MS`,
  `MEMORY_RAW_PROJECTION_BATCH_LIMIT`, and
  `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`.

## Related Documentation

- `CONTEXT.md`: domain glossary and relationship map.
- `docs/service-sequence-overview.md`: service ordering and high-level flows.
- `docs/raw-ingestion-projection.md`: raw ingestion, Projection, token bounds,
  and rebuild behavior.
- `docs/configuration.md`: deployment and Worker configuration.
- `docs/observability.md`: structured logging and diagnostics.

# Koed API

The API is Koed's backend HTTP service. It authenticates Users and API Tokens,
persists captured source activity, runs Projection into Koed semantic memory
structures, serves Recall endpoints, and exposes Explorer-facing graph,
settings, and question APIs.

The API stores and retrieves memory, but it does not perform server-side LLM
synthesis. Answer Synthesis and LCM Summary creation are delegated to the
connected AI Client through the MCP Server.

## Responsibilities

- Authenticate browser sessions and API Token requests.
- Persist raw `conversation_items` submitted by the Supported Capture Hook and
  MCP-local background workflows.
- Run Projection through `/v1/memory/conversation-items/project`.
- Serve Memory Answer evidence through `/v1/memory/search`,
  `/v1/memory/answer`, and memory-node expansion routes.
- Manage Capture Policies, Memory Questions, local AI Client settings, graph
  views, pending LCM Summary work, and token usage attribution.
- Enqueue embedding and compaction jobs for the Worker when semantic memory
  changes.

## Key Modules

- `src/index.ts`: process entry point.
- `src/server/build-server.ts`: Fastify app construction, database wiring,
  work queue adapters, rate limits, CORS, cookies, and route registration.
- `src/server/config.ts`: API runtime configuration.
- `src/auth/`: User auth, sessions, and setup/login routes.
- `src/api-tokens/`: API Token routes and schemas.
- `src/memory/raw-conversation-routes.ts`: raw ingestion, token usage, and
  Projection endpoint.
- `src/memory/recall-routes.ts`: Recall and Evidence Bundle endpoints.
- `src/memory/lcm-routes.ts`: pending LCM Summary and submission routes.
- `src/memory/questions-routes.ts`: Memory Question persistence and claim/update
  routes.
- `src/memory/graph-routes.ts` and `src/memory/graph-stream.ts`: Explorer graph
  APIs and update stream.
- `src/memory/jobs.ts`: embedding and LCM compaction job scheduling.
- `src/memory/queue.ts`: BullMQ and Postgres-backed local queue adapter wiring.
- `src/infra/`: rate limiting and cache providers.

## Local Commands

From the repository root:

```bash
pnpm --filter @koed/api build
pnpm --filter @koed/api dev
pnpm --filter @koed/api test
pnpm --filter @koed/api typecheck
```

Production entry point after build:

```bash
pnpm --filter @koed/api start
```

## Configuration

Use `apps/api/.env.example` for process-local development values. For the full
Operator-facing environment reference, see `docs/configuration.md`.

Important runtime dependencies:

- Postgres via `DATABASE_URL`.
- `WORK_QUEUE_BACKEND=bullmq` with Redis via `REDIS_URL`, or `WORK_QUEUE_BACKEND=local` with Postgres-backed `local_work_queue` jobs. Redis can still back optional shared rate-limit/cache stores.
- The Embedding Service URL and token for recall-time query embeddings and
  reranking.
- `API_TOKEN_PEPPER` and `DATA_ENCRYPTION_KEY` for auth/token handling.

## Related Documentation

- `CONTEXT.md`: domain glossary and relationship map.
- `docs/service-sequence-overview.md`: service ordering and high-level flows.
- `docs/raw-ingestion-projection.md`: raw ingestion and Projection details.
- `docs/configuration.md`: deployment and AI Client configuration.
- `docs/observability.md`: structured logging and service diagnostics.

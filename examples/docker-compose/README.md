# Docker Compose external dependency starter

This Compose file is an optional Operator-managed external dependency stack for local source checkouts. It starts Postgres/pgvector, Redis, and the Embedding Service. `koed-server` connects to these URLs in `KOED_DEPENDENCY_MODE=external`; it does not start or stop this stack.

From the repo root:

```bash
pnpm env:setup
docker compose -f examples/docker-compose/docker-compose.yml up -d --build
KOED_DEPENDENCY_MODE=external koed-server start
```

Use explicit URLs when host ports differ:

```bash
POSTGRES_HOST_PORT=15433 REDIS_HOST_PORT=16380 EMBEDDING_SERVICE_HOST_PORT=3801 \
  docker compose -f examples/docker-compose/docker-compose.yml up -d --build

KOED_DEPENDENCY_MODE=external \
DATABASE_URL=postgres://koed:${POSTGRES_PASSWORD}@localhost:15433/koed \
REDIS_URL=redis://localhost:16380 \
EMBEDDING_SERVICE_URL=http://localhost:3801 \
koed-server start
```

Stop the external stack yourself when done:

```bash
docker compose -f examples/docker-compose/docker-compose.yml down
```

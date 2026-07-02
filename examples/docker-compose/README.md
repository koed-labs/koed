# Docker Compose external dependency starter

This Compose file is an optional Operator-managed external dependency stack for local source checkouts. It starts Postgres/pgvector, Redis, and the Embedding Service. `koed-server` connects to these URLs in `KOED_DEPENDENCY_MODE=external`; it does not start or stop this stack.

From the repo root:

```bash
pnpm env:setup
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
pnpm --filter @koed/koed-server build
KOED_DEPENDENCY_MODE=external node packages/koed-server/dist/cli.js start
```

Use explicit URLs when host ports differ. Compose reads `.env`, but your shell
needs the password exported before interpolating it into `DATABASE_URL`:

```bash
set -a
. ./.env
set +a

POSTGRES_HOST_PORT=15433 REDIS_HOST_PORT=16380 EMBEDDING_SERVICE_HOST_PORT=3801 \
  docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build

KOED_DEPENDENCY_MODE=external \
DATABASE_URL=postgres://koed:${POSTGRES_PASSWORD}@localhost:15433/koed \
REDIS_URL=redis://localhost:16380 \
EMBEDDING_SERVICE_URL=http://localhost:3801 \
node packages/koed-server/dist/cli.js start
```

Stop the external stack yourself when done:

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml down
```

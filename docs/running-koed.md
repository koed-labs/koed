# Running Koed

> [!IMPORTANT]  
> Only Codex is supported for knowledge capture. More agents to follow!

Koed runs API, worker, embedding service, and an optional Explorer
frontend. Postgres with pgvector stores Users, API Tokens, Memory Events, Memory
Nodes, embeddings, and Capture Policies. Redis backs BullMQ queues.

## Local Run

For the guided zero-to-verified path, run:

```bash
pnpm clients:bootstrap
```

If you want to manage the services manually:

```bash
pnpm env:setup
docker compose up --build
```

If ports conflict with another local app:

```bash
API_HOST_PORT=3001 EXPLORER_WEB_HOST_PORT=5574 EXPLORER_API_BASE_URL=http://localhost:3001 docker compose up --build
```

Finish the Codex integration after the API migrations have run; `pnpm codex:bootstrap`
creates or reuses the API token, builds `@koed/db` and `@koed/mcp-server`, and
verifies capture plus doctor health automatically:

```bash
pnpm codex:bootstrap
```

Use `pnpm explorer:bootstrap` after `pnpm codex:bootstrap` if you want to refresh the
Explorer token config separately.

The Explorer frontend is available at `http://localhost:5174`, or the host port you selected.

## LCM Smoke Test

`pnpm smoke:lcm` expects a disposable Docker Compose stack using the small LCM
smoke profile. The profile lowers the LCM thresholds and raises only the local
write limit needed for the test; it does not change product defaults.

```bash
docker compose --env-file .env --env-file scripts/lcm-smoke.env up -d --build api worker embedding-service postgres redis
pnpm api-token:create --owner-email smoke@example.local --name lcm-smoke
MEMORY_API_TOKEN=<token> pnpm smoke:lcm
```

## Production Notes

Keep Postgres, Redis, and the embedding service private. Expose only the API and optional Explorer through your reverse proxy. Set strong `API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`, database password, and Redis password. Use TLS at the reverse proxy if the API or Explorer are reachable beyond localhost.

Memory data is stored plaintext at the application layer in Postgres in this build. Protect the database and backups with private networking, least-privilege credentials, encrypted storage, and restricted administrator access.

Only `/health` and `/ready` are intended for unauthenticated infrastructure probes. They return coarse status and should not be used as operator diagnostics. `/v1/capabilities` is also unauthenticated, but it is a client discovery contract rather than a health check: clients can use it to detect the positive capabilities registered by the current backend, and should treat missing capabilities as unavailable. Detailed status endpoints such as `/health/details`, `/self-host/diagnostics`, and the authenticated view of `/self-host/status` should remain behind normal API authentication.

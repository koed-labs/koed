# Running Koed

> [!IMPORTANT]  
> Only Codex is supported for knowledge capture. More agents to follow!

Koed runs API, worker, embedding service, and an optional Explorer
frontend. Postgres with pgvector stores Users, API Tokens, Memory Events, Memory
Nodes, embeddings, and Capture Policies. Redis backs BullMQ queues.

## Local Run

```bash
pnpm env:setup
pnpm install
pnpm build
docker compose up --build
```

If ports conflict with another local app:

```bash
API_HOST_PORT=3300 EXPLORER_WEB_HOST_PORT=5574 EXPLORER_API_BASE_URL=http://localhost:3300 docker compose up --build
```

Create a local API token after the API migrations have run:

```bash
pnpm api-token:create --owner-email local@koed.ai --name "Client Integration"
```

The Explorer frontend is available at `http://localhost:5174`, or the host port you selected.

## Production Notes

Keep Postgres, Redis, and the embedding service private. Expose only the API and optional Explorer through your reverse proxy. Set strong `API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`, database password, and Redis password. Use TLS at the reverse proxy if the API or Explorer are reachable beyond localhost.

Memory data is stored plaintext at the application layer in Postgres in this build. Protect the database and backups with private networking, least-privilege credentials, encrypted storage, and restricted administrator access.

Only `/health` and `/ready` are intended for unauthenticated infrastructure probes. They return coarse status and should not be used as operator diagnostics. Detailed status endpoints such as `/health/details`, `/self-host/diagnostics`, and the authenticated view of `/self-host/status` should remain behind normal API authentication.

# Running Koed

> [!IMPORTANT]  
> Only Codex is supported for knowledge capture. More agents to follow!

Koed runs API, Worker, Embedding Service, and Explorer under the local
`koed-server` control plane. Postgres with pgvector stores Users, API Tokens,
Memory Events, Memory Nodes, embeddings, and Capture Policies. Redis backs
BullMQ queues.

On the experimental `epic/electron-control-refactor` branch, `koed-server`
defaults to external dependency mode for source checkouts. It connects to
Operator-managed Postgres, Redis/BullMQ, and Embedding Service endpoints; it
does not start or stop Docker Compose dependencies.

## Local Run

For the current local development path, start the Docker-backed external dependency stack, then open Koed Desktop:

```bash
pnpm env:setup
docker compose up -d --build
pnpm desktop:start
```

`pnpm desktop:start` opens Koed Desktop, which auto-starts `koed-server`, runs
Codex bootstrap when needed, and keeps the startup screen visible until the
system is ready.

`koed-server` owns `KOED_HOME`, runs API, Worker, and Explorer as supervised
local app processes, and records runtime state under `KOED_HOME/run`. Docker
Compose is treated as Operator-managed external infrastructure in this mode.

Check service state from any headless shell:

```bash
node packages/koed-server/dist/cli.js status --json
node packages/koed-server/dist/cli.js doctor --json
```

Run Codex setup through the same surface after `koed-server start` has made the
API ready:

```bash
node packages/koed-server/dist/cli.js setup codex --json
```

Docker Compose is one way to provide external Postgres/pgvector, Redis/queues,
and the Embedding Service/model runtime. Start Docker Desktop before launching
the Compose stack, then let `koed-server` connect to the service URLs. Advanced
Operators can provide the same URLs from `KOED_HOME/config/server.json` instead
of Docker Compose.

If dependency ports conflict with another local app, start the external dependency stack with alternate host ports and pass matching explicit URLs to `koed-server`:

```bash
REDIS_HOST_PORT=16380 EMBEDDING_SERVICE_HOST_PORT=3801 docker compose up -d --build
API_HOST_PORT=3300 EXPLORER_WEB_HOST_PORT=5574 REDIS_URL=redis://localhost:16380 EMBEDDING_SERVICE_URL=http://localhost:3801 node packages/koed-server/dist/cli.js start
```

The Explorer frontend is available at `http://localhost:5174`, or the host port you selected, and is embedded by Koed Desktop.

### Koed Desktop

Koed Desktop is the Electron control surface for the same local control plane.
It wraps `koed-server`, shows service status, and can start the supervisor,
run Codex setup, run doctor, and open the embedded Explorer.

```bash
pnpm --filter @koed/desktop start
```

For renderer development only:

```bash
pnpm --filter @koed/desktop dev
```

## Production Notes

Keep Postgres, Redis, and the embedding service private. Expose only the API and optional Explorer through your reverse proxy. Set strong `API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`, database password, and Redis password. Use TLS at the reverse proxy if the API or Explorer are reachable beyond localhost.

Memory data is stored plaintext at the application layer in Postgres in this build. Protect the database and backups with private networking, least-privilege credentials, encrypted storage, and restricted administrator access.

Only `/health` and `/ready` are intended for unauthenticated infrastructure probes. They return coarse status and should not be used as operator diagnostics. Detailed status endpoints such as `/health/details`, `/self-host/diagnostics`, and the authenticated view of `/self-host/status` should remain behind normal API authentication.

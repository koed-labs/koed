# Koed Server Compose wrapper

This Compose file is the server/private-VPS shape: it runs `koed-server` plus
its deployment dependencies. It is separate from
`examples/docker-compose/docker-compose.yml`, which remains a dependency-only
starter for source checkouts where `koed-server` runs on the host.
The `koed-server` image includes the PostgreSQL 17 client tools required by
backup, restore, migration-acceptance, and launch-validation operations.

From the repo root:

```bash
pnpm env:setup
pnpm models:install:embedding
docker compose --env-file .env -f examples/server-compose/docker-compose.yml up -d --build
```

Always reuse the same generated `.env` when recreating or upgrading the stack.
It contains independent general and owner-private encryption configuration plus
durable realtime secrets. Replacing those values without an explicit key
rotation or rewrap makes existing encrypted records unreadable and invalidates
existing realtime cursors.

Default public local ports:

- API: `http://localhost:3300`
- Explorer: `http://localhost:5174`

Postgres, Redis, and the Embedding Service stay private on the Compose network.
Use a reverse proxy/TLS in front of `koed-server` for a real private VPS or
Team self-hosted deployment. This wrapper defaults API and collaboration
rate-limit counters to the included Redis service so limits remain shared when
the API process is restarted or replicated.

Every service uses Compose's `unless-stopped` restart policy. If an essential
managed child (API, Worker, or Explorer) exits unexpectedly, the `koed-server`
supervisor stops its remaining children and exits nonzero so Compose restarts
the coherent service set. Postgres, Redis, and the Embedding Service also
recover after an unexpected container or Docker daemon restart. `docker compose
stop` and `docker compose down` remain clean manual stops and do not trigger an
automatic restart.

`MEMORY_API_URL` is intentionally pinned to the container's internal API
endpoint. Configure the browser-facing Explorer origin separately with
`API_EXPLORER_PUBLIC_URL` when a reverse proxy, tunnel, or non-default host
port is used. Include that exact browser origin in `API_CORS_ORIGINS` as well.
This prevents the server from attempting to reach itself through an
Operator-facing endpoint while preserving browser CSRF protections.

Browser self-registration is disabled by default. For a local mock server or
closed dogfood environment where registration is intentionally open, set
`KOED_ALLOW_PUBLIC_REGISTRATION=true` in the Compose env file. Production
operators should prefer WorkOS/AuthKit or operator-managed account bootstrap.

The Embedding Service container mounts `${KOED_MODELS_DIR}` at `/models`; when
`KOED_MODELS_DIR` is unset it mounts `$HOME/.koed/models`, which matches the
default `koed-server models install --kind embedding` destination.

This wrapper is the remote/server side of the topology. Normal Codex MCP Server
and Supported Capture Hook configuration should stay pointed at each User's
local `koed-server`, usually `http://localhost:3300`. The local `koed-server`
registers this server as an upstream and proxies only explicitly approved Team
Workspace recall, Share Grant, sync/offload, or remote capture-bearing
operations through local-edge routing. Personal Memory capture remains local by
default.

For server-side smoke tests or API-token-compatible clients, create an API Token
from inside the server container:

```bash
docker compose --env-file .env -f examples/server-compose/docker-compose.yml exec koed-server \
  pnpm api-token:create --owner-email local@koed.ai --name "Codex"
```

Do not use that smoke-test shortcut as the normal Codex/MCP topology when a
local `koed-server` is available.

Stop and remove the stack:

```bash
docker compose --env-file .env -f examples/server-compose/docker-compose.yml down
```

Remove all local server data as well:

```bash
docker compose --env-file .env -f examples/server-compose/docker-compose.yml down -v
```

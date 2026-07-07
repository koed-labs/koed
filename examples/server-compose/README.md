# Koed Server Compose wrapper

This Compose file is the server/private-VPS shape: it runs `koed-server` plus
its deployment dependencies. It is separate from
`examples/docker-compose/docker-compose.yml`, which remains a dependency-only
starter for source checkouts where `koed-server` runs on the host.

From the repo root:

```bash
pnpm env:setup
pnpm models:install:embedding
docker compose --env-file .env -f examples/server-compose/docker-compose.yml up -d --build
```

Default public local ports:

- API: `http://localhost:3300`
- Explorer: `http://localhost:5174`

Postgres, Redis, and the Embedding Service stay private on the Compose network.
Use a reverse proxy/TLS in front of `koed-server` for a real private VPS or
Team self-hosted deployment.

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

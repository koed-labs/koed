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

Postgres, Redis, and the Embedding Service stay private on the Compose network.
Use a reverse proxy/TLS in front of `koed-server` for a real private VPS or
Team self-hosted deployment. This wrapper defaults API and collaboration
rate-limit counters to the included Redis service so limits remain shared when
the API process is restarted or replicated.

Every service uses Compose's `unless-stopped` restart policy. If an essential
managed child (API or Worker) exits unexpectedly, the `koed-server`
supervisor stops its remaining children and exits nonzero so Compose restarts
the coherent service set. Postgres, Redis, and the Embedding Service also
recover after an unexpected container or Docker daemon restart. `docker compose
stop` and `docker compose down` remain clean manual stops and do not trigger an
automatic restart.

`MEMORY_API_URL` is intentionally pinned to the container's internal API
endpoint. The same `koed-server` API process serves Step-up and device-
enrollment pages. If the public browser-reachable address differs from the
registered backend URL, set `API_BROWSER_PUBLIC_URL` to the public API origin.
Do not deploy a separate browser client and do not add
another CORS origin for approval pages; authentication and approval writes are
same-origin. Behind TLS, set `API_COOKIE_SECURE=true` and configure
`WORKOS_REDIRECT_URI` on that public API origin.

Browser self-registration is disabled by default. For a local mock server or
closed dogfood environment where registration is intentionally open, set
`KOED_ALLOW_PUBLIC_REGISTRATION=true` in the Compose env file. Production
operators should prefer WorkOS/AuthKit or operator-managed account bootstrap.

For isolated source-checkout testing of this Compose stack as both the local
identity authority and a Team backend, set `KOED_DEPLOYMENT_PROFILE=developer`,
`KOED_TEAM_COLLABORATION_ENABLED=true`, and
`KOED_DEVELOPER_TEAM_BACKEND_ENABLED=true`. The last switch is ignored outside
the developer profile and must not be enabled in production. Team Self-Hosted
and managed-cloud profiles continue to require verified WorkOS/AuthKit identity
for Team-authority operations.

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

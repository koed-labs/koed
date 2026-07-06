# Running Koed

> [!IMPORTANT]  
> Only Codex is supported for knowledge capture. More agents to follow!

Koed runs API, Worker, Embedding Service, and Explorer under the local
`koed-server` control plane. Postgres with pgvector stores Users, API Tokens,
Memory Events, Memory Nodes, embeddings, and Capture Policies. Redis backs
BullMQ queues when `WORK_QUEUE_BACKEND=bullmq`; the Postgres-backed local queue
is used when `WORK_QUEUE_BACKEND=local`.

The README Quickstart is the supported first-time path for basic local use: one
bundled-local setup that avoids Docker, external Postgres, and external Redis.
This document covers advanced running modes, development fallbacks, manual
control-plane commands, and smoke workflows.

In source checkouts, `koed-server` defaults to external dependency mode unless
`KOED_DEPENDENCY_MODE=bundled-local` is set. In external mode it connects to
Operator-managed Postgres, Redis/BullMQ, and Embedding Service endpoints; it
does not start or stop Docker Compose dependencies.

## Manual control-plane commands

`pnpm desktop:start` opens Koed Desktop, which auto-starts `koed-server`, runs
Codex bootstrap when needed, and keeps the startup screen visible until the
system is ready.

`koed-server` owns `KOED_HOME`, runs API, Worker, and Explorer as supervised
local app processes, and records runtime state under `KOED_HOME/run`. In
external dependency mode, Docker Compose or another dependency launcher is
Operator-managed infrastructure.

Check service state or stop/restart supervised local processes from any headless shell:

```bash
node packages/koed-server/dist/cli.js status --json
node packages/koed-server/dist/cli.js doctor --json
node packages/koed-server/dist/cli.js start --daemon --json
node packages/koed-server/dist/cli.js stop --json
node packages/koed-server/dist/cli.js restart --json
```

`start --daemon --json` starts a detached `koed-server start` supervisor and returns machine-readable startup intent for Desktop and scripts. `stop` is idempotent. Missing/stale process IDs are reported in JSON but do not fail the command. `restart --json` runs the same stop lifecycle, starts a detached `koed-server start` supervisor, and returns machine-readable JSON without streaming startup logs. In bundled-local mode it stops Explorer, Worker, API, native Embedding Service, and native Postgres via `pg_ctl stop -D <dataDir> -m fast`. It does not stop Docker Compose. External dependency mode does not stop Operator-managed Postgres, Redis, or Embedding Service.

## KOED_HOME layout

`koed-server` keeps local state under `KOED_HOME`:

- `config/` for `server.json`, `local-ports.json`, and `explorer-token.json`
- `run/` for `koed-server.json`, `last-verification.json`, and supervisor state
- `logs/` for service logs, including `postgres.log`
- `data/` for native database files, including `data/postgres`
- `models/` for embedding and reranker model files
- `cache/` for installer metadata and downloaded artifact cache
- `runtime/` for bundled or packaged native runtime binaries

Packaged Desktop and headless local-personal flows both use this layout.

Run Codex setup through the same surface after `koed-server start` has made the
API ready:

```bash
node packages/koed-server/dist/cli.js setup codex --json
```

## External dependency mode

Docker Compose is one optional way to provide external Postgres/pgvector,
Redis/queues, and the Embedding Service/model runtime. It is Operator-managed
infrastructure, not the local-personal happy path. Start Docker Desktop before
launching the Compose stack, then let `koed-server` connect to the service URLs:

```bash
pnpm env:setup
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
pnpm desktop:start
```

Advanced Operators can provide the same URLs from `KOED_HOME/config/server.json`
instead of Docker Compose.

### Bundled-local native runtime

Set `KOED_DEPENDENCY_MODE=bundled-local` to let `koed-server start` launch native Koed-owned Postgres/pgvector and Embedding Service runtimes under `KOED_HOME` and default the API/Worker queue backend to `local`. Redis is not required for queues in this mode unless `WORK_QUEUE_BACKEND=bullmq` is explicitly set; with BullMQ, Redis is Operator-managed external infrastructure.

Bundled-local mode is native-only. Native Postgres binaries should be available under `KOED_HOME/runtime/postgres/bin` or `KOED_POSTGRES_BIN_DIR`, and the Embedding Service needs a runtime Python virtualenv, `app.py`, `KOED_HOME/runtime/llama.cpp/llama-server`, and model assets. Runtime install places the Embedding Service virtualenv at `KOED_HOME/runtime/embedding-service/.venv/bin/python`; in source checkouts, `pnpm setup:python` prepares `apps/embedding-service/.venv` with the pinned runtime dependencies used by the Embedding Service. The README Quickstart runs this, the workspace build, runtime install, and embedding model install as `pnpm local:setup`. Packaged Desktop also checks packaged app resources after `KOED_HOME/runtime`. Source-checkout `vendor` and `apps/embedding-service` paths remain development fallbacks only; packaged mode rejects those fallbacks unless `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1` is set for developer diagnostics. `KOED_BUNDLED_POSTGRES_MODE` and `KOED_BUNDLED_EMBEDDING_MODE` are deprecated and ignored. Missing native resources fail with setup guidance instead of falling back to Docker Compose. Docker Compose is available only as an Operator-selected external dependency starter.

On macOS, Linux, and WSL, Homebrew is one selected provisioning path for the native runtime assets under `KOED_HOME`:

```bash
pnpm runtime:status
pnpm runtime:install
```

`runtime status` is diagnostic-only and never installs packages. `runtime install` may run `brew install postgresql@17 pgvector llama.cpp` when packages are missing, then links selected binaries under `KOED_HOME/runtime` and records install metadata under `KOED_HOME/cache`. The default embedding model is installed separately with a pinned URL and SHA-256 checksum:

```bash
pnpm models:install:embedding
```

Set `KOED_EMBEDDING_MODEL_URL` and `KOED_EMBEDDING_MODEL_SHA256` only when installing a custom embedding model artifact. Use `--kind reranker` with `KOED_RERANKER_MODEL_URL` and `KOED_RERANKER_MODEL_SHA256` when enabling reranking.

### WSL development

Run Koed inside WSL as Linux tooling. Keep `KOED_HOME` on Linux filesystem paths such as `/home/<user>/.koed`; do not point bundled-local runtime state at Windows paths. Use the same `pnpm install`, `pnpm build`, `runtime status/install`, `models install`, `start`, `status`, and `doctor` commands from WSL.

Windows host browsers can usually reach Koed through WSL localhost forwarding at `http://localhost:<API_HOST_PORT>` and `http://localhost:<EXPLORER_WEB_HOST_PORT>`. If localhost forwarding is not available, resolve the WSL IP from inside WSL and browse that IP from Windows instead:

```bash
wsl.exe hostname -I
```

Then open `http://<WSL_IP>:<port>` for the API or Explorer. Native Windows packaged app support is not shipped in this build; use WSL for Windows development.

### Packaged Desktop first-run

Packaged Koed Desktop starts its managed local-personal `koed-server` with `runtimeMode=local-personal`, `dependencyMode=bundled-local`, and `WORK_QUEUE_BACKEND=local`. First run resolves `KOED_HOME`, persists `KOED_HOME/config/local-ports.json`, and checks `runtime status/install` plus `models status/install` before local startup continues. Packaged runtime assets are preferred first; Homebrew-backed runtime install is only used when that provisioning path is selected on macOS, Linux, or WSL. Native Windows packaged app support is not part of this build, so Windows development should use WSL.

`desktop:package` and `desktop:package:smoke:mac` build unsigned local smoke artifacts. `desktop:package:release` prepares macOS `dmg` and `zip` outputs, but signed/notarized release artifacts still require local Developer ID credentials and release setup.

Run the bundled-local smoke workflow to verify the native control-plane path with an isolated temporary `KOED_HOME` and temporary host ports:

```bash
pnpm smoke:bundled-local -- --full --install-runtime --json
```

`--install-runtime` explicitly runs the Homebrew-backed runtime install for the temporary `KOED_HOME` before native resource checks. The smoke workflow skips explicit model installation unless `KOED_EMBEDDING_MODEL_URL` and `KOED_EMBEDDING_MODEL_SHA256` are configured. `--full` adds API Token creation, Capture Hook-like personal ingestion, Projection, local queue/embedding work, Memory Answer evidence retrieval with a unique marker, Explorer reachability, and cleanup through `koed-server stop --json`. Missing native binaries or model assets fail clearly instead of falling back to Docker.

Packaged Desktop smoke now exercises the packaged Electron bundle with a temporary `KOED_HOME`, unsets `KOED_REPO_ROOT`, and verifies daemon start/status/reconnect/stop without checkout fallbacks. For CI or diagnostics when native assets are absent, run:

```bash
pnpm desktop:package:smoke:mac -- --missing-assets --json
```

When packaged native assets are staged, omit `--missing-assets` to let smoke install packaged runtime assets, start the daemon, and reach a healthy local stack.

If dependency ports conflict with another local app, start the external dependency stack with alternate host ports and pass matching explicit URLs to `koed-server`:

```bash
REDIS_HOST_PORT=16380 EMBEDDING_SERVICE_HOST_PORT=3801 docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
KOED_DEPENDENCY_MODE=external API_HOST_PORT=3300 EXPLORER_WEB_HOST_PORT=5574 REDIS_URL=redis://localhost:16380 EMBEDDING_SERVICE_URL=http://localhost:3801 node packages/koed-server/dist/cli.js start
```

The Explorer frontend is available at `http://localhost:5174`, or the host port you selected, and is embedded by Koed Desktop.

### Koed Desktop

Koed Desktop is the Electron control surface for the same local control plane.
It wraps `koed-server`, shows service status, and can start the supervisor,
run Codex setup, run doctor, explicitly trigger Homebrew-backed runtime install
with Operator confirmation, and open the embedded Explorer. Packaged Koed
Desktop starts its managed local personal server with bundled-local native
runtime defaults unless the Operator explicitly overrides runtime/dependency
mode; source-checkout Desktop keeps the bare developer default and uses explicit
external dependency configuration.

```bash
pnpm --filter @koed/desktop start
```

For local packaged-native smoke with Homebrew/Linuxbrew-provided assets, stage the native runtime first and pass it into packaging:

```bash
pnpm native-runtime:stage:homebrew -- --out /tmp/koed-native-runtime --force
KOED_NATIVE_RUNTIME_SOURCE_DIR=/tmp/koed-native-runtime pnpm --filter @koed/desktop package:mac
```

The Homebrew staging helper requires an existing Embedding Service virtualenv at `apps/embedding-service/.venv`, or `KOED_EMBEDDING_VENV_DIR=/path/to/.venv`. It is a development smoke helper and does not create release-quality redistributable native runtime assets.

For renderer development only:

```bash
pnpm --filter @koed/desktop dev
```

## LCM Smoke Test

`pnpm smoke:lcm` expects a disposable Docker Compose stack using the small LCM
smoke profile. The profile lowers the LCM thresholds and raises only the local
write limit needed for the test; it does not change product defaults.

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build postgres redis embedding-service
# In another shell, run koed-server start with scripts/lcm-smoke.env loaded before pnpm smoke:lcm
pnpm api-token:create --owner-email smoke@example.local --name lcm-smoke
MEMORY_API_TOKEN=<token> pnpm smoke:lcm
```

## Production Notes

Keep Postgres, Redis, and the embedding service private. Expose only the API and optional Explorer through your reverse proxy. Set strong `API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`, database password, and Redis password. Use TLS at the reverse proxy if the API or Explorer are reachable beyond localhost.

Memory data is stored plaintext at the application layer in Postgres in this build. Protect the database and backups with private networking, least-privilege credentials, encrypted storage, and restricted administrator access.

Only `/health` and `/ready` are intended for unauthenticated infrastructure probes. They return coarse status and should not be used as operator diagnostics. `/v1/capabilities` is also unauthenticated, but it is a client discovery contract rather than a health check: clients can use it to detect the positive capabilities registered by the current backend, and should treat missing capabilities as unavailable. `status --json` and `doctor --json` use readiness gates for Postgres reachability/version, migrations, pgvector, work queue backend, and Embedding Service model/dimensions before reporting healthy; doctor output gives repair actions such as running migrations, enabling pgvector, fixing dependency URLs, or correcting model/runtime mismatch. Detailed status endpoints such as `/health/details`, `/self-host/diagnostics`, and the authenticated view of `/self-host/status` should remain behind normal API authentication. Koed Desktop packaging/signing remains tracked separately from this local runtime path.

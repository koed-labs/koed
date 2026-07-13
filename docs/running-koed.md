# Running Koed

> [!IMPORTANT]  
> Only Codex is supported for knowledge capture. More agents to follow!

Koed's server deployment unit is `koed-server` plus dependencies. Internally,
`koed-server` supervises API, Worker, and Explorer app processes, and connects
to the configured Embedding Service. Postgres with pgvector stores Users, API
Tokens, Memory Events, Memory Nodes, embeddings, and Capture Policies. Redis
backs BullMQ queues when `WORK_QUEUE_BACKEND=bullmq`; the Postgres-backed local
queue is used when `WORK_QUEUE_BACKEND=local`.

The README Quickstart is the supported first-time path for basic local use: one
bundled-local setup that avoids Docker, external Postgres, and external Redis.
This document covers advanced running modes, development fallbacks, manual
control-plane commands, and smoke workflows.

In source checkouts, `koed-server` defaults to external dependency mode unless
`KOED_DEPENDENCY_MODE=bundled-local` is set. In external mode it connects to
Operator-managed Postgres, Redis/BullMQ, and Embedding Service endpoints; it
does not start or stop Docker Compose dependencies.
For server/private VPS terminology and migration notes, see
[server-deployment-boundary.md](server-deployment-boundary.md).

## Manual control-plane commands

`pnpm desktop:start` opens Koed Desktop, which auto-starts `koed-server`, runs
Codex bootstrap when needed, and keeps the startup screen visible until the
system is ready.

`koed-server` owns `KOED_HOME`, runs API, Worker, and Explorer as supervised
local app processes, and records runtime state under `KOED_HOME/run`. In
external dependency mode, Docker Compose or another dependency launcher is
Operator-managed infrastructure.

Check service state or stop/restart supervised local processes from any headless
shell:

```bash
node packages/koed-server/dist/cli.js status --json
node packages/koed-server/dist/cli.js doctor --json
node packages/koed-server/dist/cli.js start --daemon --json
node packages/koed-server/dist/cli.js stop --json
node packages/koed-server/dist/cli.js restart --json
```

`start --daemon --json` starts a detached `koed-server start` supervisor and returns machine-readable startup intent for Desktop and scripts. `stop` is idempotent. Missing/stale process IDs are reported in JSON but do not fail the command. `restart --json` runs the same stop lifecycle, starts a detached `koed-server start` supervisor, and returns machine-readable JSON without streaming startup logs. In bundled-local mode it stops Explorer, Worker, API, native Embedding Service, and native Postgres via `pg_ctl stop -D <dataDir> -m fast`. It does not stop Docker Compose. External dependency mode does not stop Operator-managed Postgres, Redis, or Embedding Service.

In a source checkout, the supervisor launches the built API, Worker, and Explorer
Node entry points directly. Recorded process IDs therefore identify the service
processes themselves, so stop and restart do not leave package-manager child
processes listening on Koed ports.

Local upstream enrollment orchestration is exposed as machine-readable
control-plane state for Desktop and headless scripts:

```bash
node packages/koed-server/dist/cli.js upstream enroll start --id team-vps --json
node packages/koed-server/dist/cli.js upstream enroll status --id team-vps --json
node packages/koed-server/dist/cli.js upstream enroll cancel --id team-vps --json
node packages/koed-server/dist/cli.js upstream disconnect --id team-vps --json
```

`upstream enroll start` requires a registered upstream backend with fresh
validated capabilities and at least one explicitly enabled route-policy family.
It records non-secret local state under `KOED_HOME/run` and reports the next
browser action. It does not create API Tokens or write reusable device secrets
to ordinary config. Instead it creates a short-lived upstream browser approval
challenge, stores the pending local device secret in the encrypted
`KOED_HOME/secrets` credential store, and records only a `keychain://...`
reference in config. `upstream enroll status` validates the approved credential
against the upstream backend before marking the local backend credential
configured. Koed Desktop performs this reconciliation automatically while an
enrollment is pending and shows the activation URL as a manual fallback when
Linux/WSL host-browser integration is delayed or unavailable. `upstream
disconnect` disables local upstream route families and marks the local enrollment
state revoked. These local mutations use a per-backend inter-process lock, with
remote requests kept outside the locked mutation phase. Browser approval and
upstream-side device credential revocation remain browser/session-mediated
local-edge flows.

## Project metadata discovery

Headless and Desktop flows can discover local Project metadata before linking a
Project to a Team Workspace:

```bash
node packages/koed-server/dist/cli.js project discover --cwd "$PWD" --json
node packages/koed-server/dist/cli.js project show --cwd "$PWD" --json
node packages/koed-server/dist/cli.js project list --json
```

Project metadata is local matching/display data, not authorization. Discovery
stores raw local paths only under `KOED_HOME/config/projects.json`, strips
credentials from Git remotes, derives a device-local Project id, and retains
individual current and historical network remote aliases as non-authoritative
matching signals. Remote signals never select or authorize a Team Workspace;
explicit Project linking is authoritative. The Team Workspace id remains the
stable Team memory boundary.

Discovery inspects the supplied directory and its enclosing Git repository only;
it does not recursively discover child repositories, submodules, or monorepo
packages. Worktrees retain separate local Project ids while a salted Git
common-directory hash identifies worktrees backed by the same device-local Git
repository. Local-only repositories have no portable remote signal.

Captured Sessions adopt one unambiguous detected Personal Project immediately.
Ambiguous or signal-free captures remain `Unassigned`. Users can move a
Captured Session to another Personal Project in Desktop; that override remains
authoritative across later capture detection. Resetting returns assignment to
the latest automatic detection. Original capture candidates and source context
remain stored separately as immutable provenance. Effective assignment drives
Personal Memory grouping, counts, filters, and Project-scoped recall.

Personal Project assignment never creates, changes, resolves, or authorizes a
Team Workspace link. Team Workspace identity still comes only from explicit
Project linking, and Team access still requires Koed-owned Membership,
Workspace Access, and Share Grant authorization.

Future personal multi-device enrollment may use remote-alias overlap to
automatically associate local Project contexts after both devices are bound to
the same User. This build has no personal multi-device registry or sync path, so
remote aliases remain evidence only. They cannot merge Personal Memory across
deployments or create a Team Workspace link. `project forget
--local-project-id <id>` removes the local Project record, including retained
remote-alias history.

## Cross-Identity Sync

Cross-Identity Sync is available only when the complete path is reported by
capabilities. Relationship creation runs on a `local_personal` or `developer`
source after explicit User consent and a validated upstream enrollment whose
device credential includes the `sync` operation family. Remote intake runs only
on `private_vps`, `team_self_hosted`, or `koed_managed_cloud` targets. Personal
API Tokens and Capture Hooks cannot exercise this authority.

The source remains usable offline. Canonical changes accumulate in its durable
outbox and resume from the last acknowledged cursor when the target returns.
The target replica is read-only, and Team visibility still requires a separate
Workspace Share Grant after target processing reaches `ready`. Use authenticated
relationship status and redacted `/ops/status` sync metrics to diagnose queue
lag, retries, stale replicas, and failure classes; do not inspect encrypted
package rows as an operational workflow.

## KOED_HOME layout

`koed-server` keeps local state under `KOED_HOME`:

- `config/` for `server.json`, `local-ports.json`, `explorer-token.json`,
  local Project metadata, and Project-to-Team Workspace mappings
- `run/` for `koed-server.json`, `last-verification.json`, upstream enrollment
  orchestration state, and supervisor state
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

## Server / Private VPS Compose

For a server or private VPS style deployment, use the server Compose wrapper.
This runs `koed-server` as the application boundary plus private dependency
services on the Compose network:

```bash
pnpm env:setup
docker compose --env-file .env -f examples/server-compose/docker-compose.yml up -d --build
```

The default local test endpoints are `http://localhost:3300` for the API and
`http://localhost:5174` for Explorer. In a real private VPS or Team self-hosted
deployment, put a reverse proxy/TLS boundary in front of `koed-server` and keep
Postgres, Redis, and the Embedding Service private.

Because the database is private inside this wrapper, create API Tokens from
inside the server container:

```bash
docker compose --env-file .env -f examples/server-compose/docker-compose.yml exec koed-server \
  pnpm api-token:create --owner-email local@koed.ai --name "Codex"
```

Do not point normal AI Client integrations directly at this remote/server API.
Each User's Codex MCP Server and Supported Capture Hook should normally point at
that User's local `koed-server` API, usually `http://localhost:3300`. The local
`koed-server` then registers this server as an upstream and routes approved Team
Workspace recall, Share Grant, sync/offload, or remote capture-bearing
operations through local-edge policy. This keeps Personal Memory capture local by
default and avoids exposing upstream/cloud/device credentials to MCP Server or
Capture Hook processes.

### Bundled-local native runtime

Set `KOED_DEPENDENCY_MODE=bundled-local` to let `koed-server start` launch
native Koed-owned Postgres/pgvector and Embedding Service runtimes under
`KOED_HOME` and default the API/Worker queue backend to `local`. Redis is not
required for queues in this mode unless `WORK_QUEUE_BACKEND=bullmq` is
explicitly set; with BullMQ, Redis is Operator-managed external infrastructure.

Bundled-local mode is native-only. Native Postgres binaries should be available under `KOED_HOME/runtime/postgres/bin` or `KOED_POSTGRES_BIN_DIR`, including `psql`, `pg_dump`, and `pg_restore` for backup/restore operations, and the Embedding Service needs `embedding-service/dist/index.js`, `KOED_HOME/runtime/llama.cpp/llama-server`, and model assets. Packaged native runtime assets no longer include Python standalone files or `embedding-service/.venv/bin/python`; `KOED_EMBEDDING_PYTHON_BIN` is not used by the supported bundled-local path. The README Quickstart builds the workspace, runs runtime install, and installs the embedding model as `pnpm local:setup`. Packaged Desktop also checks packaged app resources after `KOED_HOME/runtime`. Source-checkout `vendor` and `apps/embedding-service` paths remain development fallbacks only; packaged mode rejects those fallbacks unless `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1` is set for developer diagnostics. `KOED_BUNDLED_POSTGRES_MODE` and `KOED_BUNDLED_EMBEDDING_MODE` are deprecated and ignored. Missing native resources fail with setup guidance instead of falling back to Docker Compose. Docker Compose is available only as an Operator-selected external dependency starter.

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

`desktop:package` and `desktop:package:smoke:mac` build unsigned local smoke artifacts. `desktop:package:internal:mac` prepares unsigned macOS `dmg` and `zip` outputs for internal testing, including packaged native runtime assets when `KOED_NATIVE_RUNTIME_SOURCE_DIR` is set. New GitHub Releases upload these unsigned Desktop assets and checksums after packaged-native smoke passes. Signed/notarized release artifacts still require future Developer ID credential setup.

Run the bundled-local smoke workflow to verify the native control-plane path
with an isolated temporary `KOED_HOME` and temporary host ports:

```bash
pnpm smoke:bundled-local -- --full --install-runtime --json
```

`--install-runtime` explicitly runs the Homebrew-backed runtime install for the
temporary `KOED_HOME` before native resource checks. The smoke workflow skips
explicit model installation unless `KOED_EMBEDDING_MODEL_URL` and
`KOED_EMBEDDING_MODEL_SHA256` are configured. `--full` adds API Token creation,
Capture Hook-like personal ingestion, Projection, local queue/embedding work,
Memory Answer evidence retrieval with a unique marker, Explorer reachability,
and cleanup through `koed-server stop --json`. Missing native binaries or model
assets fail clearly instead of falling back to Docker.

Packaged Desktop smoke now exercises the packaged Electron bundle with a temporary `KOED_HOME`, unsets `KOED_REPO_ROOT`, and verifies daemon start/status/reconnect/stop without checkout fallbacks. For CI or diagnostics when native assets are absent, run:

```bash
pnpm desktop:package:smoke:mac -- --missing-assets --json
```

When packaged native assets are staged, omit `--missing-assets` to let smoke install packaged runtime assets, start the daemon, and reach a healthy local stack. See `docs/desktop-internal-artifacts.md` for CI-uploaded unsigned DMG/ZIP download, install/open, Gatekeeper-warning, runtime status/doctor, and cleanup instructions.

If dependency ports conflict with another local app, start the external dependency stack with alternate host ports and pass matching explicit URLs to `koed-server`:

```bash
REDIS_HOST_PORT=16380 EMBEDDING_SERVICE_HOST_PORT=3801 docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
KOED_DEPENDENCY_MODE=external API_HOST_PORT=3300 EXPLORER_WEB_HOST_PORT=5574 REDIS_URL=redis://localhost:16380 EMBEDDING_SERVICE_URL=http://localhost:3801 node packages/koed-server/dist/cli.js start
```

The Explorer frontend is available at `http://localhost:5174`, or the host port
you selected, and is embedded by Koed Desktop.

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

The Homebrew staging helper copies Homebrew/Linuxbrew Postgres/pgvector and llama.cpp assets only. It no longer requires or packages an Embedding Service Python virtualenv, and it does not create release-quality redistributable native runtime assets.

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

Operate production and private VPS installs as `koed-server` plus dependencies.
Keep Postgres, Redis, and the Embedding Service private. Expose only the
browser/API-facing `koed-server` surface through your reverse proxy. Set strong
`API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`,
database password, and Redis password. Use TLS at the reverse proxy if the
server is reachable beyond localhost.
For hosted/private database role hardening and the RLS decision, see
[hosted-database-roles.md](hosted-database-roles.md).

Local personal deployments may keep operational Memory rows in Postgres unless
app-layer encryption is configured. Private VPS, Team Self-Hosted, and
Koed-managed cloud deployments should configure envelope encryption for
human-readable Memory and evidence payloads; queryable vectors still remain
sensitive trusted-boundary data. Protect the database and backups with private
networking, least-privilege credentials, encrypted storage, and restricted
administrator access.

Only `/health` and `/ready` are intended for unauthenticated infrastructure probes. They return coarse status and should not be used as operator diagnostics. `/v1/capabilities` is also unauthenticated, but it is a client discovery contract rather than a health check: clients can use it to detect the positive capabilities registered by the current backend, and should treat missing capabilities as unavailable. `status --json` and `doctor --json` use readiness gates for Postgres reachability/version, migrations, pgvector, work queue backend, Embedding Service model/dimensions, and registered upstream capability-cache state before reporting healthy; doctor output gives repair actions such as running migrations, enabling pgvector, fixing dependency URLs, refreshing upstream capabilities, or correcting model/runtime mismatch. Registered upstream backends are local edge metadata only: capability caches and route-policy state live under `KOED_HOME/config/upstream-backends.json`, while reusable upstream/device credentials must stay out of ordinary config. Detailed status endpoints such as `/health/details`, `/self-host/diagnostics`, and the authenticated view of `/self-host/status` should remain behind normal API authentication. Koed Desktop packaging/signing remains tracked separately from this local runtime path.

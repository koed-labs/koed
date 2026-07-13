# Configuration

Use `.env.example` as the canonical Koed environment example. It is the starting point for local and production deployments.

The README Quickstart covers the basic bundled-local setup and packaged Desktop first-run. This page is the advanced reference for environment variables, runtime modes, external dependency URLs, and production settings.

For any local deployment, start by running:

```bash
pnpm env:setup
```

This creates `.env` and generates `API_DATA_ENCRYPTION_KEY`,
`API_TOKEN_PEPPER`, `EMBEDDING_SERVICE_TOKEN`, and a local
`POSTGRES_PASSWORD`. If `.env` already exists, the command preserves existing
values and adds any missing keys from
`.env.example`.

For server/private VPS deployments, treat `koed-server` as the application
deployment unit and Postgres, queue backend, Embedding Service, reverse
proxy/TLS, and backup/restore jobs as dependencies. See
[server-deployment-boundary.md](server-deployment-boundary.md) for the
operator-facing boundary and migration notes.

## `koed-server` Dependency Ownership

`koed-server` reads `KOED_HOME/config/server.json` plus environment overrides.
Source checkouts default to `runtimeMode: "developer"` and
`dependencyMode: "external"`.

External dependency mode means the Operator manages Postgres, Redis/BullMQ, and
the Embedding Service lifecycle. The services may be launched by Docker Compose,
systemd, Homebrew, managed infrastructure, or another Operator-managed path.
`koed-server` connects to those services and supervises Koed app processes; it
does not start or stop Docker Compose in this mode.

Bundled-local dependency mode is a native local runtime for Postgres/pgvector and the Embedding Service. In this mode, `koed-server start` starts Koed-owned native runtimes under `KOED_HOME`; it never starts Docker Compose. API/Worker jobs default to `WORK_QUEUE_BACKEND=local`, so Redis is not required for queues unless the Operator explicitly sets `WORK_QUEUE_BACKEND=bullmq`. With BullMQ, Redis is Operator-managed external infrastructure. Native local personal mode stores data, queue state, logs, model files, Postgres data, and runtime state under `KOED_HOME`. This is not an asset, model, Homebrew, or system-service installer; required native binaries and model files still need to exist through the current local setup path.

Supported mode fields:

- `KOED_DEPLOYMENT_PROFILE`: capability profile reported by
  `/v1/capabilities`. Supported values are `developer`, `local_personal`,
  `private_vps`, `team_self_hosted`, and `koed_managed_cloud`. Hyphenated
  aliases such as `local-personal`, `private-vps`, `team-self-hosted`, and
  `koed-managed-cloud` are accepted. If omitted, `local-personal` runtime mode
  reports `local_personal`; other source checkout runs report `developer`.
- `KOED_RUNTIME_MODE`: `local-personal`, `external`, or `developer`.
- `KOED_DEPENDENCY_MODE`: `external` or `bundled-local`.
- `KOED_EXTERNAL_DATABASE_URL` or `DATABASE_URL`: Operator-managed Postgres URL in external mode.
- `KOED_EXTERNAL_REDIS_URL` or `REDIS_URL`: Operator-managed Redis/BullMQ URL when the queue backend is `bullmq`.
- `KOED_EXTERNAL_EMBEDDING_SERVICE_URL` or `EMBEDDING_SERVICE_URL`: Operator-managed Embedding Service URL in external mode.

Example external `KOED_HOME/config/server.json`:

```json
{
  "runtimeMode": "developer",
  "dependencyMode": "external",
  "external": {
    "databaseUrl": "postgres://koed:password@127.0.0.1:15432/koed",
    "redisUrl": "redis://127.0.0.1:16379",
    "embeddingServiceUrl": "http://127.0.0.1:3800"
  }
}
```

Example bundled-local `KOED_HOME/config/server.json`:

```json
{
  "runtimeMode": "developer",
  "dependencyMode": "bundled-local"
}
```

`koed-server status --json` and `doctor --json` report healthy only after
Postgres is reachable, Postgres version is compatible, migrations are current,
pgvector is enabled, the configured work queue backend is ready, and the
Embedding Service reports the expected model and dimensions. Doctor repair
actions point to migrations, pgvector setup, dependency URLs, queue backend, or
model/runtime mismatch.

## Local Edge Upstream Registry

Local edge `koed-server` stores remote/private/cloud upstream backend metadata
under `KOED_HOME/config/upstream-backends.json`. This registry is first-class
local configuration, not a loose environment-variable convention. It stores the
upstream id, display name, base URL, deployment profile, cached public
capabilities, validation timestamps, credential status/reference metadata, and
route-policy metadata.

The registry must not contain reusable upstream credentials, WorkOS secrets,
API Tokens, device secrets, bearer tokens, token prefixes, or database
credentials. Upstream URLs with username/password material, query strings, or
fragments are rejected. Remote upstreams must use HTTPS; HTTP is accepted only
for exact loopback targets (`localhost`, `127.0.0.1`, or `::1`) used by local
development. Upstream requests reject redirects so an accepted endpoint cannot
downgrade credential or Memory traffic. Device/upstream credential material is
handled by the separate credential model; this registry only records non-secret
existence and status metadata.

Live local-edge upstream proxying needs separate upstream relay authorization.
The registry may record a sanitized credential `reference`, but the reusable
secret must live in the encrypted local credential store or deployment secret
storage. Browser-mediated upstream enrollment writes a `keychain://koed-upstream/...`
reference into the registry and stores the reusable device secret separately
under `KOED_HOME/secrets` with owner-only file permissions. At runtime the API
resolves that reference from the local credential store; when no reference is
configured it falls back to `KOED_UPSTREAM_CREDENTIAL_<BACKEND_ID>`, where the
backend id is uppercased and non-alphanumeric characters become `_`. The value
may be a full `Bearer ...` or `Koed-Device ...` authorization header, or a
`key:secret` value which is sent as `Koed-Device key:secret`. Local browser
session cookies and personal API Tokens are never forwarded upstream.

Supported commands:

```bash
koed-server upstream register --url https://koed.example.test --id team-vps --name "Team VPS" --profile private_vps --json
koed-server upstream list --json
koed-server upstream refresh --id team-vps --json
koed-server upstream policy --id team-vps --team-workspace-read enabled --share-grant-management enabled --json
koed-server upstream enroll start --id team-vps --json
koed-server upstream enroll status --id team-vps --json
koed-server upstream enroll cancel --id team-vps --json
koed-server upstream disconnect --id team-vps --json
koed-server upstream remove --id team-vps --json
```

Capability refresh calls the upstream public `/v1/capabilities` endpoint,
requires the versioned Koed capability schema, and records `validated`,
`stale`, `failed`, or `not_checked` cache state. The cache expires after the
local freshness window and status/doctor report stale or failed caches as
attention items. Route-policy defaults are fail-closed: registering an upstream
does not enable capture-bearing writes, Team Workspace recall, Share Grant
management, sync/offload, or admin operations. Operators must explicitly enable
allowed operation families with `koed-server upstream policy`; later routing and
sync work must consume the cached capabilities and route policy before enabling
remote-dependent surfaces.

Enrollment orchestration state is separate from the upstream backend registry.
`upstream enroll start/status/cancel` and `upstream disconnect` record only
non-secret local state under `KOED_HOME/run/upstream-enrollments.json`, including
state, requested operation families, timestamps, and credential status/reference
metadata. `upstream enroll start` creates a short-lived browser approval
challenge on the upstream backend and prints the activation URL. After the user
approves the challenge in a browser session, `upstream enroll status` validates
the scoped device credential with the upstream backend and marks the local
backend credential configured. API Tokens remain personal AI-client
compatibility credentials. Team Workspace recall through MCP uses a distinct
Local-Edge Client Credential scoped to the selected backend and
`team_workspace_read`. The local edge validates that credential, then uses the
separate enrolled upstream device credential without exposing it to MCP. A
Personal API Token alone is rejected from Team, Share Grant, sync, and admin
operation families.

## KOED_HOME Layout

Koed-owned local state lives under `KOED_HOME`:

- `config/` for `server.json`, `local-ports.json`, `explorer-token.json`,
  local Project metadata in `projects.json`, and Project-to-Team Workspace
  mappings in `project-team-workspaces.json`
- `run/` for `koed-server.json`, `last-verification.json`, upstream enrollment
  orchestration state, and native runtime state
- `logs/` for service logs, including `postgres.log`
- `data/` for native database files, including `data/postgres`
- `models/` for embedding and reranker model files
- `cache/` for installer metadata and downloaded artifact cache
- `runtime/` for bundled or packaged native runtime binaries

Packaged Desktop, headless local-personal startup, and repair commands all read and write this same layout.

## Platform Expectations

- macOS: packaged Desktop and bundled-local provisioning path.
- Linux and WSL: headless development, smoke, and the same CLI contracts when bundled-local runtime assets are available. Packaged Linux native assets require glibc 2.35+ on Ubuntu 22.04/Debian 12 or newer. Keep `KOED_HOME` and checkout paths on Linux filesystem paths inside WSL, not `/mnt/<drive>`.
- Native Windows packaged app support: not shipped in this build; use WSL for local development. Windows host browsers can reach Koed through WSL localhost forwarding when available, or by browsing the WSL IP directly as a fallback.

## Required Deployment Values

- `POSTGRES_DB`: Postgres database name used by Docker Compose.
- `POSTGRES_USER`: Postgres user used by Docker Compose.
- `POSTGRES_PASSWORD`: Postgres password. `pnpm env:setup` generates this for
  local Docker Compose deployments. Use a deployment-specific secret for
  production.
- `POSTGRES_HOST_PORT`: host port mapped to the Postgres container.
- `DATABASE_URL`: local Postgres URL used by operator scripts such as
  `pnpm api-token:create`. Docker Compose derives service-internal database URLs
  from `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`. Hosted
  `koed-server` traffic should use the runtime Postgres role; use the migration
  role only for `pnpm --filter @koed/db migrate:up`. See
  [hosted-database-roles.md](hosted-database-roles.md).
- `API_NODE_ENV`: runtime environment for the internal API app. Use
  `production` for deployed `koed-server` runs.
- `API_HOST`: API bind host for direct local runs. Defaults to `127.0.0.1` in development and `0.0.0.0` in production. Override only when you intentionally want LAN access.
- `API_HOST_PORT`: host port used by the local API process supervised by `koed-server`. The API listens on process-local `API_PORT`.
- `API_LOG_LEVEL`: API log level. See [observability](observability.md) for
  the structured API log schema and redaction rules.
- `API_DATA_ENCRYPTION_KEY`: base64 32-byte key used by the `local_test_key`
  envelope provider for local development, private/operator-managed, and non-paid
  operator-managed deployments. It is not the paid Koed-managed cloud KMS.
- `API_ENVELOPE_ENCRYPTION_PROVIDER`: envelope provider mode. Defaults to
  `local_test_key`; paid Koed-managed cloud must use a KMS-backed mode:
  `managed_kms`, `byok`, or `cmek`. Premium customer-controlled modes `byok`
  and `cmek` use the same provider contract but require a customer
  key-reference onboarding flow before use. `operator_kms` is reserved for
  Team Self-Hosted/private VPS KMS integration and is not implemented in this
  build.
- `KOED_MANAGED_CLOUD_RELEASE_STAGE`: `alpha` or `paid`. Team Self-Hosted,
  private VPS, and Koed-managed cloud profiles store new human-readable Memory
  payloads through encrypted field companions and keep operational source
  columns redacted. When this is set to `paid` with
  `KOED_DEPLOYMENT_PROFILE=koed_managed_cloud`, the API and Worker refuse to
  start unless `API_ENVELOPE_ENCRYPTION_PROVIDER` is KMS-backed.
- `MANAGED_KMS_KEY_ID` and `MANAGED_KMS_KEY_VERSION`: safe managed KMS key
  reference metadata required when the API or Worker is configured for
  `managed_kms`, `byok`, or `cmek`.
- `MANAGED_KMS_ENDPOINT_URL` and `MANAGED_KMS_AUTH_TOKEN`: managed KMS
  wrap/unwrap endpoint and bearer credential for the generic HTTPS KMS adapter.
  The endpoint must use HTTPS unless it targets localhost for local tests. KMS
  credentials and key material must live in deployment secret management, not in
  app rows, diagnostics, logs, or client-visible configuration.
  After a KMS key version is rotated, run `pnpm hosted:encryption-rewrap` in
  bounded batches to rewrap encrypted-field DEKs to the configured current key
  version without rewriting plaintext payload bytes.
- `API_TOKEN_PEPPER`: server-side pepper used when hashing API Tokens.
- `API_CORS_ORIGINS`: comma-separated allowed browser origins, such as the Explorer.
- `EXPLORER_WEB_HOST`: host used by the Explorer preview process supervised by
  `koed-server`. Defaults to `127.0.0.1` for local runs; server/container
  wrappers may set `0.0.0.0` and publish the port through the wrapper boundary.
- `API_REQUEST_BODY_LIMIT_BYTES`: maximum API request body size. Default `4194304`.
- `API_AUTH_RATE_LIMIT_WINDOW_MS`: auth rate-limit window.
- `API_AUTH_RATE_LIMIT_MAX`: auth requests allowed per window.
- `API_MEMORY_RATE_LIMIT_WINDOW_MS`: fallback API-token memory rate-limit window. The default window is 60 seconds.
- `API_MEMORY_RATE_LIMIT_MAX`: fallback API-token memory requests allowed per window. The default is 1000 requests per 60-second window, which is intended to absorb local Explorer and MCP Server bursts in a Koed deployment without changing the stricter auth rate limit.
- `API_MEMORY_WRITE_RATE_LIMIT_MAX`: write-oriented memory requests allowed per window. The window uses `API_MEMORY_RATE_LIMIT_WINDOW_MS`; the default max is 300 requests per 60-second window.
- `API_MEMORY_RECALL_RATE_LIMIT_MAX`: recall-oriented memory requests allowed per window. The window uses `API_MEMORY_RATE_LIMIT_WINDOW_MS`; the default max is 300 requests per 60-second window.
- `API_RATE_LIMIT_STORE`: `memory` by default; set `redis` to share API rate-limit counters across API replicas.
- `API_RATE_LIMIT_REDIS_URL`: optional Redis URL for API rate-limit counters; falls back to `REDIS_URL`.
- `API_CACHE_STORE`: `memory` by default; set `redis` to enable short-lived graph response caching.
- `API_CACHE_REDIS_URL`: optional Redis URL for API cache entries; falls back to `REDIS_URL`.
- `API_GRAPH_CACHE_TTL_SECONDS`: graph overview/thread cache TTL when Redis caching is enabled.
- `API_GRAPH_UPDATE_DEBOUNCE_MS`: debounce window for coalescing graph stream update events.
- `API_MEMORY_EVENT_GRAPH_UPDATE_DEBOUNCE_MS`: shorter debounce window for captured event stream updates that drive the open history thread.
- `API_COOKIE_SECURE`: set `true` behind HTTPS; local HTTP development may use `false`.
- `KOED_BACKUP_STATUS_PATH`: optional path to a redacted JSON backup status file consumed by `/ops/status`. When omitted, backup freshness is reported as `not_configured`.
- `KOED_BACKUP_MAX_AGE_SECONDS`: maximum acceptable age for `lastSuccessfulAt` in the backup status file. Default `86400`.
- `KOED_OPS_REQUEST_METRICS_STATUS_PATH`: optional path to a redacted JSON request-metrics status file consumed by `/ops/status`. This is the integration point for reverse proxy, load balancer, or external telemetry jobs that calculate request latency and error-rate health.
- `KOED_OPS_REQUEST_METRICS_MAX_AGE_SECONDS`: maximum acceptable age for `checkedAt` in the request-metrics status file. Default `300`.
- `KOED_OPS_MAX_RSS_BYTES`: maximum acceptable API process resident set size before `/ops/status` reports runtime resource pressure. Default `1610612736`.
- `KOED_OPS_OPERATOR_EMAILS`: comma-separated allowlist of browser-session email addresses that may access hosted `/ops/status` and `/ops/test-alert` in `private_vps`, `team_self_hosted`, and `koed_managed_cloud` profiles. Local personal/developer profiles do not require this allowlist.
- `KOED_RUNBOOK_BASE_URL`: optional base URL used by `/ops/status` to attach runbook links to generated operational alerts.
- `KOED_OPS_ALERT_WEBHOOK_URL`: optional HTTPS webhook endpoint used by `/ops/test-alert` to validate alert delivery. `/ops/status` reports only that a webhook sink is configured; it does not disclose the URL.
- `KOED_OPS_ALERT_WEBHOOK_TOKEN`: optional bearer token sent only to `KOED_OPS_ALERT_WEBHOOK_URL` during test-alert delivery. It must not appear in `/ops/status`, `/ops/test-alert` responses, diagnostics, logs, or support exports.
- `KOED_CAPACITY_API_TOKEN`: optional API Token consumed by `pnpm hosted:capacity -- run` for personal capture and recall load checks.
- `KOED_CAPACITY_SESSION_COOKIE`: optional browser session Cookie header consumed by `pnpm hosted:capacity -- run` for private operations-status and Team Workspace recall load checks.
- `KOED_CAPACITY_DEVICE_CREDENTIAL`: optional scoped `Koed-Device` credential consumed by `pnpm hosted:capacity -- run` for Team Workspace device-route and local-edge proxy load checks.
- `KOED_CAPACITY_TEAM_WORKSPACE_ID`: optional Team Workspace id consumed by `pnpm hosted:capacity -- run` for Team Workspace recall and local-edge proxy scenarios.
- `KOED_CAPACITY_UPSTREAM_BACKEND_ID`: optional local-edge upstream backend id consumed by `pnpm hosted:capacity -- run --scenario local-edge-team-proxy`.
- `KOED_LAUNCH_BASE_URL`: optional running API target consumed by `pnpm team-launch:validate --with-staged-remote`.
- `KOED_LAUNCH_SESSION_COOKIE`: optional browser session Cookie header consumed by staged launch validation for Team Workspace routes.
- `KOED_LAUNCH_DEVICE_CREDENTIAL`: optional scoped `Koed-Device` credential consumed by staged launch validation for Team Workspace routes.
- `KOED_LAUNCH_API_TOKEN`: optional API Token consumed by staged launch validation to prove Team Workspace recall rejects API Tokens.
- `KOED_LAUNCH_TEAM_WORKSPACE_ID`: optional Team Workspace id consumed by staged launch validation; defaults to the synthetic fixture Workspace.
- `KOED_LAUNCH_TEAM_NODE_ID`: optional Memory node id consumed by staged launch validation; defaults to a synthetic fixture node.
- `KOED_LAUNCH_LOCAL_EDGE_BASE_URL`: optional local-edge API target consumed by staged launch validation for proxy probes.
- `KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID`: optional registered upstream backend id consumed by staged launch validation for proxy probes.
- `WORKOS_AUTHKIT_ENABLED`: set `true` on Team Self-Hosted or Koed-managed cloud backends that use WorkOS/AuthKit for browser-session identity. The backend still uses Koed Team Membership, Workspace Access, Share Grants, lifecycle state, and entitlement records for Memory authorization.
- `WORKOS_CLIENT_ID`: WorkOS/AuthKit client id used to build `/auth/workos/login` authorization redirects.
- `WORKOS_API_KEY`: WorkOS server API key used only by `koed-server`/API when exchanging an AuthKit callback code. It must not be exposed to Explorer, MCP Server, Capture Hook, upstream registries, logs, or diagnostics.
- `WORKOS_REDIRECT_URI`: absolute callback URL registered with WorkOS, normally ending in `/auth/workos/callback`.
- `WORKOS_PROVIDER_ENVIRONMENT`: stable namespace for WorkOS identity mappings, such as `production`, `staging`, or `default`. Provider user ids are unique only inside this namespace.

`KOED_BACKUP_STATUS_PATH` should point to JSON written by the deployment's
backup verification job. See [hosted backups](hosted-backups.md) for the
operator runbook. Example status payload:

```json
{
  "status": "ok",
  "provider": "pgbackrest",
  "checkedAt": "2026-07-03T10:00:00.000Z",
  "lastSuccessfulAt": "2026-07-03T09:55:00.000Z"
}
```

The file must not contain storage credentials, customer data, raw Memory,
database URLs, or backup object paths with embedded secrets.

`KOED_OPS_REQUEST_METRICS_STATUS_PATH` should point to redacted JSON written by
deployment telemetry or a scheduled probe. Example payload:

```json
{
  "status": "ok",
  "checkedAt": "2026-07-03T10:00:00.000Z",
  "windowSeconds": 60,
  "requestRatePerSecond": 12.5,
  "p95LatencyMs": 250,
  "p99LatencyMs": 400,
  "errorRate": 0.001
}
```

The file must not contain request bodies, prompts, raw Memory, cookies, API
Tokens, provider secrets, IP addresses unless explicitly approved by deployment
policy, or full URLs containing customer content.

- `EXPLORER_NODE_ENV`: runtime environment for the Explorer service.
- `EXPLORER_API_BASE_URL`: browser-visible API base URL used when building the Explorer.
- `EXPLORER_WEB_HOST_PORT`: host port used by the local Explorer preview process supervised by `koed-server`.
- `REDIS_HOST_PORT`: host port mapped to the Redis dependency container when using the Docker Compose starter. Default `16379`.
- `REDIS_URL`: explicit Redis/BullMQ URL consumed by `koed-server`, API, and Worker in external dependency mode when `WORK_QUEUE_BACKEND=bullmq`. For the Docker Compose starter, use `redis://localhost:${REDIS_HOST_PORT}`.
- `WORK_QUEUE_BACKEND`: `bullmq` by default for Redis/BullMQ queues. Set `local` to use the Postgres-backed `local_work_queue` table for API/Worker jobs; this does not require Redis for job queues, though Redis may still be used for rate-limit or cache stores if configured.
- `EMBEDDING_SERVICE_HOST_PORT`: host port mapped to the Embedding Service dependency container when using the Docker Compose starter. Default `3800`.
- `EMBEDDING_SERVICE_URL`: explicit Embedding Service URL consumed by `koed-server`, API, and Worker in external dependency mode. For the Docker Compose starter, use `http://localhost:${EMBEDDING_SERVICE_HOST_PORT}`.
- `KOED_MODELS_DIR`: optional shared model directory for bundled-local model install and Docker Compose model mounts. Defaults to `KOED_HOME/models`.
- `KOED_EMBEDDING_MODEL_URL` / `KOED_EMBEDDING_MODEL_SHA256`: optional custom artifact URL and expected SHA-256 used by `koed-server models install --kind embedding`. When unset, Koed installs the default pinned Qwen embedding model. Install writes to `KOED_MODELS_DIR`/`KOED_HOME/models` unless `KOED_EMBEDDING_MODEL_PATH` overrides the destination.
- `KOED_RERANKER_MODEL_URL` / `KOED_RERANKER_MODEL_SHA256`: artifact URL and expected SHA-256 used by `koed-server models install --kind reranker`. Install writes to `KOED_MODELS_DIR`/`KOED_HOME/models` unless `KOED_RERANKER_MODEL_PATH` overrides the destination.
- `KOED_BUNDLED_POSTGRES_MODE`: deprecated. Bundled-local Postgres is native-only; `compose` is ignored and missing native binaries report setup guidance.
- `KOED_POSTGRES_BIN_DIR`: directory containing native `initdb`, `pg_ctl`, `psql`, `pg_dump`, and `pg_restore` binaries for bundled-local Postgres. Defaults to `KOED_HOME/runtime/postgres/bin`, then packaged Desktop resources when running packaged Desktop, with source-checkout `vendor/postgres/bin` only as a development fallback. Individual startup binary overrides are also available with `KOED_POSTGRES_INITDB_BIN`, `KOED_POSTGRES_PG_CTL_BIN`, and `KOED_POSTGRES_PSQL_BIN`; hosted backup commands may use `PSQL_BIN`, `PG_DUMP_BIN`, and `PG_RESTORE_BIN` for external database operators.
- `KOED_POSTGRES_DATA_DIR`, `KOED_POSTGRES_RUN_DIR`, `KOED_POSTGRES_LOG_PATH`: optional native bundled-local Postgres data, socket/runtime, and log paths. Defaults live under `KOED_HOME`.
- `KOED_BUNDLED_EMBEDDING_MODE`: deprecated. Bundled-local Embedding Service is native-only; `compose` is ignored and missing native assets report setup guidance.
- `KOED_EMBEDDING_LLAMA_SERVER_BIN`: llama-server executable for the native bundled-local Embedding Service. Defaults to `KOED_HOME/runtime/llama.cpp/llama-server`, then packaged Desktop resources when running packaged Desktop, with source-checkout `vendor/llama.cpp/llama-server` only as a development fallback; the Docker default `EMBEDDING_LLAMA_SERVER_BINARY=/opt/llama.cpp/llama-server` is ignored for native auto-detection unless overridden with this setting.
- `KOED_PACKAGED_DESKTOP=1`: selects packaged Desktop resolver behavior. Packaged mode does not use source-checkout fallbacks unless `KOED_ALLOW_PACKAGED_SOURCE_FALLBACK=1` is set for developer diagnostics. `status --json` and `doctor --json` include runtime artifact source diagnostics such as `koed-home-runtime`, `packaged-resource`, or `source-checkout`.
- `KOED_EMBEDDING_HOST`, `KOED_EMBEDDING_PORT`: host and port for the native bundled-local Embedding Service. Defaults to `127.0.0.1` and `EMBEDDING_SERVICE_HOST_PORT`/`3800`.
- `koed-server runtime status --provider homebrew --json`: macOS, Linux, and WSL diagnostic command for Homebrew-backed native runtime assets. It does not install packages or mutate Homebrew state.
- `koed-server runtime install --provider homebrew --dependency-mode bundled-local --json`: explicit macOS, Linux, and WSL install command that may run Homebrew for missing `postgresql@17`, `pgvector`, and `llama.cpp`, links selected binaries under `KOED_HOME/runtime`, and writes metadata under `KOED_HOME/cache`.
- `VITE_KOED_API_TOKEN`: optional Explorer build-time token used to prefill the browser app. `koed-server` also writes the app-provisioned Explorer credential under `KOED_HOME/config/explorer-token.json` so status can report whether the desktop happy path has a credential without exposing the API Token.
- `WORKER_NODE_ENV`: runtime environment for the worker service.
- `MEMORY_RAW_PROJECTION_INTERVAL_MS`: worker interval for projecting pending raw `conversation_items` into messages, tool events, Memory Events, and token-usage rows. Default `5000`.
- `MEMORY_RAW_PROJECTION_BATCH_LIMIT`: maximum raw rows projected per actor on each worker catch-up pass. Default `1000`.
- `MEMORY_RAW_PROJECTION_ACTOR_LIMIT`: maximum memory owner scopes checked on each worker catch-up pass. Default `10`.
- `MEMORY_VECTOR_CANDIDATE_LIMIT`: vector retrieval candidate count.
- `MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT`, `MEMORY_RAG_LEAF_CANDIDATE_LIMIT`, `MEMORY_RAG_FRESH_EVENT_CANDIDATE_LIMIT`, `MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT`, `MEMORY_RAG_LEXICAL_CANDIDATE_LIMIT`, `MEMORY_RAG_SCOPED_LEAF_CANDIDATE_LIMIT`: optional per-stage retrieval candidate limits. Leave blank to use code defaults derived from the requested result limit.
- `MEMORY_RAG_ROLLUP_RESULT_LIMIT`: optional cap on rollup results admitted into final recall evidence.
- `MEMORY_RAG_RAW_FALLBACK_ENABLED`: set `false` to disable raw fallback retrieval.
- `MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED`: explicit opt-in for plaintext
  `lexical_search`. Koed-managed cloud disables plaintext lexical search by
  default because encrypted Memory text should not be searched through raw
  plaintext SQL columns. Leave unset for the profile default.
- `MEMORY_RAG_ROLLUP_MIN_SCORE`, `MEMORY_RAG_SCOPED_LEAF_MIN_SCORE`, `MEMORY_RAG_LEAF_MIN_SCORE`, `MEMORY_RAG_FRESH_EVENT_MIN_SCORE`, `MEMORY_RAG_RAW_FALLBACK_MIN_SCORE`: optional per-stage minimum score thresholds. Leave blank to use the default threshold of `0`.
- `MEMORY_EVENT_MAX_TOKENS`: soft token target for projected semantic Memory Event bundle rollover. Default `2048`; values above `32768` are clamped to the Qwen operational cap. Projection rolls over only between complete source items at this target.
- `MEMORY_AGENT_TURN_STALE_MS`: quiet-time fallback for sealing an incomplete agent-turn Memory Event during catch-up if no turn-complete Capture Hook or next user prompt arrives. Default `900000` (15 minutes). Set `0` only in tests or controlled recovery runs to seal any incomplete agent turn immediately.
- `SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS`: debounce before rebuilding and re-embedding semantic Memory Events after a display item is deleted. Default `300000` (5 minutes). Set `0` only in tests or controlled repair runs.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`: event count threshold for creating LCM placeholders. Default `100`.
- `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`: semantic `memory_event.content` token threshold for creating LCM placeholders. Default `32768`; values above `32768` are clamped to the Qwen operational cap. Provenance payload JSON is not counted.
- `MEMORY_LCM_FRESH_EVENT_TAIL`: recent event tail excluded from LCM placeholder creation. Default `10`.
- `MEMORY_LCM_DEPTH1_FANOUT`: leaf fanout for depth-1 LCM placeholder creation. Default `20`.
- `EMBEDDING_MODEL_KEY`: supported embedding model key. The embedding service maps this key to an internal supported model definition and fails startup for unknown keys. Default and currently supported key: `qwen3-0.6b`.
- `EMBEDDING_RERANKER_KEY`: supported reranker model key. Leave blank to disable reranking. Currently supported key: `qwen3-reranker-0.6b`. Docker Compose maps this root setting to each app's process-local `RERANKER_KEY`; direct app-local runs may set `RERANKER_KEY` explicitly, with the app-local value taking precedence.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token required by embedding and reranking endpoints when configured. `pnpm env:setup` generates this for Docker Compose deployments.
- `EMBEDDING_SERVICE_HEALTH_TIMEOUT_MS`: timeout for API/worker embedding service health probes used by status and access-check routes. Default `1000`.
- `EMBEDDING_QUERY_INSTRUCTION_ENABLED`: whether semantic recall query embeddings use the Qwen-style `Instruct: ...\nQuery: ...` wrapper. Default `true` for Qwen3 embedding models. Set `false` to compare retrieval or benchmark behavior without query instructions. Stored Memory Event, Memory Node, message, and other source embeddings are not prefixed.
- `EMBEDDING_QUERY_INSTRUCTION`: optional instruction text for semantic recall query embeddings. Leave blank to use the Koed default instruction for retrieving relevant Memory Events, conversation items, and summaries.
- `EMBEDDING_LOG_LEVEL`: embedding service structured JSON log level. Default `info`; use `debug` for scheduler, chunking, batching, and reranker scoring details.
- `EMBEDDING_BATCH_LIMIT`: embedding service batch limit.
- `EMBEDDING_MAX_TOKENS`: Koed adapter chunking limit and the hard cap for a single projected source item before forced split metadata is used. Default `4096`; values above `32768` are clamped by the embedding service and values above the configured llama context or batch envelope are reduced to that limit.
- `EMBEDDING_MAX_TEXT_CHARS`: transport and abuse guard for the maximum characters accepted for any single embedding or reranking text before model processing. It is not a semantic chunking limit.
- `EMBEDDING_MAX_REQUEST_CHARS`: transport and abuse guard for the maximum total characters accepted for one embedding or reranking request before model processing. It is not a semantic chunking limit.
- `EMBEDDING_LLAMA_N_CTX`: llama.cpp context size for the embedding service. Default `32768`; values above `32768` are clamped by the embedding service.
- `EMBEDDING_LLAMA_N_BATCH`: llama-server execution batch capacity. This is a runtime throughput and capacity knob, not Koed's semantic chunk size; keep it large enough for `EMBEDDING_MAX_TOKENS` plus batching/headroom.
- `EMBEDDING_LLAMA_BATCH_TOKEN_HEADROOM`: token safety margin subtracted from `EMBEDDING_LLAMA_N_BATCH` when chunking and batching embedding texts. Default `8`; this avoids tokenizer boundary cases where a nominal 8192-token text becomes 8193 tokens at model execution time.
- `EMBEDDING_RERANKER_BATCH_LIMIT`: reranker batch limit.
- `EMBEDDING_RERANKER_CONTEXT_PER_SLOT`: reranker context budget per llama-server parallel slot. This is separate from embedding context because Qwen reranking scores query-document classifier prompts, not embedding chunks.
- `EMBEDDING_RERANKER_LLAMA_N_CTX`: optional total reranker llama-server context override. Leave blank to derive it from `EMBEDDING_RERANKER_CONTEXT_PER_SLOT * EMBEDDING_RERANKER_PARALLEL`.
- `EMBEDDING_RERANKER_LLAMA_N_THREADS`: optional reranker thread override. Leave blank to use the embedding service thread default.
- `EMBEDDING_RERANKER_LLAMA_N_BATCH`: reranker logical batch size. It must cover the largest formatted query-document prompt you intend to score.
- `EMBEDDING_RERANKER_LLAMA_N_UBATCH`: reranker physical microbatch size. Tune this for CPU performance and memory, but keep it large enough for the largest formatted query-document prompt; llama-server rejects oversized rerank pairs.
- `EMBEDDING_RERANKER_PARALLEL`: reranker llama-server parallel slot count.
- `EMBEDDING_RERANKER_PROMPT_CACHE_ENABLED`: enables llama-server prompt caching for reranking. Default `true`; benchmark both modes explicitly because same-query rerank requests can reuse the shared instruction/query prefix.

## AI Client Values

These values are copied into the AI Client configuration and are not consumed automatically by Docker Compose:

- `MEMORY_API_URL`: API URL used by the MCP Server and Supported Capture Hook.
- `MEMORY_API_TOKEN`: API Token created with `pnpm api-token:create` for the User. Operators can inspect and revoke local token records with `pnpm api-token:list` and `pnpm api-token:revoke`.
- `MEMORY_HOOK_STRICT`: when `true`, Capture Hook failures exit non-zero.
- `MEMORY_RAW_INGEST_BATCH_BYTES`: target maximum request size for Capture Hook raw-ingestion batches. Default `180000`.
- `MEMORY_API_REQUEST_TIMEOUT_MS`: timeout for local MCP Server API calls. Default `60_000`.
- `MEMORY_HOOK_API_REQUEST_TIMEOUT_MS`: short timeout for legacy foreground Capture Hook API calls. Detached transcript catch-up uses `MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS`. Default `1500`.
- `MEMORY_HOOK_BREAKER_FAILURE_THRESHOLD`: consecutive retryable detached catch-up API failures before local latency protection opens. Default `3`.
- `MEMORY_HOOK_BREAKER_COOLDOWN_MS`: cooldown before an open catch-up breaker retries `/v1/access/check` as its health signal. Default `60000`.
- `MEMORY_HOOK_DEADLINE_MS`: soft deadline used by legacy foreground Capture Hook work. Signal-only hooks return after launching detached catch-up. Default `8500`.
- `MEMORY_HOOK_TRANSCRIPT_TAIL_BYTES`: maximum sequential Codex transcript bytes processed by one background catch-up pass. The hook checkpoints transcript offsets only after raw rows are stored durably. Default `1000000`.
- `MEMORY_TRANSCRIPT_FIRST_CONTACT_GRACE_MS`: timestamp grace window used only when live capture sees a transcript with no prior checkpoint. Koed reads the transcript tail, keeps only timestamped rows newer than the hook signal minus this window, and checkpoints to the current end of file. Historical import should be run explicitly instead of relying on live capture. Default `30000`.
- `MEMORY_HOOK_FOREGROUND_TRANSCRIPT_TAIL_BYTES`: deprecated; foreground hooks no longer parse transcript tails.
- `MEMORY_HOOK_TRIGGER_TRANSCRIPT_CATCHUP`: when `true`, foreground hooks start a detached local transcript catch-up process. Default `true`.
- `MEMORY_TRANSCRIPT_CATCHUP_API_REQUEST_TIMEOUT_MS`: API request timeout used by detached transcript catch-up. This stays longer than the foreground hook timeout so recovery can complete durable raw ingestion after the hook process has returned. Default `60000`.
- `MEMORY_TRANSCRIPT_CATCHUP_PASS_DEADLINE_MS`: soft deadline for one background transcript catch-up API pass. Default `60000`.
- `MEMORY_TRANSCRIPT_CATCHUP_MAX_RUNTIME_MS`: maximum runtime for one detached transcript catch-up process before the next hook may resume it. Default `300000`.
- `MEMORY_TRANSCRIPT_CATCHUP_LOCK_TTL_MS`: stale lock age for detached transcript catch-up workers. Default `600000`.
- `MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS`: when `true`, exposes diagnostic MCP tools such as `memory_access_check`. Default `false`; use the MCP `doctor` CLI command for normal setup checks.
- `MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS`: when `true`, exposes low-level diagnostic MCP retrieval tools such as `memory_search` and `memory_expand`. Default `false`; normal recall should use `memory_answer`.
- `MEMORY_HOOK_TRIGGER_LCM_SUMMARY`: when `true`, the Capture Hook starts local memory processing after capture. The command first generates pending captured-session titles, then processes pending LCM summaries.
- `MEMORY_HOOK_LCM_SUMMARY_DELAY_MS`: delay before Capture Hook-triggered local memory processing.
- `MEMORY_HOOK_LCM_SUMMARY_LIMIT`: maximum pending LCM summaries processed from a Capture Hook trigger. Session-title processing uses its own batch limit.
- `MEMORY_CODEX_APP_SERVER_BINARY`: Codex app-server binary used by local Synthesis flows. Default `codex`.
- `MEMORY_ANSWER_BRIDGE_ENABLED`: when `true`, MCP startup runs the local browser Memory Answer bridge. Default `true`.
- `MEMORY_ANSWER_BRIDGE_HOST`: local answer bridge bind host. Default `0.0.0.0`.
- `MEMORY_ANSWER_BRIDGE_PORT`: local answer bridge port used by the Explorer. Default `3210`.
- `MEMORY_ANSWER_BRIDGE_CORS_ORIGINS`: comma-separated browser origins allowed to call the local answer bridge.
- `MEMORY_ANSWER_PROVIDER`: AI Client provider for MCP Memory Answer synthesis. Default and only supported value: `codex`.
- `MEMORY_ANSWER_MODEL`: Codex model for MCP Memory Answer synthesis.
- `MEMORY_ANSWER_REASONING_EFFORT`: Codex reasoning effort for MCP Memory Answer synthesis.
- `MEMORY_ANSWER_TIMEOUT_MS`: timeout for each local MCP Memory Answer app-server turn.
- `MEMORY_ANSWER_MAX_ATTEMPTS`: maximum local MCP Memory Answer synthesis attempts.
- `MEMORY_ANSWER_MAX_SEARCHES`: maximum Koed RAG search tool calls per MCP Memory Answer worker turn.
- `MEMORY_ANSWER_MAX_EXPANSIONS`: maximum Koed RAG evidence expansion tool calls per MCP Memory Answer worker turn.
- `MEMORY_MANUAL_ANSWER_PROVIDER`: AI Client provider for Explorer manual Memory Questions. Default and only supported value: `codex`.
- `MEMORY_MANUAL_ANSWER_MODEL`: default Codex model for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_MODEL`.
- `MEMORY_MANUAL_ANSWER_REASONING_EFFORT`: default reasoning effort for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_REASONING_EFFORT`.
- `MEMORY_MANUAL_ANSWER_TIMEOUT_MS`: default timeout for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_TIMEOUT_MS`.
- `MEMORY_MANUAL_ANSWER_MAX_ATTEMPTS`: default retry attempts for Explorer manual Memory Questions. Leave blank to inherit `MEMORY_ANSWER_MAX_ATTEMPTS`.
- Manual Memory Question model and reasoning options are read from Codex app-server `model/list`; `.env` only provides the initial default selection.
- `MEMORY_QUESTION_ANSWER_MAX_ATTEMPTS`: bridge-level retry cap for older pending question rows without per-question max attempts.
- `MEMORY_QUESTION_ANSWER_LOCAL_LEASE_SECONDS`: short renewable lease used when the local bridge claims a pending manual Memory Question.
- `MEMORY_LCM_SUMMARY_PROVIDER`: AI Client provider for LCM Summary synthesis. Default and only supported value: `codex`.
- `MEMORY_LCM_SUMMARY_MODEL`: Codex model for LCM Summary synthesis.
- `MEMORY_LCM_SUMMARY_REASONING_EFFORT`: Codex reasoning effort for LCM Summary synthesis.
- `MEMORY_LCM_SUMMARY_TIMEOUT_MS`: timeout for each local LCM Summary app-server turn.
- `MEMORY_LCM_SUMMARY_MAX_ATTEMPTS`: maximum local LCM Summary synthesis attempts.
- `MEMORY_LCM_SUMMARY_RETRY_DELAY_MS`: delay between local LCM Summary retry attempts.
- `MEMORY_LCM_SUMMARY_CONCURRENCY`: maximum concurrent local LCM Summary workers.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: maximum prompt budget for local Codex LCM Summary calls. Default `48000`.
- `MEMORY_LCM_BACKGROUND_INITIAL_DELAY_MS`: delay before the MCP-local memory processing service first checks for pending work.
- `MEMORY_LCM_BACKGROUND_PUSH_DELAY_MS`: delay used when the local service is nudged after capture.
- `MEMORY_LCM_BACKGROUND_INTERVAL_MS`: periodic background check interval for pending summaries.
- `MEMORY_LCM_BACKGROUND_BATCH_LIMIT`: maximum pending LCM summaries processed in one background batch.
- `MEMORY_SESSION_TITLE_BACKGROUND_BATCH_LIMIT`: maximum pending captured-session titles processed in one local memory processing batch.
- `MEMORY_SESSION_TITLE_MIN_USER_EVENTS`: minimum user events before a captured session is eligible for local generated title processing. Default `3`.

Configure Codex to run the Supported Capture Hook for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop`. The subagent hooks let Koed preserve child conversation identity and parent linkage for thread-spawned Codex subagents.

Koed relies on the connected AI Client for Synthesis; backend LLM provider configuration and server-side synthesis are unsupported in this build.
The MCP-local memory processing service is enabled by default in this build. It generates captured-session titles and LCM summaries through local Codex app-server mode. Failures are reported as diagnostics and pending summaries remain searchable as degraded evidence.
MCP Memory Answer and LCM Summary model, reasoning, timeout, and attempt settings can be edited in the Explorer Settings panel. The API stores those user settings and the local MCP/bridge reads them at execution time. `.env` values are bootstrap defaults only; precedence is API user setting, then `.env`, then code default.

Manual Memory Question settings selected in the Explorer composer are stored on the question row so retry and background catch-up use the same model, reasoning effort, timeout, and attempts. If Codex app-server cannot be started, local Synthesis fails visibly instead of falling back to a backend LLM path.

Capture Policy state `ask` currently blocks automatic capture. It is reserved
for a future AI-client approval flow and is not an implemented backend prompt.

Projection selection is configured through the DB-backed
`projection_policy_rules` table, not `.env`. These rows define which Codex
transcript item types are projected into the Explorer UI, semantic Memory
Events, embeddings, and LCM sources. The seeded defaults keep UI projection and
embedding selection matched for every transcript type in the current build, but
the fields are independent so future policy rows can support display-only or
recall-only transcript types without a schema change.

## Data At Rest

Postgres is the source of truth for Users, API Tokens, Capture Policies, raw
`conversation_items`, messages, tool events, Memory Events, Memory Nodes,
embeddings, LCM placeholders, LCM summaries, Memory Questions, and related
evidence. The application hashes API Tokens with `API_TOKEN_PEPPER`. Local
personal developer deployments store operational Memory rows as normal database
rows. Team Self-Hosted, private VPS, and Koed-managed cloud profiles store new
raw conversation-item source fields, projected message/tool payloads, Memory
Event payloads, Memory Node text/source/structured-summary fields, embedding
source text, and Memory Question query/answer/evidence/worker payloads through
encrypted field companions and keep the operational source columns redacted.
Paid Koed-managed cloud must use a KMS-backed envelope provider. Projection
hydrates raw conversation-item companions inside the trusted repository boundary
before deriving semantic rows. Authorized graph, embedding, retrieval, LCM, and
Memory Question paths hydrate encrypted companions after access checks.

Operators should treat the Postgres database and backups as sensitive memory data. Keep Postgres on a private network, restrict database credentials to Koed services and trusted administrators, use encrypted disks or managed-database storage encryption, encrypt backups, and rotate secrets if a backup or database role is exposed.

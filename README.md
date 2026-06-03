# Koed

## Make your AI remember the work

Koed is a universal memory layer for AI clients. It captures project knowledge,
coding sessions, decisions, debugging history, and remembered context, then makes
that memory available through MCP recall.

Run Koed on infrastructure you control. Codex is the first complete supported
integration, with MCP recall plus the TypeScript Capture Hook for automatic
conversation capture.

## What You Get

- Automatic Codex conversation capture through the Koed Capture Hook.
- MCP recall tools for prior conversations, project history, and remembered context.
- Local embedding and reranking service.
- History browser for inspecting captured Koed memory.
- Postgres + pgvector storage under your control.
- Redis-backed background jobs for embedding and memory processing.
- No server-side LLM provider dependency in the backend.

Other MCP-capable AI clients can use Koed for recall through the MCP Server, and
can get full automatic capture once they have a compatible Capture Hook.

## Quickstart

Create the local environment file, then install and start the service:

```bash
pnpm env:setup
pnpm install
pnpm build
pnpm test
docker compose up --build
```

The history browser is pulled from the private `koed-labs/koed-history-browser`
repository during local builds. Set `GITHUB_TOKEN` in `.env` to a GitHub token
that can read that repository before running `docker compose up --build`.

If the default ports are already in use, choose host ports before starting:

```bash
API_HOST_PORT=3300 HISTORY_WEB_HOST_PORT=5574 HISTORY_API_BASE_URL=http://localhost:3300 docker compose up --build
```

Create a local API token for your AI client:

```bash
pnpm api-token:create --owner-email local@koed.ai --name "Codex"
```

List or revoke local API tokens with the same owner email:

```bash
pnpm api-token:list --owner-email local@koed.ai
pnpm api-token:revoke --owner-email local@koed.ai --token-id <token-id>
```

The history browser runs beside the API:

```text
http://localhost:5174
```

If you changed `HISTORY_WEB_HOST_PORT`, open that port instead.

## Connect Codex

Koed recall is exposed through the MCP Server. Codex gets the complete supported
integration today because Koed also ships a TypeScript Capture Hook for automatic
conversation capture.

For Codex, use both pieces:

- MCP Server: recall for prior conversations, project history, and remembered context.
- Capture Hook: automatic capture of Codex conversation activity.

1. Create an API token:

```bash
pnpm api-token:create --owner-email local@koed.ai --name "Codex"
```

2. Build the MCP server and Capture Hook:

```bash
pnpm --filter @koed/mcp-server build
```

3. Configure Codex:

```bash
MEMORY_API_TOKEN=<token from pnpm api-token:create> pnpm codex:configure
```

If you changed `API_HOST_PORT`, pass the matching API URL:

```bash
MEMORY_API_URL=http://localhost:3300 MEMORY_API_TOKEN=<token from pnpm api-token:create> pnpm codex:configure
```

4. Restart Codex so it can load the MCP server and Capture Hook. Codex may ask
   you to review or trust the changed hook configuration.

5. Verify the Capture Hook:

```bash
MEMORY_API_URL=http://localhost:3000 MEMORY_API_TOKEN=<token from pnpm api-token:create> pnpm codex:verify-capture
```

MCP by itself is recall-only and does not automatically record full
conversations. See [docs/codex-integration.md](docs/codex-integration.md) for
manual setup and deeper Codex integration details.

## History Browser

The history browser is a frontend for inspecting captured Koed memory history.
Its implementation lives in the private `koed-labs/koed-history-browser`
repository. This repository keeps the wrapper scripts and Docker integration that
fetch that repository into `apps/history-browser/koed-history-browser` when
needed. Run it locally with:

```bash
GITHUB_TOKEN=<token with access to koed-labs/koed-history-browser>
pnpm history:dev
```

It talks to the same API and accepts bearer API tokens created with
`pnpm api-token:create`.

## Configuration

Start from `.env.example`.

Required local settings:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: Postgres container settings.
- `DATABASE_URL`: local Postgres URL used by operator scripts such as `pnpm api-token:create`.
- `API_TOKEN_PEPPER`: server-side pepper for API token hashes.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token used by the API and worker when calling the private embedding service.
- `API_CORS_ORIGINS`: include the local history-browser origin.
- `GITHUB_TOKEN`: GitHub token used by Docker to fetch the private
  `koed-labs/koed-history-browser` frontend repository.

Embedding settings:

- `EMBEDDING_MODEL_KEY`: local embedding model setting. The embedding service only accepts supported model keys.
- `EMBEDDING_RERANKER_KEY`: optional local reranker model key. Leave blank to keep reranking disabled; Docker Compose maps this to the app-local `RERANKER_KEY`.

History browser settings:

- `HISTORY_BROWSER_REPO`, `HISTORY_BROWSER_REF`: optional override for the
  history-browser repository and branch/tag/SHA.

Memory processing settings:

- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`, `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`,
  `MEMORY_LCM_FRESH_EVENT_TAIL`, `MEMORY_LCM_DEPTH1_FANOUT`: LCM placeholder
  cadence controls for Codex capture traffic.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: local Codex summary prompt budget.

Logging settings:

- `WORKER_LOG_LEVEL`: JSON log level for the worker (`trace`, `debug`, `info`,
  `warn`, `error`, `fatal`, or `silent`).
- `WORKER_LOG_FILE`: optional log file for worker logs. Leave blank to log to
  stderr.
- `WORKER_LOG_DESTINATION`: optional `stderr`, `file`, or `both`. If
  `WORKER_LOG_FILE` is set and this is blank, logs go to the file.
- `MEMORY_LOG_LEVEL`: JSON log level for the local MCP server and answer bridge
  (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`).
- `MEMORY_LOG_FILE`: optional log file for MCP server and answer bridge logs.
  Leave blank to log to stderr.
- `MEMORY_LOG_DESTINATION`: optional `stderr`, `file`, or `both`. If
  `MEMORY_LOG_FILE` is set and this is blank, logs go to the file.

Security-sensitive settings:

- `API_DATA_ENCRYPTION_KEY`: reserved 32-byte base64 key for encrypted server-side fields. In the current build, memory payloads remain plaintext at the application layer in Postgres and must be protected with deployment-level database, volume, backup, and access controls.

Do not commit `.env`, `.env.production`, API tokens, peppers, encryption keys, or
private deployment details. Server-side LLM synthesis and backend LLM provider
configuration are unsupported in this build.

## Architecture

- `apps/api`: Fastify API for auth, API tokens, capture policy, memory capture, recall, graph inspection, export, and diagnostics.
- `apps/worker`: BullMQ worker for embedding and memory background jobs.
- `apps/embedding-service`: local embedding/reranking HTTP service.
- `apps/history-browser`: wrapper package and Docker integration that fetches and builds the separate `koed-labs/koed-history-browser` frontend.
- `packages/db`: Postgres repository and migrations.
- `packages/core`: memory capture, retrieval, answer, and compaction logic.
- `packages/mcp-server`: Koed MCP Server and the TypeScript Codex Capture Hook.
- `packages/shared`, `packages/evals`: retained runtime support and validation utilities.

Postgres uses pgvector. Redis backs BullMQ. Koed relies on the connected AI
client for LLM synthesis; the backend stores memory, retrieves evidence, manages
embeddings and ranking, and does not make server-side LLM calls in this build.

This repository is not the hosted Koed SaaS product. It does not include hosted
onboarding, billing, hosted account management, desktop companion builds, private
deployment scripts, pricing pages, or marketing surfaces.

## Security Notes

Koed assumes the operator controls the deployment. The API supports bearer API
tokens for AI-client integrations. Local operators create tokens with
`pnpm api-token:create`, which uses trusted database access and stores only token
hashes. Postgres and Redis should stay on private Docker/internal networks in
production deployments. See [docs/security.md](docs/security.md).

Report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md) for
supported versions, the reporting channel, and guidance on not disclosing user
Memory data publicly.

## Operations

Use normal Postgres backups and restore into the same Koed version before
upgrading. Run migrations during API startup or manually with:

```bash
pnpm --filter @koed/db migrate:up
```

See [docs/backup-restore.md](docs/backup-restore.md) and
[docs/upgrades.md](docs/upgrades.md).

## License

Koed is currently source-available and non-commercial while the final license is
under review. Commercial reuse, resale, hosted competing services, or other
business use is not permitted until a final license is chosen and published.

License candidates to evaluate:

- PolyForm Noncommercial License: clear non-commercial source-available baseline.
- Business Source License-style terms: useful if a delayed conversion or change-date model is desired.
- Custom source-available non-commercial license: best fit if Koed needs explicit anti-competition and SaaS-hosting restrictions.

See [LICENSE_PENDING.md](LICENSE_PENDING.md) and [docs/license.md](docs/license.md).
Do not describe this distribution as OSI-approved open source unless the final
license is OSI-approved.

## Learn More

- [Running Koed](docs/running-koed.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Backup and restore](docs/backup-restore.md)
- [Upgrades](docs/upgrades.md)
- [Codex integration](docs/codex-integration.md)
- [License guidance](docs/license.md)

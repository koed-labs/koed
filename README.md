# Koed Self-Hosted

Koed Self-Hosted is the source-available backend distribution for running Koed memory capture, recall, and inspection on infrastructure you control. It is focused on Codex today: Codex is the only supported AI client/integration in this public distribution.

This repository is not the hosted Koed SaaS product. It does not include Koed Cloud onboarding, billing, hosted account management, desktop companion builds, private deployment scripts, pricing pages, or marketing surfaces.

## Architecture

- `apps/api`: Fastify API for auth, API tokens, capture policy, memory capture, recall, graph inspection, export, and diagnostics.
- `apps/worker`: BullMQ worker for embedding and memory background jobs.
- `apps/embedding-service`: local embedding/reranking HTTP service.
- `apps/history-browser`: wrapper package and Docker integration that fetches and builds the separate `koed-labs/koed-history-browser` frontend.
- `packages/db`: Postgres repository and migrations.
- `packages/core`: memory capture, retrieval, answer, and compaction logic.
- `packages/mcp-server`: Koed MCP Server and TypeScript Codex Capture Hook.
- `packages/shared`, `packages/evals`: retained runtime support and validation utilities.

Postgres uses pgvector. Redis backs BullMQ. Koed Self-Hosted relies on the connected AI client for LLM synthesis; the backend stores memory, retrieves evidence, manages embeddings and ranking, and does not make server-side LLM calls in this build.

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
repository during local builds. Set
`GITHUB_TOKEN` in `.env` to a GitHub token that can read that repository before
running `docker compose up --build`.

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

The history browser runs beside it:

```text
http://localhost:5174
```

If you changed `HISTORY_WEB_HOST_PORT`, open that port instead.

## Configuration

Start from `.env.example`. Important values:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: Postgres container settings.
- `API_DATA_ENCRYPTION_KEY`: reserved 32-byte base64 key for encrypted server-side fields. In the current self-hosted build, memory payloads remain plaintext at the application layer in Postgres and must be protected with deployment-level database, volume, backup, and access controls.
- `API_TOKEN_PEPPER`: server-side pepper for API token hashes.
- `EMBEDDING_MODEL_KEY`: local embedding model setting. The embedding service only accepts supported model keys.
- `EMBEDDING_RERANKER_KEY`: optional local reranker model key. Leave blank to keep reranking disabled; Docker Compose maps this to the app-local `RERANKER_KEY`.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token used by the API and worker when calling the private embedding service.
- `DATABASE_URL`: local Postgres URL used by operator scripts such as `pnpm api-token:create`.
- `API_CORS_ORIGINS`: include the local history-browser origin.
- `GITHUB_TOKEN`: GitHub token used by Docker to fetch the private
  `koed-labs/koed-history-browser` frontend repository.
- `HISTORY_BROWSER_REPO`, `HISTORY_BROWSER_REF`: optional override for the
  history-browser repository and branch/tag/SHA.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`, `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`,
  `MEMORY_LCM_FRESH_EVENT_TAIL`, `MEMORY_LCM_DEPTH1_FANOUT`: LCM placeholder
  cadence controls for Codex capture traffic.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: local Codex summary prompt budget.
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

Do not commit `.env`, `.env.production`, API tokens, peppers, encryption keys, or private deployment details. Server-side LLM synthesis and backend LLM provider configuration are unsupported in this self-hosted build.

## Codex Setup

Codex is currently the only supported AI client. Other clients will need their own setup guides as they are added.

1. Create an API Token:

```bash
pnpm api-token:create --owner-email local@koed.ai --name "<name>"
```

2. Build the MCP server and Capture Hook:

```bash
pnpm --filter @koed/mcp-server build
```

3. In Codex Desktop, add a custom MCP server:

```text
Name: koed-selfhost
Transport: STDIO
Command: node
Argument: /path/to/koed-self-hosted/packages/mcp-server/dist/cli.js
MEMORY_API_URL: http://localhost:3000
MEMORY_API_TOKEN: <token from pnpm api-token:create>
Working directory: /path/to/koed-self-hosted
```

If you changed `API_HOST_PORT`, use that port in `MEMORY_API_URL`.

4. Configure the Capture Hook with the same `MEMORY_API_URL` and `MEMORY_API_TOKEN`. This is the supported automatic capture path; MCP by itself is recall-only and does not automatically record full conversations.
   Install it for Codex `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop` events.

5. Verify the Capture Hook:

```bash
MEMORY_API_URL=http://localhost:3000 MEMORY_API_TOKEN=<token from pnpm api-token:create> pnpm codex:verify-capture
```

See [docs/codex-integration.md](docs/codex-integration.md) for MCP and Capture Hook details.

## History Browser

The history browser is a separate frontend for inspecting captured Koed memory
history. Its implementation lives in the private `koed-labs/koed-history-browser`
repository. This self-hosted repository only keeps the wrapper scripts and Docker
integration that fetch that repository into
`apps/history-browser/koed-history-browser` when needed. Run it locally with:

```bash
GITHUB_TOKEN=<token with access to koed-labs/koed-history-browser>
pnpm history:dev
```

It talks to the same API and accepts bearer API tokens created with `pnpm api-token:create`.

## Security Model

Self-hosted Koed assumes the operator controls the deployment. The API supports bearer API tokens for AI-client integrations. Local operators create tokens with `pnpm api-token:create`, which uses trusted database access and stores only token hashes. Postgres and Redis should stay on private Docker/internal networks in production deployments. See [docs/security.md](docs/security.md).

Report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md) for
supported versions, the reporting channel, and guidance on not disclosing user
Memory data publicly.

## Backups, Upgrades, Migrations

Use normal Postgres backups and restore into the same Koed version before upgrading. Run migrations during API startup or manually with:

```bash
pnpm --filter @koed/db migrate:up
```

See [docs/backup-restore.md](docs/backup-restore.md) and [docs/upgrades.md](docs/upgrades.md).

## License Status

No final license has been selected. This repository should be treated as source-available and non-commercial pending legal review. Commercial reuse, resale, hosted competing services, or other business use is not permitted until a final license is chosen and published.

License candidates to evaluate:

- PolyForm Noncommercial License: clear non-commercial source-available baseline.
- Business Source License-style terms: useful if a delayed conversion or change-date model is desired.
- Custom source-available non-commercial license: best fit if Koed needs explicit anti-competition and SaaS-hosting restrictions.

See [LICENSE_PENDING.md](LICENSE_PENDING.md) and [docs/license.md](docs/license.md). Do not describe this distribution as OSI-approved open source unless the final license is OSI-approved.

## More Docs

- [Self-hosting](docs/self-hosting.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Backup and restore](docs/backup-restore.md)
- [Upgrades](docs/upgrades.md)
- [Codex integration](docs/codex-integration.md)
- [License guidance](docs/license.md)

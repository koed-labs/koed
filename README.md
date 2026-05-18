# Koed Self-Hosted

Koed Self-Hosted is the source-available backend distribution for running Koed memory capture, recall, and inspection on infrastructure you control. It is focused on Codex today: Codex is the only supported AI client/integration in this public distribution.

This repository is not the hosted Koed SaaS product. It does not include Koed Cloud onboarding, billing, hosted account management, desktop companion builds, private deployment scripts, pricing pages, or marketing surfaces.

## Architecture

- `apps/api`: Fastify API for auth, API tokens, capture policy, memory capture, recall, graph inspection, export, and diagnostics.
- `apps/worker`: BullMQ worker for embedding and memory background jobs.
- `apps/embedding-service`: local embedding/reranking HTTP service.
- `apps/console`: local operator console for setup, status, tokens, policy, memory overview, Codex setup, and redacted diagnostics.
- `apps/history-browser`: second local frontend adapted from the T3 Code history-browser experiment for side-by-side memory UX review.
- `packages/db`: Postgres repository and migrations.
- `packages/core`: memory capture, retrieval, answer, and compaction logic.
- `packages/mcp-server`: Codex MCP server and capture hook.
- `packages/providers`, `packages/shared`, `packages/evals`: retained runtime support and validation utilities.

Postgres uses pgvector. Redis backs BullMQ. The default model mode is `codex_subscription`, where local Codex performs synthesis and the backend stores/retrieves evidence.

## Quickstart

```bash
pnpm setup:env
pnpm install
pnpm build
pnpm test
docker compose up --build
```

If the default ports are already in use, choose host ports before starting:

```bash
API_HOST_PORT=3300 WEB_HOST_PORT=5573 HISTORY_WEB_HOST_PORT=5574 docker compose up --build
```

Then open the local console:

```text
http://localhost:5173
```

The T3-style history browser runs beside it:

```text
http://localhost:5174
```

If you changed `WEB_HOST_PORT` or `HISTORY_WEB_HOST_PORT`, open those ports instead.

Use the console setup flow:

1. Create the first local admin user. This account is local to your self-hosted Postgres database.
2. Create an API token for your AI client.
3. Run the console smoke test to verify capture, compaction, embedding enqueue, and recall.
4. Copy the generated AI-client setup fields into your local client.

The console can verify Koed and generate exact setup values, but it cannot write into local AI-client configuration files from the browser.

## Configuration

Start from `.env.example`. Important values:

- `DATABASE_URL`: Postgres connection string.
- `REDIS_URL`: Redis connection string.
- `DATA_ENCRYPTION_KEY`: 32-byte base64 key used for stored provider API keys.
- `API_TOKEN_PEPPER`: server-side pepper for API token hashes.
- `MEMORY_MODE=codex_subscription`: recommended default.
- `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_SERVICE_URL`: local embedding settings.
- `CORS_ORIGINS`: include the local console origin.

Do not commit `.env`, `.env.production`, provider keys, API tokens, peppers, encryption keys, or private deployment details.

## Codex Setup

Codex is currently the only supported AI client. Other clients will need their own setup guides as they are added.

1. Open the console and create an API token named `Codex MCP`.
2. Run the console smoke test.
3. Build the MCP server:

```bash
pnpm --filter @codex-memory/mcp-server build
```

4. In Codex Desktop, add a custom MCP server with the values shown in the console `AI Clients` tab. Typical values are:

```text
Name: koed-selfhost
Transport: STDIO
Command: node
Argument: /path/to/koed-self-hosted/packages/mcp-server/dist/cli.js
CODEX_MEMORY_BASE_URL: http://localhost:3000
CODEX_MEMORY_API_TOKEN: <token from console>
Working directory: /path/to/koed-self-hosted
```

If you changed `API_HOST_PORT`, use that port in `CODEX_MEMORY_BASE_URL`.

See [docs/codex-integration.md](docs/codex-integration.md) for MCP details.

## Local Console

The console is an operator UI, not a marketing site. It includes:

- first-run local admin setup and login;
- API, Postgres, Redis/BullMQ, embedding service, and worker queue status;
- embedding/model/provider settings;
- AI-client setup field generation;
- API token creation, listing, and revocation;
- capture policy controls;
- memory graph overview;
- built-in smoke test for capture and recall;
- export/delete/governance entry points through retained API surfaces;
- copyable, redacted diagnostics.

## History Browser

The history browser is a second frontend for gap analysis against the operator
console. It focuses on the T3 Code-style chat timeline, project/session
sidebar, LCM inspector, and scoped memory questions. Run it locally with:

```bash
pnpm history:dev
```

It talks to the same API and accepts the same console-created bearer API tokens.

## Security Model

Self-hosted Koed assumes the operator controls the deployment. The API supports first-run local admin creation, cookie login for the console, and bearer API tokens for Codex/MCP. Postgres and Redis should stay on private Docker/internal networks in production deployments. See [docs/security.md](docs/security.md).

## Backups, Upgrades, Migrations

Use normal Postgres backups and restore into the same Koed version before upgrading. Run migrations during API startup or manually with:

```bash
pnpm --filter @codex-memory/db migrate:up
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

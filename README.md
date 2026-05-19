# Koed Self-Hosted

Koed Self-Hosted is the source-available backend distribution for running Koed memory capture, recall, and inspection on infrastructure you control. It is focused on Codex today: Codex is the only supported AI client/integration in this public distribution.

This repository is not the hosted Koed SaaS product. It does not include Koed Cloud onboarding, billing, hosted account management, desktop companion builds, private deployment scripts, pricing pages, or marketing surfaces.

## Architecture

- `apps/api`: Fastify API for auth, API tokens, capture policy, memory capture, recall, graph inspection, export, and diagnostics.
- `apps/worker`: BullMQ worker for embedding and memory background jobs.
- `apps/embedding-service`: local embedding/reranking HTTP service.
- `apps/console`: local operator console for setup, status, tokens, policy, memory overview, Codex setup, and redacted diagnostics.
- `packages/db`: Postgres repository and migrations.
- `packages/core`: memory capture, retrieval, answer, and compaction logic.
- `packages/mcp-server`: Koed MCP Server and TypeScript Codex Capture Hook.
- `packages/shared`, `packages/evals`: retained runtime support and validation utilities.

Postgres uses pgvector. Redis backs BullMQ. Koed Self-Hosted relies on the connected AI client for LLM synthesis; the backend stores memory, retrieves evidence, manages embeddings and ranking, and does not make server-side LLM calls in this build.

## Quickstart

Set the unique encryption args for the deployment:

```bash
cp .env.example .env
printf "API_DATA_ENCRYPTION_KEY=%s\nAPI_TOKEN_PEPPER=%s\n" \
  "$(openssl rand -base64 32)" \
  "$(openssl rand -base64 48)" >> .env
```

Install and start the service:

```bash
pnpm install
pnpm build
pnpm test
docker compose up --build
```

If the default ports are already in use, choose host ports before starting:

```bash
API_HOST_PORT=3300 CONSOLE_HOST_PORT=5573 CONSOLE_API_BASE_URL=http://localhost:3300 docker compose up --build
```

Then open the local console:

```text
http://localhost:5173
```

If you changed `CONSOLE_HOST_PORT`, open that port instead.

Use the console setup flow:

1. Create the first local admin user. This account is local to your self-hosted Postgres database.
2. Create an API token for your AI client.
3. Run the console smoke test to verify capture, compaction, embedding enqueue, and recall.
4. Copy the generated AI-client setup fields into your local client.

The console can verify Koed and generate exact setup values, but it cannot write into local AI-client configuration files from the browser.

## Configuration

Start from `.env.example`. Important values:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: Postgres container settings.
- `API_DATA_ENCRYPTION_KEY`: 32-byte base64 key used for encrypted server-side data.
- `API_TOKEN_PEPPER`: server-side pepper for API token hashes.
- `EMBEDDING_MODEL_NAME`, `EMBEDDING_DIMENSIONS`: local embedding settings.
- `API_CORS_ORIGINS`: include the local console origin.

Do not commit `.env`, `.env.production`, API tokens, peppers, encryption keys, or private deployment details. Server-side LLM synthesis and backend LLM provider configuration are unsupported in this self-hosted build.

## Codex Setup

Codex is currently the only supported AI client. Other clients will need their own setup guides as they are added.

1. Open the console and create an API token named `Client Integration`.
2. Run the console smoke test.
3. Build the MCP server:

```bash
pnpm --filter @koed/mcp-server build
```

4. In Codex Desktop, add a custom MCP server with the values shown in the console `AI Clients` tab. Typical values are:

```text
Name: koed-selfhost
Transport: STDIO
Command: node
Argument: /path/to/koed-self-hosted/packages/mcp-server/dist/cli.js
MEMORY_API_URL: http://localhost:3000
MEMORY_API_TOKEN: <token from console>
Working directory: /path/to/koed-self-hosted
```

If you changed `API_HOST_PORT`, use that port in `MEMORY_API_URL`.

See [docs/codex-integration.md](docs/codex-integration.md) for MCP details.

## Local Console

The console is an operator UI, not a marketing site. It includes:

- first-run local admin setup and login;
- API, Postgres, Redis/BullMQ, embedding service, and worker queue status;
- embedding/model settings;
- AI-client setup field generation;
- API token creation, listing, and revocation;
- capture policy controls;
- memory graph overview;
- built-in smoke test for capture and recall;
- export/delete/governance entry points through retained API surfaces;
- copyable, redacted diagnostics.

## Security Model

Self-hosted Koed assumes the operator controls the deployment. The API supports first-run local admin creation, cookie login for the console, and bearer API tokens for AI-client integrations. Postgres and Redis should stay on private Docker/internal networks in production deployments. See [docs/security.md](docs/security.md).

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

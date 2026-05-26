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
- `packages/mcp-server`: Koed MCP Server and TypeScript Codex Capture Hook.
- `packages/shared`, `packages/evals`: retained runtime support and validation utilities.

Postgres uses pgvector. Redis backs BullMQ. Koed Self-Hosted relies on the connected AI client for LLM synthesis; the backend stores memory, retrieves evidence, manages embeddings and ranking, and does not make server-side LLM calls in this build.

## Quickstart

Create the local environment file, then install and start the service:

```bash
pnpm setup:env
pnpm install
pnpm build
pnpm test
docker compose up --build
```

The T3-style history browser is pulled from the private
`koed-labs/koed-history-browser` repository during local builds. Set
`GITHUB_TOKEN` in `.env` to a GitHub token that can read that repository before
running `docker compose up --build`.

If the default ports are already in use, choose host ports before starting:

```bash
API_HOST_PORT=3300 CONSOLE_HOST_PORT=5573 HISTORY_WEB_HOST_PORT=5574 CONSOLE_API_BASE_URL=http://localhost:3300 docker compose up --build
```

Then open the local console:

```text
http://localhost:5173
```

The T3-style history browser runs beside it:

```text
http://localhost:5174
```

If you changed `CONSOLE_HOST_PORT` or `HISTORY_WEB_HOST_PORT`, open those ports instead.

Use the console setup flow:

1. Create the first local admin user. This account is local to your self-hosted Postgres database.
2. Create an API token for your AI client.
3. Run the console smoke test to verify capture, compaction, embedding enqueue, and recall.
4. Copy the generated MCP Server and Capture Hook setup fields into your local client.

The console can verify Koed and generate exact setup values, but it cannot write into local AI-client configuration files from the browser.

## Configuration

Start from `.env.example`. Important values:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`: Postgres container settings.
- `API_DATA_ENCRYPTION_KEY`: reserved 32-byte base64 key for encrypted server-side fields. In the current self-hosted build, memory payloads remain plaintext at the application layer in Postgres and must be protected with deployment-level database, volume, backup, and access controls.
- `API_TOKEN_PEPPER`: server-side pepper for API token hashes.
- `EMBEDDING_MODEL_KEY`: local embedding model setting. The embedding service only accepts supported model keys.
- `EMBEDDING_SERVICE_TOKEN`: shared internal token used by the API and worker when calling the private embedding service.
- `API_CORS_ORIGINS`: include the local console and history-browser origins.
- `GITHUB_TOKEN`: GitHub token used by Docker to fetch the private
  `koed-labs/koed-history-browser` frontend repository.
- `HISTORY_BROWSER_REPO`, `HISTORY_BROWSER_REF`: optional override for the
  history-browser repository and branch/tag/SHA.
- `MEMORY_LCM_LEAF_EVENT_THRESHOLD`, `MEMORY_LCM_LEAF_TOKEN_THRESHOLD`,
  `MEMORY_LCM_FRESH_EVENT_TAIL`, `MEMORY_LCM_DEPTH1_FANOUT`: LCM placeholder
  cadence controls for Codex capture traffic.
- `MEMORY_LCM_SUMMARY_MAX_PROMPT_TOKENS`: local Codex summary prompt budget.

Do not commit `.env`, `.env.production`, API tokens, peppers, encryption keys, or private deployment details. Server-side LLM synthesis and backend LLM provider configuration are unsupported in this self-hosted build.

## Codex Setup

Codex is currently the only supported AI client. Other clients will need their own setup guides as they are added.

1. Open the console and create an API token named `Client Integration`.
2. Run the console smoke test.
3. Build the MCP server and Capture Hook:

```bash
pnpm --filter @koed/mcp-server build
```

4. In Codex Desktop, add a custom MCP server with the values shown on the console setup page. Typical MCP values are:

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

5. Configure the Capture Hook shown on the console setup page with the same `MEMORY_API_URL` and `MEMORY_API_TOKEN`. This is the supported automatic capture path; MCP by itself is recall-only and does not automatically record full conversations.
   Install it for Codex `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop` events.

6. Verify the Capture Hook:

```bash
MEMORY_API_URL=http://localhost:3000 MEMORY_API_TOKEN=<token from console> pnpm codex:verify-capture
```

See [docs/codex-integration.md](docs/codex-integration.md) for MCP and Capture Hook details.

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

## History Browser

The history browser is a second frontend for gap analysis against the operator
console. It lives in the private `koed-labs/koed-history-browser` repository and
is fetched into `apps/history-browser/t3code-history-browser` when needed. It
focuses on the T3 Code-style chat timeline, project/session sidebar, LCM
inspector, and scoped memory questions. Run it locally with:

```bash
GITHUB_TOKEN=<token with access to koed-labs/koed-history-browser>
pnpm history:dev
```

It talks to the same API and accepts the same console-created bearer API tokens.

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

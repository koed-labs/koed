<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/koed-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/koed-logo.svg">
  <img alt="Koed" src="docs/assets/koed-logo.svg" width="190" height="60">
</picture>
</p>

## Make your AI remember the work

Koed is a universal memory layer for AI clients. It captures project knowledge,
coding sessions, decisions, debugging history, and remembered context, then makes
that memory available through MCP recall.

- Automatic conversation capture with hooks.
- Seamless recall for prior conversations, project history, and remembered context.
- Explorer for inspecting captured Koed memory.
- Postgres + pgvector storage under your control.
- Local embedding, reranking, and Redis-backed memory processing.

## Quickstart

> [!IMPORTANT]  
> Codex is currently the only supported AI Client integration for capture and recall. Future integrations are tracked separately.

Create the local environment file, then install and start the service:

```bash
pnpm env:setup
pnpm install
pnpm build
pnpm test
docker compose up --build
```

Create a local API token for your AI client:

```bash
pnpm api-token:create --owner-email local@koed.ai --name "Codex"
```

The Explorer runs beside the API:

```text
http://localhost:5174
```

## Connect Codex

Set up the MCP Server and Capture Hook to enable recall and automatic capture in Codex.

```bash
MEMORY_API_TOKEN=<token from pnpm api-token:create> pnpm codex:configure
```

Verify setup with:

```bash
MEMORY_API_URL=http://localhost:3000 MEMORY_API_TOKEN=<token from pnpm api-token:create> pnpm codex:verify-capture
```

See [docs/codex-integration.md](docs/codex-integration.md) for
manual setup and deeper Codex integration details.

## Configuration

Start from `.env.example`:

```bash
pnpm env:setup
```

See [Configuration](docs/configuration.md) for all environment variables,
embedding settings, logging options, AI client values, and production notes.

## Architecture

Koed is composed of the following primary services:

| Path                     | Role                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/api`               | API for auth, capture policy, memory capture, recall, graph inspection, export, and diagnostics |
| `apps/worker`            | Background memory and embedding jobs                                                            |
| `apps/embedding-service` | Local embedding and reranking service                                                           |
| `apps/explorer`          | Explorer UI for inspecting captured Koed memory                                                 |
| `packages/mcp-server`    | MCP Server, local answer bridge, and Codex Capture Hook                                         |
| `packages/db`            | Postgres repositories, migrations, and operator scripts                                         |

## Security Notes

Koed assumes the operator controls the deployment. The API supports bearer API
tokens for AI-client integrations. Local operators create tokens with
`pnpm api-token:create`, which uses trusted database access and stores only token
hashes. Postgres and Redis should stay on private Docker/internal networks in
production deployments. See [docs/security.md](docs/security.md).

Memory payloads remain plaintext at the application layer in Postgres in the
current build. Protect the database, volumes, backups, and administrator access
with deployment-level controls.

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

Koed is licensed under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md),
and [docs/license.md](docs/license.md).

## Learn More

- [Running Koed](docs/running-koed.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Backup and restore](docs/backup-restore.md)
- [Upgrades](docs/upgrades.md)
- [Codex integration](docs/codex-integration.md)
- [License](docs/license.md)

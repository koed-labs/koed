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
- Local embedding, reranking, and BullMQ or Postgres-backed memory processing.

## Quickstart

> [!IMPORTANT]  
> Koed Desktop/`koed-server` supervision is split from dependency lifecycle. Docker Compose remains a useful external dependency starter; `koed-server` does not own Compose lifecycle. `bundled-local` mode uses native Koed-owned dependencies under `KOED_HOME`; model downloads are explicit `koed-server models install` steps with SHA-256 verification.
>
> Codex is currently the only supported AI Client integration for capture and recall. Future integrations are tracked separately.

For local personal use with native bundled resources installed, `koed-server start` can run without Docker, external Postgres, or external Redis. From a fresh clone, Docker Compose remains an optional external dependency starter:

```bash
pnpm env:setup
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml up -d --build
pnpm desktop:start
```

For native bundled-local validation without Docker, set `KOED_DEPENDENCY_MODE=bundled-local`, ensure native Postgres, pgvector, llama-server, Python, and model assets are present, then run:

```bash
pnpm smoke:bundled-local -- --full --json
```

`pnpm desktop:start` opens Koed Desktop, auto-starts `koed-server`, and runs
the full Codex bootstrap + health-check sequence before showing the Explorer.
`koed-server` connects to Postgres, the configured work queue backend, and
Embedding Service endpoints from `.env`/environment or
`KOED_HOME/config/server.json`; it does not start or stop Docker Compose
dependencies. Set `KOED_DEPENDENCY_MODE=bundled-local` to let
`koed-server start` launch native local Postgres + Embedding Service runtimes under
`KOED_HOME` and use the Postgres-backed local queue by default.

On macOS, native runtime assets can be inspected and explicitly installed with Homebrew:

```bash
node packages/koed-server/dist/cli.js runtime status --provider homebrew --json
node packages/koed-server/dist/cli.js runtime install --provider homebrew --dependency-mode bundled-local --json
```

Bundled-local model installers are opt-in and require artifact URLs plus expected SHA-256 checksums:

```bash
KOED_EMBEDDING_MODEL_URL=https://example.test/Qwen3-Embedding-0.6B-Q8_0.gguf \
KOED_EMBEDDING_MODEL_SHA256=<64-hex-sha256> \
node packages/koed-server/dist/cli.js models install --kind embedding --json
```

To verify the native bundled-local path with isolated ports and a temporary `KOED_HOME`, run:

```bash
pnpm smoke:bundled-local -- --full --install-runtime --json
```

Bundled-local smoke requires native bundled resources and an embedding model. `--install-runtime` explicitly runs the Homebrew-backed runtime install for the temporary `KOED_HOME`; model install still requires `KOED_EMBEDDING_MODEL_URL` plus `KOED_EMBEDDING_MODEL_SHA256`. The full smoke verifies API Token creation, Capture Hook-like personal ingestion, Projection, queue/embedding work, Memory Answer evidence retrieval, Explorer reachability, and cleanup through `koed-server stop --json`.

If you need to rerun only the last-mile client setup manually, use
`pnpm clients:bootstrap`.

The Explorer runs beside the API and is embedded by Koed Desktop:

```text
http://localhost:5174
```

If you want the lower-level control-plane commands directly, start the
long-running supervisor in one terminal:

```bash
pnpm --filter @koed/koed-server build
node packages/koed-server/dist/cli.js start
```

After `koed-server start` reports that the API is ready, run setup from another
terminal:

```bash
node packages/koed-server/dist/cli.js setup codex --json
```

## Connect Codex

`koed-server setup codex --json` performs the same guided Codex setup that
`pnpm clients:bootstrap` uses after the control plane is running. It creates or
reuses the local API Token, builds the MCP Server, writes the Codex MCP and
Supported Capture Hook configuration, writes the app-provisioned Explorer
credential, verifies capture, and finishes with a doctor check. Koed Desktop
runs this sequence automatically on startup when Codex is not yet configured.
The lower-level `pnpm codex:bootstrap`, `pnpm explorer:bootstrap`, and
`pnpm clients:bootstrap` Local Operator Scripts remain available for development
and recovery. See [docs/codex-integration.md](docs/codex-integration.md) for
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

| Path                     | Role                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `apps/api`               | API for auth, capture policy, memory capture, recall, graph inspection, export, and diagnostics     |
| `apps/worker`            | Background memory and embedding jobs                                                                |
| `apps/embedding-service` | Local embedding and reranking service                                                               |
| `apps/explorer`          | Explorer UI for inspecting captured Koed memory                                                     |
| `apps/desktop`           | Electron control surface that starts/monitors `koed-server`, runs setup/doctor, and embeds Explorer |
| `packages/koed-server`   | Local control-plane CLI/supervisor for `KOED_HOME`, service status, setup, and startup              |
| `packages/mcp-server`    | MCP Server, local answer bridge, and Codex Capture Hook                                             |
| `packages/db`            | Postgres repositories, migrations, and operator scripts                                             |

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
upgrading. The API runs database migrations during startup.

Local Operators can also run the same Drizzle migration path manually with:

```bash
pnpm --filter @koed/db migrate:up
```

See [docs/backup-restore.md](docs/backup-restore.md) and
[docs/upgrades.md](docs/upgrades.md).

## Releases

Koed currently uses one product release version for the self-hosted
distribution. Add a changeset for release-noteworthy changes:

```bash
pnpm changeset
```

Select `@koed/koed` and choose the SemVer bump for the deployment as a whole.
Merging to `main` creates or updates a release pull request. Merging that
release pull request verifies the release commit, creates a single `vX.Y.Z` tag,
and publishes a GitHub Release.

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
- [Database development](docs/database-development.md)
- [Codex integration](docs/codex-integration.md)
- [License](docs/license.md)

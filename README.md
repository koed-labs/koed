<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/koed-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/koed-logo.svg">
  <img alt="Koed" src="docs/assets/koed-logo.svg" width="190" height="60">
</picture>
</p>

## Make your AI remember the work

Koed helps your AI coding tool remember useful context from previous work, so it
can bring back project decisions, debugging history, and other details when you
need them.

## Quickstart

> [!IMPORTANT]
> Codex is currently the only supported AI Client integration for capture and
> recall.

### Requirements

- macOS, Linux, or WSL.
- Node.js and pnpm.
- Homebrew for the source-checkout bundled-local runtime install. Packaged
  Desktop can use packaged native runtime assets; external dependency mode does
  not require Homebrew.
- Codex installed and signed in.

If you are on Windows, run Koed inside WSL as Linux tooling. Keep `KOED_HOME`
and checkout paths on Linux filesystem paths inside WSL; native Windows
packaged app support is not shipped in this build.

### Start Koed Desktop from source

From a fresh clone, run:

```bash
pnpm install
pnpm local:setup
KOED_DEPENDENCY_MODE=bundled-local KOED_AUTO_PORTS=1 pnpm desktop:start
```

`pnpm local:setup` prepares `.env`, builds the workspace, links the Homebrew-backed bundled-local runtime, and installs the default embedding model.

Koed Desktop opens when setup is complete and configures Codex automatically.
Packaged Desktop follows the same local-personal bundled-local flow, but it
starts its managed `koed-server` from the app bundle, prefers packaged native
runtime assets, and keeps `KOED_HOME` state outside the source checkout. See
[Koed Desktop](apps/desktop/README.md) for packaged first-run,
signing/notarization, and smoke details.

If setup fails with a path like `/path/to`, unset any placeholder overrides
from previous experiments before restarting Desktop:

```bash
unset KOED_HOME KOED_EMBEDDING_MODEL_PATH KOED_RERANKER_MODEL_PATH
```

To stop Koed later:

```bash
node packages/koed-server/dist/cli.js stop --json
```

## Advanced setup and configuration

The README keeps to one basic local path. For other options, see:

- [Running Koed](docs/running-koed.md) for external dependency mode, manual
  server commands, alternate ports, smoke tests, packaged first-run notes, and
  desktop development.
- [Configuration](docs/configuration.md) for environment variables, runtime
  modes, model overrides, logging, and production settings.
- [Codex integration](docs/codex-integration.md) for manual Codex setup and
  recovery.
- [Curated Memory](docs/curated-memory.md) for source-linked durable facts and
  recall behavior.
- [Security](docs/security.md), [Backup and restore](docs/backup-restore.md),
  and [Upgrades](docs/upgrades.md) for operational guidance.

For local Desktop, private VPS, Team Self-Hosted, and cloud deployment
language, use `koed-server` plus dependencies as the product boundary. API,
Worker, and Explorer remain useful implementation names for code, logs, and
troubleshooting.

## Security Notes

Koed assumes the operator controls the deployment. The API supports bearer API
tokens for AI-client integrations. Local operators create tokens with
`pnpm api-token:create`, which uses trusted database access and stores only token
hashes. Postgres and Redis should stay on private Docker/internal networks in
production deployments. See [docs/security.md](docs/security.md).

Local personal deployments may keep operational Memory rows in Postgres unless
app-layer encryption is configured. Private VPS, Team Self-Hosted, and
Koed-managed cloud deployments should configure envelope encryption for
human-readable Memory and evidence payloads; queryable vectors still remain
sensitive trusted-boundary data. Protect the database, volumes, backups, and
administrator access with deployment-level controls.

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

See [docs/backup-restore.md](docs/backup-restore.md),
[docs/hosted-backups.md](docs/hosted-backups.md), and
[docs/upgrades.md](docs/upgrades.md).

## Releases

Koed uses one product release version for the self-hosted distribution. Add a
changeset for release-noteworthy changes:

```bash
pnpm changeset
```

See [docs/upgrades.md](docs/upgrades.md) for upgrade guidance.

## License

Koed is licensed under the GNU Affero General Public License version 3 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md),
and [docs/license.md](docs/license.md). See
[Commercial Feature Boundary](docs/commercial-feature-boundary.md) for the
launch recommendation on public distribution, Team Self-Hosted, hosted-only
services, and managed add-ons.

## Learn More

- [Running Koed](docs/running-koed.md)
- [Configuration](docs/configuration.md)
- [Server deployment boundary](docs/server-deployment-boundary.md)
- [Hosted database roles](docs/hosted-database-roles.md)
- [Security](docs/security.md)
- [Backup and restore](docs/backup-restore.md)
- [Hosted backups](docs/hosted-backups.md)
- [Upgrades](docs/upgrades.md)
- [Codex integration](docs/codex-integration.md)
- [Curated Memory](docs/curated-memory.md)
- [License](docs/license.md)
- [Commercial feature boundary](docs/commercial-feature-boundary.md)

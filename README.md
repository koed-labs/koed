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
> Codex, Claude Code, and Pi are independently installed supported AI Client
> integrations. The current guided fresh-install bootstrap is temporarily
> Codex-first and requires supported Codex even when Claude Code or Pi is also
> used. Codex-free core readiness and client-neutral onboarding are tracked in
> KOE-375, KOE-377, and KOE-378. Koed does not bundle AI Client runtimes or
> provider credentials.

### Requirements

- macOS, Linux, or WSL.
- Node.js and pnpm.
- Homebrew for the source-checkout bundled-local runtime install. Packaged
  Desktop can use packaged native runtime assets; external dependency mode does
  not require Homebrew.
- Codex CLI `0.144.0` or newer installed and signed in for the current guided
  fresh-install bootstrap. The Codex default `gpt-5.6-luna` model is unavailable
  in older releases.
- Optionally, Claude Code or Pi `0.84.2` or newer installed and signed in as an
  additional supported AI Client. Claude synthesis reuses the local Claude Code
  subscription through the pinned Agent SDK. Pi synthesis reuses Pi-managed
  local authentication through isolated RPC.

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
Claude Code and Pi are configured independently; see integration guides below.
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
- [Koed Desktop](docs/desktop-ui.md) for the Personal/Team information model,
  collaboration workflows, recovery behavior, accessibility, and performance
  boundaries.
- [Configuration](docs/configuration.md) for environment variables, runtime
  modes, model overrides, logging, and production settings.
- [Codex integration](docs/codex-integration.md) for manual Codex setup and
  recovery.
- [Claude Code integration](docs/claude-code-integration.md) for capture, recall,
  and local Claude synthesis setup.
- [Pi integration](docs/pi-integration.md) for global package setup, persistent
  session capture, Recall tools, and isolated local Pi RPC synthesis.
- [Curated Memory](docs/curated-memory.md) for source-linked durable facts and
  recall behavior.
- [Personal Device Sync controls](docs/running-koed.md#personal-sync-control-commands)
  for opt-in future-Session replication, recovery-kit ceremony, and headless
  Operator secret references.
- [Security](docs/security.md), [Backup and restore](docs/backup-restore.md),
  and [Upgrades](docs/upgrades.md) for operational guidance.

For local Desktop, private VPS, Team Self-Hosted, and cloud deployment
language, use `koed-server` plus dependencies as the product boundary. API and
Worker remain useful implementation names for code, logs, and troubleshooting.
The retired Explorer is not a process or deployment dependency.

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

Koed is licensed under the Apache License 2.0 (`Apache-2.0`). See
[LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md), and
[docs/license.md](docs/license.md). Apache-2.0 is also offered for Koed's
repository history; existing AGPL grants remain valid. See
[Commercial Feature Boundary](docs/commercial-feature-boundary.md) for the
public distribution, Team Self-Hosted, hosted-only services, and managed
add-ons.

## Learn More

- [Running Koed](docs/running-koed.md)
- [Koed Desktop](docs/desktop-ui.md)
- [Configuration](docs/configuration.md)
- [Server deployment boundary](docs/server-deployment-boundary.md)
- [Hosted database roles](docs/hosted-database-roles.md)
- [Security](docs/security.md)
- [Backup and restore](docs/backup-restore.md)
- [Hosted backups](docs/hosted-backups.md)
- [Upgrades](docs/upgrades.md)
- [CI and release validation](docs/ci-validation.md)
- [Codex integration](docs/codex-integration.md)
- [Curated Memory](docs/curated-memory.md)
- [License](docs/license.md)
- [Commercial feature boundary](docs/commercial-feature-boundary.md)

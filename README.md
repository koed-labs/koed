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
- Homebrew.
- Codex installed and signed in.

### Start Koed

From a fresh clone, run:

```bash
pnpm install
pnpm env:setup
pnpm build
node packages/koed-server/dist/cli.js runtime install --provider homebrew --dependency-mode bundled-local --json
node packages/koed-server/dist/cli.js models install --kind embedding --json
KOED_DEPENDENCY_MODE=bundled-local pnpm desktop:start
```

Koed opens when setup is complete and configures Codex automatically.

To stop Koed later:

```bash
node packages/koed-server/dist/cli.js stop --json
```

## Advanced setup and configuration

The README keeps to one basic local path. For other options, see:

- [Running Koed](docs/running-koed.md) for Docker Compose, manual server
  commands, alternate ports, smoke tests, and desktop development.
- [Configuration](docs/configuration.md) for environment variables, runtime
  modes, model overrides, logging, and production settings.
- [Codex integration](docs/codex-integration.md) for manual Codex setup and
  recovery.
- [Security](docs/security.md), [Backup and restore](docs/backup-restore.md),
  and [Upgrades](docs/upgrades.md) for operational guidance.

## Security Notes

Koed is designed for an Operator-controlled deployment. Protect local data,
backups, logs, and administrator access. Report suspected vulnerabilities
privately; see [SECURITY.md](SECURITY.md).

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
and [docs/license.md](docs/license.md).

## Learn More

- [Running Koed](docs/running-koed.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Backup and restore](docs/backup-restore.md)
- [Upgrades](docs/upgrades.md)
- [Codex integration](docs/codex-integration.md)
- [License](docs/license.md)

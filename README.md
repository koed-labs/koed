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
- Python 3.12, available as `python3.12` or via `KOED_PYTHON`.
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

`pnpm local:setup` prepares `.env`, installs the Embedding Service Python
virtualenv, builds the workspace, links the Homebrew-backed bundled-local
runtime, and installs the default embedding model.

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

# Upgrades

## Runtime namespace migration

Released runtime v0.11.1 used the `@koed` scope for internal runtime packages;
new components use `@koed-labs`. The public server package name remains
`@koed-labs/server`; it has not been renamed. Do not rename paths inside an old
runtime or mix its packages with new components. Standalone package archives
reject symbolic links; a modified older installation containing pnpm self-links
omitted from its original manifest will fail the newer integrity check. Reinstall
from a trusted, matching release package rather than modifying its files in place.

To upgrade a component-based installation:

1. Stop services through their current owner and use the new release's trusted
   control plane. Check component state with `koed components status --json`.
2. Install the complete Base and, if required by configuration, Privacy component
   set for that exact product version. Components are authenticated against
   manifest pins embedded in the matching control plane; old-version components
   are not reused. See [component provisioning](running-koed.md#explicit-component-provisioning)
   for archive and URL commands.
3. A complete set may activate automatically while services are stopped. To
   defer activation, install with `--stage-only`, then run
   `koed components activate --version <version> --json` while stopped.
4. Start through the installation owner and verify status and health. Startup
   does not download missing components.

Activation requires a verified, complete generation and matching control-plane
version. Generation downgrades are blocked, including with an older matching
control plane. Same-version switching between verified generations is supported;
this does not establish database compatibility or restore database state.

If Pi integration needs repair after the upgrade, with the runtime started run
`koed repair pi --json`, then `koed check pi --json` and restart Pi. Pi must be
installed separately; model authentication is required for Pi execution. See
[Pi integration](pi-integration.md) for setup and readiness details.

## Stable baseline and upgrades

Stable installs start with a fresh, empty database. The sole initial migration,
`0000_clean_initial_schema`, establishes that baseline. Existing alpha databases
are not supported upgrade sources: Koed does not migrate, convert, or preserve
their contents in place. Back up alpha data only if needed for reference or
independent recovery; do not restore it as a stable-install conversion path.

After installing this stable baseline, future stable releases evolve through
ordered migrations from that baseline. Backups do not bridge alpha schema
history into stable.

For a fresh installation or a supported stable upgrade, the migration command
is:

```bash
pnpm --filter @koed-labs/db migrate:up
```

Do not point an older application binary at a database with newer migrations.
Component activation does not reverse database migrations.

## Alpha-only migration history

Historical alpha migration references below describe alpha-only procedures and
are not a supported path to the stable baseline. The discarded experimental
`0013_ordinary_sir_ram` Team Chat schema was not an upgrade source. Migration
`0033_fixed_scarlet_witch` added Managed Conversation execution owner identity
and backfilled historical rows as `${provider}.default` without a foreign key.
These historical transformations are not repeated or applied to alpha databases
by stable installation.

CI executes `pnpm db:migrate:acceptance`, including backup/restore and
interrupted-transaction recovery, against disposable databases.

After upgrade, verify API readiness, Postgres, Redis/BullMQ, the Embedding Service,
Worker queues, and core credential/artifact health:

```bash
node packages/koed-server/dist/cli.js setup core --json
node packages/koed-server/dist/cli.js status --json
node packages/koed-server/dist/cli.js doctor --json
```

Core setup validates and reuses an existing local API Token when available. It
does not edit AI Client profiles. When the Koed-owned marker is present and the
registry lacks Codex, core migration registers `codex.default`. Unrelated
detected Codex installations are not selected.
Run `setup codex --json` for explicit Codex repair. Claude Code and Pi register
only after their explicit setup succeeds.

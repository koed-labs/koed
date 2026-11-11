# Upgrades

## Stable baseline and upgrades

Stable installs start with a fresh, empty database. The sole initial migration,
`0000_clean_initial_schema`, establishes that baseline. Existing alpha databases
are not supported upgrade sources: Koed does not migrate, convert, or preserve
their contents in place. Back up alpha data only if needed for reference or
independent recovery; do not restore it as a stable-install conversion path.

After installing this stable baseline, future stable releases evolve through
ordered migrations from that baseline. Use backups for supported recovery of a
compatible installation, not to bridge alpha schema history into stable.

For a fresh installation or a supported stable upgrade, the migration command
is:

```bash
pnpm --filter @koed/db migrate:up
```

Do not point an older application binary at a database with newer migrations.
For rollback, restore a compatible backup together with its matching application
and configuration.

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
does not edit AI Client profiles. Existing Codex-only installations retain their
Codex configuration, token, and Personal Memory; when the Koed-owned marker is
present and the registry lacks Codex, core migration registers `codex.default`
while preserving existing registry entries and Codex config bytes. Unrelated
detected Codex installations are not selected.
Run `setup codex --json` for explicit Codex repair. Claude Code and Pi register
only after their explicit setup succeeds.

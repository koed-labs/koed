# Upgrades

Before upgrading:

1. Stop writes from AI-client integrations.
2. Back up Postgres.
3. Save the current image/version identifier.
4. Pull or build the new version.
5. Start the API so it can run Drizzle migrations, or run migrations manually.

Manual migration command:

```bash
pnpm --filter @koed/db migrate:up
```

For this alpha, the supported forward migration boundary is the exact
current-main schema through `0012` to the current single `0013`. The discarded
experimental `0013_ordinary_sir_ram` Team Chat schema is not an upgrade source
and no compatibility objects are installed for it. If that experimental
migration was applied, restore a pre-`0013` backup (or start with a fresh
database) before upgrading. Do not use an older application binary as the
rollback mechanism after `0013`; restore the backup taken before the upgrade.

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

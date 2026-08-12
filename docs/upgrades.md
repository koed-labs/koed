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

After upgrade, verify API readiness, Postgres, Redis/BullMQ, the Embedding Service, and Worker queues.

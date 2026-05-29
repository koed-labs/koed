# Upgrades

Before upgrading:

1. Stop writes from AI-client integrations.
2. Back up Postgres.
3. Save the current image/version identifier.
4. Pull or build the new version.
5. Run migrations.

Migration command:

```bash
pnpm --filter @koed/db migrate:up
```

After upgrade, verify API readiness, Postgres, Redis/BullMQ, embedding service, worker queues, and history browser access.

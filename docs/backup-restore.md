# Backup And Restore

Back up Postgres regularly. Redis stores queues and should not be treated as the source of truth.

Postgres backups contain sensitive memory data, including captured Memory Events,
Memory Nodes, LCM source evidence and summaries, and embedding metadata. Store
backups in encrypted storage with the same access restrictions as the live
database.

Example backup:

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml exec postgres pg_dump -U koed koed > koed-backup.sql
```

Example restore into a stopped/fresh stack:

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml exec -T postgres psql -U koed koed < koed-backup.sql
```

Keep the deployment `.env` secrets with the backup in a separate secret store so the restored stack can keep using the same token pepper, cookie secret, and reserved encryption key. Do not store secrets inside the backup SQL file.

PDS local data-plane restore includes encrypted retained packages, immutable
closures, outbox/inbox leases, provenance, and convergence quarantine state.
Restore never recreates device private keys or group secrets from Postgres.
Re-inject valid secure runtime references, revalidate current Authority state,
and resume work from durable leases; do not lower deletion floors, lifecycle
high-water, or Authority-log high-water, and do not force a quarantined replica
ready. Restore reconciles current Authority floors before package restore,
materialization, or re-serve; stale relay or backup packages remain rejected.
Governance recovery restores control and retained validated packages only. It
cannot undo a tombstone or recreate missing source bytes. If secure runtime or
authority is unavailable, leave PDS paused—local captured Memory and Recall
remain usable.

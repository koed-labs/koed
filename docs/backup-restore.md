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

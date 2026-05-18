# Backup And Restore

Back up Postgres regularly. Redis stores queues and should not be treated as the source of truth.

Example backup:

```bash
docker compose exec postgres pg_dump -U codex_memory codex_memory > koed-backup.sql
```

Example restore into a stopped/fresh stack:

```bash
docker compose exec -T postgres psql -U codex_memory codex_memory < koed-backup.sql
```

Keep the `API_DATA_ENCRYPTION_KEY` with the backup. Provider API keys cannot be decrypted without the original key.

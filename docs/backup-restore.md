# Backup And Restore

Postgres is the source of truth. Redis contains queues and is not restored as
authoritative state. A supported backup includes collaboration rows, encrypted
field companions, Share Grants and representations, owner-private replicas,
Cross-Identity Sync relationships/cursors, retention and hold state, durable
outbox rows, replay watermarks, key references, and vectors. Never repair a
target by importing vectors from another deployment.

Backups contain sensitive Memory and collaboration data. Encrypt archives,
restrict them like production, and keep the matching configuration and key
provider access in a separate secret store. Do not put secrets in the archive,
manifest, command history, or release evidence.

## Required Secrets

Retain the token pepper, cookie/session configuration, Team/general and
owner-private envelope provider configuration and keys, and these collaboration
secrets:

| Operator environment                       | API child environment                  | Purpose                                 |
| ------------------------------------------ | -------------------------------------- | --------------------------------------- |
| `API_COLLABORATION_LOCAL_BROKER_SECRET`    | `COLLABORATION_LOCAL_BROKER_SECRET`    | Authenticates the local broker boundary |
| `API_COLLABORATION_REALTIME_CURSOR_SECRET` | `COLLABORATION_REALTIME_CURSOR_SECRET` | Signs/encrypts durable realtime cursors |

`koed-server` performs this `API_` to child mapping. Packaged local mode stores
generated unprefixed values in `local-service-secrets.json` under `KOED_HOME`
with mode `0600`. The two values must be distinct. A restore without matching
key material or cursor secret must fail closed; do not regenerate either during
recovery.

## Before Migration

Set `KOED_TEAM_COLLABORATION_ENABLED=false` for every API and Worker, restart
them, confirm `/v1/capabilities` marks Team surfaces unavailable, then stop the
Worker and every remaining application writer. Retention purge deliberately
continues while only the feature switch is off. The switch is atomic across
Team chat, sharing/sync, realtime, and high-risk operations; there are no family
flags.

Check and exercise migrations against a disposable Postgres server:

```bash
pnpm db:migrate:check
DATABASE_URL='postgres://koed:koed@127.0.0.1:5432/koed' \
  pnpm db:migrate:acceptance
```

The acceptance command needs `CREATEDB` and creates/drops its own test database.
Apply migrations to the stopped target with:

```bash
DATABASE_URL='<target Postgres URL>' pnpm --filter @koed/db migrate:up
```

## Compose Backup And Restore

For the bundled example stack, create a plain SQL backup after writes stop:

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml \
  exec -T postgres pg_dump -U koed -d koed > koed-backup.sql
```

Stop the separately supervised API and Worker before restore. The
dependency-only Compose file has no application services. Restore only into an
empty target database:

```bash
docker compose --env-file .env -f examples/docker-compose/docker-compose.yml \
  exec -T postgres psql -U koed -d koed < koed-backup.sql
```

The server Compose example supervises API, Worker, and local dependencies in
the `koed-server` container. Recreate it after changing the switch or restoring:

```bash
docker compose --env-file .env -f examples/server-compose/docker-compose.yml \
  up -d --force-recreate koed-server
docker compose --env-file .env -f examples/server-compose/docker-compose.yml ps
```

Do not use `down -v`; the Postgres volume is part of the recovery state.

## Hosted Backup And Restore Smoke

The hosted workflow creates a custom-format archive, compares content-free
collaboration summaries before and after `pg_dump`, and fails if source data
changes during capture. Encryption is required unless the Operator deliberately
uses `--allow-plaintext` in an already encrypted test environment.

```bash
pnpm hosted:backup -- create --output-dir ./backups \
  --database-url '<source Postgres URL>' \
  --status-path ./backups/backup-status.json

pnpm hosted:backup -- verify --backup-file ./backups/<archive>.dump.enc \
  --status-path ./backups/verify-status.json

pnpm hosted:backup -- restore-smoke \
  --backup-file ./backups/<archive>.dump.enc \
  --target-database-url '<disposable restore Postgres URL>/koed_restore' \
  --confirm-restore-smoke-target koed_restore \
  --status-path ./backups/restore-status.json
```

`restore-smoke` runs `pg_restore --clean` and refuses a production-like or
unconfirmed target. It compares the restored content-free summary, then uses
ciphertext-only synthetic sentinels to validate relationships, key references,
and authorized decryptability. It does not decrypt customer content or mutate
the source.

## Rollback Or Forward Fix

Never point an older application at a database with newer migrations.

- **Rollback:** keep the atomic switch off; stop API and Worker writes; restore
  the pre-change application artifact, database, configuration, and key access
  together; restart; verify Personal operation and Team `404` behavior; then
  run bounded launch validation before enabling Team collaboration.
- **Forward fix:** keep the current database; deploy a migration-compatible
  fixed artifact with the switch off; restart API and Worker; rerun
  `migrate:up`, backup verify/restore-smoke, and launch validation; enable only
  after all gates pass.

Feature disablement preserves collaboration rows and does not revoke Share
Grants, decrypt, delete, migrate, or rewrite data.

## Team-Only Cleanup

Before rollback or backend replacement, use the Desktop disconnect action or,
for a supervised source checkout:

```bash
node packages/koed-server/dist/cli.js upstream disconnect --id <backend-id> --json
node packages/koed-server/dist/cli.js stop --json
node packages/koed-server/dist/cli.js restart --json
node packages/koed-server/dist/cli.js status --json
```

Retry disconnect until its remote revocation and local cleanup phases complete.
For hosted mode, revoke/disable the device credential through the authenticated
backend flow before the rolling API/Worker restart. In all modes, close Team
streams and discard Team subscription IDs, replay cursors, pending Team sends,
and decrypted Team renderer state. Preserve Personal subscriptions, API Tokens,
pending Personal work, and Personal Memory. Never reuse a post-upgrade Team
cursor against a restored pre-upgrade outbox; take a fresh Team snapshot.

Record archive digest, manifest/status paths, source and scratch deployment IDs,
migration range, UTC timestamps, exit status, and content-free comparison
results. Follow the evidence prohibitions and signoff template in
[Collaboration Launch Validation](collaboration-launch-validation.md).

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
remain usable. Recovery kits are separate, explicit 0600 encrypted files, not
backup payloads. Back up each kit only through an offline encrypted secret
workflow; test decrypt/fingerprint verification after restore. Loss of every
active device and every recovery kit permanently loses group control.

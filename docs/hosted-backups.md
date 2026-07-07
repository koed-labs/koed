# Hosted Backups And Restore Checks

Koed hosted/private deployments should back up Postgres with `pg_dump` custom
archives and verify restore viability on a schedule. The first supported
operator path is intentionally plain Postgres tooling so it works on private
VPS, Team Self-Hosted, and Koed-managed cloud infrastructure.

Deterministic restore proof should be recorded with the relevant private launch
or staging record for each target environment.

## Backup

Run from the deployment checkout or a trusted operations host:

```bash
pnpm hosted:backup -- create \
  --output-dir /var/backups/koed/postgres \
  --status-path /var/lib/koed/backup-status.json
```

The command reads `DATABASE_URL` by default, or accepts `--database-url`.
Hosted backups require a configured envelope encryption provider by default:
`API_DATA_ENCRYPTION_KEY` for `local_test_key`, or KMS configuration for
`managed_kms`, `byok`, or `cmek`. The command writes the `pg_dump` output to a
temporary plaintext archive, encrypts it with a file-level envelope, removes
the plaintext archive even if encryption/manifest work fails, and creates:

- an encrypted `pg_dump --format=custom` archive ending in `.dump.enc`;
- a sidecar manifest containing timestamp, redacted database URL, encrypted
  archive size, encrypted archive SHA-256, RPO/RTO metadata, and non-secret
  envelope metadata. Archive ciphertext stays in the `.dump.enc` file, not in
  the manifest;
- a redacted backup status JSON file if `--status-path` or
  `KOED_BACKUP_STATUS_PATH` is set.

`--allow-plaintext` exists only for local/development restore checks. Do not use
it for hosted, private server, Team Self-Hosted, or Koed-managed cloud customer
data.

The status JSON is what `/ops/status` reads for backup freshness. It must stay
free of storage credentials, customer Memory, raw transcripts, database
passwords, provider secrets, raw DEKs, and plaintext backup archive paths.
Successful commands write `status: "ok"`. Failed `create`, `verify`, and
`restore-smoke` runs write `status: "error"` when a status path is configured,
preserve the previous `lastSuccessfulAt` value, and sanitize database URLs in
the error message before returning a non-zero exit. This lets `/ops/status`
alert immediately instead of waiting for backup freshness to expire.

Koed uses Koed-owned Postgres client tools whenever Koed owns the database
runtime. For the Docker Compose starter, hosted backup commands run `pg_dump`,
`pg_restore`, and `psql` inside the `postgres` service container. For
bundled-local native mode, they use the Postgres binaries linked under
`KOED_HOME/runtime/postgres/bin`.

External database operators must provide matching Postgres client binaries.
Newer client tools can emit session settings unsupported by an older server,
which should fail restore verification rather than be ignored. If the host has
multiple Postgres client versions installed, set `PSQL_BIN`, `PG_DUMP_BIN`,
and `PG_RESTORE_BIN` to the matching binaries rather than relying on `PATH`.
`KOED_BACKUP_POSTGRES_CLIENT_MODE` may be set to `docker-compose`, `native`, or
`external` to override auto-detection.

## Verification

At minimum, every scheduled backup should be listed with `pg_restore --list`:

```bash
pnpm hosted:backup -- verify \
  --backup-file /var/backups/koed/postgres/koed-20260703T100000Z.dump.enc \
  --status-path /var/lib/koed/backup-status.json
```

This decrypts the archive to a temporary local file, runs `pg_restore --list`,
deletes the temporary plaintext file, catches missing/corrupt/unreadable
archives, proves key availability, and updates the redacted status file.

## Restore Smoke

Restore testing must target a clean disposable database, never the production
database:

```bash
pnpm hosted:backup -- restore-smoke \
  --backup-file /var/backups/koed/postgres/koed-20260703T100000Z.dump.enc \
  --target-database-url postgres://koed_restore:password@127.0.0.1:5432/koed_restore \
  --confirm-restore-smoke-target koed_restore \
  --status-path /var/lib/koed/backup-status.json
```

The command decrypts to a temporary local file, runs `pg_restore --clean
--if-exists --no-owner --no-acl` into the explicit target URL, and deletes the
temporary plaintext file. The target database name must look disposable
(`restore`, `smoke`, `scratch`, `tmp`, or `test`) and must be repeated with
`--confirm-restore-smoke-target` before destructive restore is allowed.
Operators should create and destroy the disposable target database outside this
command so database ownership, networking, encryption, and access controls match
the deployment environment being tested.

## Schedule And Targets

Use a scheduler owned by the deployment environment. On a single private VPS or
Team Self-Hosted server, `examples/systemd/koed-hosted-backup.service` and
`examples/systemd/koed-hosted-backup.timer` provide the first supported
schedule shape: create an encrypted backup, verify it, restore-smoke it into a
clean disposable database, and update the same redacted status file consumed by
`/ops/status`. Koed-managed cloud may run the same command sequence through the
cloud scheduler instead of systemd, but it must keep the same status-file and
restore-smoke contract.

- Suggested backup cadence: hourly for hosted Team deployments.
- Suggested restore verification cadence: at least daily before hosted launch.
- Initial RPO target: 24 hours.
- Initial RTO target: 4 hours.
- `/ops/status` reports backup status as degraded when no status path is
  configured or when the last successful backup exceeds
  `KOED_BACKUP_MAX_AGE_SECONDS`. A failed scheduled backup, verification, or
  restore-smoke writes `status: "error"`, which `/ops/status` also reports as
  degraded.

## Object And Volume Storage

Postgres is the source of truth for current Team SaaS memory state. Any external
object store used for Memory Inbox source objects, support bundles, sync
packages, or future uploaded content must have its own provider-level retention,
versioning or object-lock setting where available, checksum inventory, and
restore proof. Store object credentials outside backup manifests and status
files.

If a deployment stores runtime files under `KOED_HOME` that are not derivable
from Postgres, source transcripts, or object storage, the Operator must either
include that volume in the infrastructure backup plan or document why it is
rebuildable. Koed logs, local caches, queue scratch data, and temporary
plaintext restore files are not backup sources.

## Retention And Deletion

Backups may contain retained Team-visible knowledge, Personal Memory, audit
events, and tombstoned lifecycle rows. Customer deletion/export workflows must
account for backup retention windows. Until finer-grained backup erasure is
specified, hosted deployments should document the backup retention period and
ensure backups expire according to the retention policy. Hosted backup archives
are encrypted by default, but Operators must still protect the archive,
manifest, status file, encryption key, and restore host.

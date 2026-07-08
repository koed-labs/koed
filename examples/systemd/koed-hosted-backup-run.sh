#!/usr/bin/env bash
set -euo pipefail

backup_json="$(
  pnpm --silent hosted:backup -- create \
    --output-dir "$KOED_BACKUP_DIR" \
    --status-path "$KOED_BACKUP_STATUS_PATH"
)"

backup_file="$(
  node -e 'const fs = require("fs"); const input = fs.readFileSync(0, "utf8"); const parsed = JSON.parse(input); process.stdout.write(parsed.backupFile);' \
    <<< "$backup_json"
)"

pnpm --silent hosted:backup -- verify \
  --backup-file "$backup_file" \
  --status-path "$KOED_BACKUP_STATUS_PATH"

pnpm --silent hosted:backup -- restore-smoke \
  --backup-file "$backup_file" \
  --target-database-url "$KOED_BACKUP_RESTORE_DATABASE_URL" \
  --confirm-restore-smoke-target "$KOED_BACKUP_RESTORE_DATABASE_NAME" \
  --status-path "$KOED_BACKUP_STATUS_PATH"

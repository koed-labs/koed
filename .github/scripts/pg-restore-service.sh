#!/usr/bin/env bash
set -euo pipefail

: "${KOED_CI_POSTGRES_CONTAINER:?KOED_CI_POSTGRES_CONTAINER is required}"

[[ $# -gt 0 ]] || {
  echo "pg-restore-service: backup path is required" >&2
  exit 2
}

backup_path="${!#}"
declare -a forwarded_args=("${@:1:$#-1}")

[[ -f "$backup_path" ]] || {
  echo "pg-restore-service: backup does not exist: $backup_path" >&2
  exit 2
}

declare -a environment_args=(
  -e "PGHOST=${KOED_CI_POSTGRES_HOST:-127.0.0.1}"
  -e "PGPORT=${KOED_CI_POSTGRES_PORT:-5432}"
  -e "PGUSER=${PGUSER:-}"
  -e "PGPASSWORD=${PGPASSWORD:-}"
  -e "PGDATABASE=${PGDATABASE:-}"
)
if [[ -n "${PGSSLMODE:-}" ]]; then
  environment_args+=(-e "PGSSLMODE=$PGSSLMODE")
fi

docker exec -i \
  "${environment_args[@]}" \
  "$KOED_CI_POSTGRES_CONTAINER" \
  pg_restore "${forwarded_args[@]}" <"$backup_path"

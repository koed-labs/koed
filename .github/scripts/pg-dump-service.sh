#!/usr/bin/env bash
set -euo pipefail

: "${KOED_CI_POSTGRES_CONTAINER:?KOED_CI_POSTGRES_CONTAINER is required}"

output_path=""
declare -a forwarded_args=()
while (($# > 0)); do
  if [[ "$1" == "--file" ]]; then
    [[ $# -ge 2 ]] || {
      echo "pg-dump-service: --file requires a path" >&2
      exit 2
    }
    output_path="$2"
    shift 2
    continue
  fi
  forwarded_args+=("$1")
  shift
done

[[ -n "$output_path" ]] || {
  echo "pg-dump-service: --file is required" >&2
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

docker exec \
  "${environment_args[@]}" \
  "$KOED_CI_POSTGRES_CONTAINER" \
  pg_dump "${forwarded_args[@]}" >"$output_path"

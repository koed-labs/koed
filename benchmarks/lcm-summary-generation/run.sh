#!/bin/sh
set -eu

pnpm --filter @koed-labs/evals eval:lcm-summary:live "$@"

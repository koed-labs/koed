#!/bin/sh
set -eu

pnpm --filter @koed/evals eval:lcm-summary:live "$@"

# Experience Replay Benchmark

The Experience Replay benchmark measures whether relevant prior AI Client
experience improves later Terminal-Bench 3.0 task performance. It is not a
standard Terminal-Bench leaderboard run: the relevant condition deliberately
receives a sanitized, pre-verifier trajectory from an earlier attempt on the
same task.

## Boundaries

- Harbor is a locked benchmark-only Python dependency. It is not a Koed
  product service or runtime dependency.
- Koed Memory is populated through canonical Conversation Item ingestion,
  Projection, capture policy and the Embedding Service. Direct database seeding
  is not a valid benchmark path.
- Recall uses the production MCP Server, `memory_answer`, Local AI Runtime and
  AI Client synthesis contracts.
- Source and replay trials use isolated AI Client homes. The normal transcript
  watcher is disabled so unrelated local sessions cannot enter a trial.
- Raw trajectories, databases, MCP configuration and logs are sensitive local
  artifacts. The harness never uploads them and writes run output outside the
  repository.

## Profiles

- `smoke`: deterministic, no paid credentials or external network access.
- `quick`: fixed 12-task CPU subset, one replay per condition.
- `standard`: fixed 24-task CPU subset, two replays per condition.
- `full`: all 74 pinned tasks, three replays per condition.

Model-driven profiles require exact model identities, immutable task and image
digests, a versioned price table, an explicit paid-cost stop, an external
provider spending limit, sufficient disk/capacity and explicit confirmation.
The coordinator fails closed when any required product-path attestation is
unavailable; it never substitutes the deterministic smoke path.

## Commands

```bash
pnpm --filter @koed/evals eval:experience-replay -- preflight --config <file>
pnpm --filter @koed/evals eval:experience-replay -- run --config <file>
pnpm --filter @koed/evals eval:experience-replay -- resume --run <dir>
pnpm --filter @koed/evals eval:experience-replay -- report --run <dir>
pnpm --filter @koed/evals eval:experience-replay -- sanitize --run <dir>
pnpm --filter @koed/evals eval:experience-replay:harbor:test
```

`quick`, `standard` and `full` also require `--confirm-paid-run`. The flag is
only an admission confirmation; the configured provider/account spending limit
is the hard cap. Preparation cost and replay cost are reported separately.

## Cleanup

Every trial owns its database clone, private Redis Unix socket, API, Local AI
Runtime, MCP credential, AI Client homes and child processes. Teardown revokes
credentials first, then terminates processes and removes transient resources.
An interrupted attempt that reached agent start remains a missing outcome and
is never silently rerun as a new scored attempt.

Publication-safe output is generated into a separate directory. Sanitization
never edits raw artifacts in place and fails if a credential-shaped value
remains.

# Hosted Capacity Plan And Load Checks

This is the launch-capacity baseline for hosted Team and private VPS
deployments. It is not a substitute for production telemetry; it is the
repeatable gate that tells us whether the current backend shape has obvious
bottlenecks before hosted traffic is expanded.

Record dated local, staging, private VPS, or managed-cloud capacity proof with
the relevant private launch record. Keep this document as the reusable harness
and threshold reference.

## Baseline Load Assumptions

The default launch-capacity profile models a conservative early hosted cohort:

- 1,000 active Users.
- 20 captured AI-client turns per active User per workday.
- 10 recall or answer lookups per active User per workday.
- 3 Team Workspaces per customer account.
- 2 GB initial Postgres storage budget per 1,000 active Users before
  customer-specific retention policy.
- Hourly hosted backups and daily restore-smoke verification.

These numbers are deliberately plain. If actual activation, capture, recall, or
storage rates exceed them, update this document and rerun the capacity harness
before raising hosted limits.

## Capacity Harness

Run:

```bash
pnpm hosted:capacity -- plan
```

Run a public smoke load against the default local API:

```bash
pnpm hosted:capacity -- run \
  --scenario public-smoke \
  --duration-seconds 60 \
  --concurrency 8
```

Run capture traffic with an API Token:

```bash
KOED_CAPACITY_API_TOKEN=koed_... pnpm hosted:capacity -- run \
  --scenario personal-capture \
  --base-url http://127.0.0.1:3300 \
  --duration-seconds 120 \
  --concurrency 12
```

Run recall traffic after captured data has projected and embedded:

```bash
KOED_CAPACITY_API_TOKEN=koed_... pnpm hosted:capacity -- run \
  --scenario personal-recall \
  --base-url http://127.0.0.1:3300 \
  --duration-seconds 120 \
  --concurrency 12
```

Run Team Workspace answer traffic with a browser session:

```bash
KOED_CAPACITY_SESSION_COOKIE='cm_session=...' \
KOED_CAPACITY_TEAM_WORKSPACE_ID='30000000-0000-4000-8000-000000000001' \
pnpm hosted:capacity -- run \
  --scenario team-workspace-recall \
  --base-url https://koed.example.com \
  --duration-seconds 120 \
  --concurrency 8
```

Run the same Team route with a scoped device credential:

```bash
KOED_CAPACITY_DEVICE_CREDENTIAL='device-key:secret' \
KOED_CAPACITY_TEAM_WORKSPACE_ID='30000000-0000-4000-8000-000000000001' \
pnpm hosted:capacity -- run \
  --scenario team-device-recall \
  --base-url https://koed.example.com \
  --duration-seconds 120 \
  --concurrency 8
```

Run local-edge proxy traffic from a local-edge API to a registered Team backend:

```bash
KOED_CAPACITY_DEVICE_CREDENTIAL='device-key:secret' \
KOED_CAPACITY_TEAM_WORKSPACE_ID='30000000-0000-4000-8000-000000000001' \
KOED_CAPACITY_UPSTREAM_BACKEND_ID='team-vps' \
pnpm hosted:capacity -- run \
  --scenario local-edge-team-recall \
  --base-url http://127.0.0.1:3300 \
  --duration-seconds 120 \
  --concurrency 6
```

Run the private operations status path with a browser session cookie:

```bash
KOED_CAPACITY_SESSION_COOKIE='cm_session=...' pnpm hosted:capacity -- run \
  --scenario ops-status \
  --base-url https://koed.example.com \
  --duration-seconds 60 \
  --concurrency 4
```

When `DATABASE_URL` is available, the harness records before/after snapshots for
database size, conversation item count, Memory Event count, active embedding
count, local queue status counts, and oldest pending/active queue age. When a
session cookie is available, it also captures `/ops/status` before and after the
run. Every run also emits a launch-gate assessment with latency headroom,
error-rate headroom, bottlenecks that fail the configured thresholds, and
operator observations such as missing snapshots, queue backlog, active queue
jobs, queue age, and storage growth.

The harness redacts credentials by never printing API Tokens, browser cookies,
database passwords, raw Memory text, transcripts, prompts, or provider secrets.

## Scenarios

- `public-smoke`: `GET /ready` and `GET /v1/capabilities`.
- `personal-capture`: `POST /v1/memory/capture-personal-event`.
- `personal-recall`: `POST /v1/memory/search`.
- `team-workspace-recall`: `POST /v1/memory/answer` with a browser session
  cookie and Team Workspace id.
- `team-device-recall`: `POST /v1/memory/answer` with a scoped Koed-Device
  credential and Team Workspace id.
- `local-edge-team-recall`: `POST /v1/local-edge/team-memory/answer` for Team
  Workspace answer proxying to a registered upstream backend.
- `ops-status`: `GET /ops/status`.
- `mixed`: public smoke plus capture, recall, graph overview, Team Workspace
  recall, local-edge Team proxying, and operations status where the relevant
  credentials are available.

## Launch Gate

Default pass thresholds:

- p95 API latency below 1,000 ms for the selected scenario.
- Error rate below 1%.
- No unexplained growth in failed queue jobs.
- No runaway active queue jobs after the run completes.
- Database and storage growth matches the test shape.
- Embedding progress is visible for capture-heavy runs once the Worker and
  Embedding Service have had time to drain the queue.

Any failed gate should become a Linear issue before launch. A local laptop run
can catch regressions, route/auth mistakes, and pathological queue behavior, but
the paid-launch decision should use the same harness against the intended VPS,
Team Self-Hosted, or Koed-managed cloud environment.

## Scaling Triggers

Revisit infrastructure sizing when any of these hold during staging runs:

- p95 API latency exceeds 1,000 ms for capture or recall under expected launch
  load.
- Recall p95 grows with database size faster than expected after embeddings are
  warm.
- Queue waiting depth keeps increasing after traffic stops.
- Embedding throughput cannot clear a normal workday capture spike before the
  next workday.
- Postgres storage growth exceeds the retention budget.
- Backups or restore-smoke verification cannot complete inside the RPO/RTO
  target from [hosted-backups.md](hosted-backups.md).

## Reporting

Attach each staging capacity report to the launch validation thread or the
relevant Linear issue. Include:

- deployment target and git revision;
- scenario, duration, and concurrency;
- total requests, p95 latency, p99 latency, error rate, and status codes;
- p95/error-rate headroom plus any bottlenecks or watch observations;
- queue deltas and embedding deltas;
- database/storage deltas;
- follow-up issues for any failed threshold.

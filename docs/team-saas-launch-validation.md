# Team SaaS Launch Validation

This is the runnable launch checklist for the first Team SaaS release. It uses
the deterministic Team SaaS fixture as the known data world, then separates
what is already automated from the gates that still need a human or staging
environment.

## Commands

Run from the repository root.

```bash
pnpm team-fixture:seed
pnpm team-launch:validate
pnpm team-launch:validate --with-automated-tests
pnpm team-launch:validate --with-staged-remote \
  --base-url https://koed.example.com \
  --session-cookie 'cm_session=...' \
  --device-credential 'device-key:secret' \
  --api-token koed_...
```

`pnpm team-fixture:seed` resets only the synthetic fixture rows, seeds the
fixture, runs migrations, and validates the fixture's access expectations.

`pnpm team-launch:validate` validates the seeded fixture and prints the launch
validation report. It does not re-run the focused repository test suites by
default; the report marks those backing tests as `not_run`.

`pnpm team-launch:validate --with-automated-tests` validates the fixture and
then runs the focused API, DB, encryption, backup, database-role, capacity, and
launch-validation tests that back the non-fixture automated gates. Use this for
full local/disposable-staging launch validation before treating the automated
gate list as passed. The harness runs those tests in a separate process
environment without inheriting the deployment profile, encryption keys, KMS
credentials, WorkOS credentials, staged route credentials, or service endpoints
from the target deployment. Required token and session secrets are generated
for the test run, and child processes run with `NODE_ENV=test`.
Profile-specific tests configure and verify their intended profile explicitly.

Repository tests never run against the fixture database because they truncate
tables by design. By default, the harness creates a uniquely named disposable
database on the same PostgreSQL server and removes it after the run, including
after a failed gate. The `DATABASE_URL` user therefore needs `CREATEDB` for this
command. Operators without that permission must set
`KOED_LAUNCH_TEST_DATABASE_URL` to a different disposable database. That
database is destructive test infrastructure and must never be the fixture,
staging, or production database; the harness rejects an exact fixture-database
match and verifies the runtime server identity of an explicitly supplied test
database. A genuinely separate server may use the same database name.

`pnpm team-launch:validate --with-staged-remote` validates the fixture and also
probes a running hosted/private backend over HTTP. It proves public and
authenticated capability discovery are reachable without leaking secrets, Team
Workspace answer and graph routes accept browser sessions and scoped device
credentials, scoped device credentials can call Team Workspace search, browser
sessions can call graph detail/expand routes, API Tokens cannot enter Team
Workspace recall or graph routes, and no staged credential value is echoed in
JSON responses. It uses deterministic fixture Workspace and node IDs by default.
Set
`KOED_LAUNCH_LOCAL_EDGE_BASE_URL` and `KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID` when a
local-edge instance should also proxy the Team answer route through
`/v1/local-edge/upstream-operations`.

The report is suitable for local or disposable staging validation databases. Do
not seed the deterministic fixture into production. `API_TOKEN_PEPPER` is
required because the Auth launch gate depends on seeded deterministic API
sessions. If the fixture was seeded without `API_TOKEN_PEPPER`, run
`pnpm team-fixture:seed` again after configuring it.

## Automated Gates

The fixture validation command directly covers:

- Synthetic user sessions when `API_TOKEN_PEPPER` is configured.
- Team and Workspace data shape.
- Authorized Team-visible recall of shared personal memory.
- Revoked-share and private-memory exclusion.
- Removed Workspace member access loss with Team-retained knowledge.
- Personal soft-deletion with Team-retained recall.

The `--with-automated-tests` path additionally runs focused repository tests
for:

- Authorization-before-decrypt guardrails for encrypted Memory companions on
  implemented personal and Team Workspace paths.
- Remote Team route contracts: Team Workspace recall, graph, source expansion,
  and Evidence Bundle routes require browser sessions or scoped device
  credentials, while API Tokens remain personal-memory only.
- Local-edge fail-closed behavior for stale credentials, stale capabilities,
  disabled upstream route policy, and disabled/private/paused Capture Policy.
- Candidate-selection and provenance boundaries: revoked Workspace Access,
  revoked Share Grants, and private memory are excluded before decrypt, rerank,
  source expansion, evidence construction, or display.
- Encrypted fixture-boundary regressions for shared, private, revoked,
  removed-member, and suspended-entitlement cases. These assert authorization
  happens before decrypt and raw Memory is absent from encrypted storage
  companions, local queue payloads, audit metadata, API request logs, and
  diagnostics.
- WorkOS/AuthKit identity mapping remains separate from Koed authorization:
  mapped Users still require Team membership, Workspace Access, Share Grants,
  and entitlement allowance.
- Redacted API request logging, status, diagnostics, queue-count, backup, and
  hosted operations surfaces for raw Memory and secret sentinels.
- Staged remote HTTP probes for the same Team Workspace route contracts when
  run with `--with-staged-remote` against a seeded target backend, including
  public/authenticated capability discovery and API-token rejection from Team
  answer and graph routes.

Each printed gate command uses explicit Vitest file and test-name filters. A
failed command stops the run, identifies the failed gate, exits non-zero, and
still removes an automatically provisioned test database.

## Manual Gates

These remain manual until the Electron app and cloud-only modules expose stable
test surfaces:

- Electron connects to the target backend and shows the correct account context.
- Electron guides MCP Server and Supported Capture Hook setup.
- A real captured session can be shared, recalled by another member, and
  inspected through the UI.
- Browser-level checks should confirm the automated remote-Team route contracts
  are visible in the app state and cannot be bypassed through stale local
  settings.
- Staging support/admin workflows prove customer content is not visible unless a
  separately approved break-glass flow exists.

## Staging Gates

These need the staging cloud backend or a dedicated staging stub:

- Billing and seat-state transitions: paid, grace, plan-limited, and blocked.
- Audit log, health checks, error logs, and launch-path alerting.
- Staged local-edge proxy validation from a local-edge API to a registered
  upstream backend, using a scoped `Koed-Device` credential.

Any failed launch blocker should be linked to a Linear ticket before release.

## Relationship To The Fixture

The fixture is the shared synthetic data set. This launch validation layer is
the release gate on top of it. If a critical-path behavior is missing from the
fixture, extend the fixture first, then add the launch gate here.

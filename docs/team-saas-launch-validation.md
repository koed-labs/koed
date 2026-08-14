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
pnpm team-launch:validate --with-staged-remote
```

For staged validation, supply target URLs and credentials through the
`KOED_LAUNCH_*` environment variables listed in
[Configuration](configuration.md). Use an ephemeral shell or deployment secret
injection; do not place bearer values in shell history, committed files, or the
validation report.

`pnpm team-fixture:seed` resets only the synthetic fixture rows, seeds the
fixture, runs migrations, and validates the fixture's access expectations.

`pnpm team-launch:validate` validates the seeded fixture and prints the launch
validation report. Unlike `team-fixture:validate`, this is a semantic-readiness
gate: every active Team-visible fixture representation must have
`embedding_state=embedded`, complete model provenance, and a vector in the
dimension-matched Team vector table. `pending` and `processing` fail the launch
command. Run the normal Worker embedding reconciliation or
start the Team-enabled Worker after seeding, wait for its Shared Memory
embedding reconciler to finish, then rerun launch validation. The generic
`pnpm embeddings:backfill` command does not replace this Team reconciliation.
Launch validation does not re-run the focused repository test suites by
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

The Conversation Source Access gate starts with deterministic fixture rows for
independent source grants, encrypted exact reads, snapshot and continuous
boundaries, revocation, and audit events. Its focused API suite then covers
Personal API Token denial, completed-turn fork export, credential-bound SSE
reauthorization, idle consent expiry, and authorization-loss closure.

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
authenticated capability discovery are reachable without leaking secrets, and
browser sessions and scoped device credentials can use the dedicated Shared
Memory Workspace Share Grant list, representation timeline, and representation
detail APIs. After normal embedding reconciliation, the same credentials can
use Team semantic search, answer evidence, and grant-scoped candidate
expansion. The generic Team graph and graph detail remain unavailable. No
staged credential value may be echoed in JSON responses. The harness also reads
the target's current
capabilities and OpenAPI contract, then attempts every active Team,
collaboration, Shared Memory, retention, high-risk, and realtime operation with
the supplied Personal API Token. Every attempt must fail at authentication with
`401` or `403`; request validation, resource lookup, and mutation must not run.
Routes excluded from the advertised deployment profile are not treated as
active test cases. The harness uses deterministic fixture Workspace and node IDs
by default.
Set `KOED_LAUNCH_BROWSER_ORIGIN` or pass `--browser-origin` with the exact
browser origin accepted by the target deployment. Session-authenticated write
probes send that origin together with same-site browser metadata so the harness
exercises the production CSRF boundary instead of bypassing or accidentally
failing before route authorization.
Set
`KOED_LAUNCH_LOCAL_EDGE_BASE_URL` and `KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID` when a
local-edge instance should also prove `/v1/local-edge/team-memory/search`,
`answer`, and `expand` proxy successfully with the scoped local device
credential while a Personal API Token is denied.

The report is suitable for local or disposable staging validation databases. Do
not seed the deterministic fixture into production. `API_TOKEN_PEPPER` is
required because the Auth launch gate depends on seeded deterministic API
sessions. If the fixture was seeded without `API_TOKEN_PEPPER`, run
`pnpm team-fixture:seed` again after configuring it.

## Automated Gates

The base launch validation command directly covers:

- Synthetic user sessions when `API_TOKEN_PEPPER` is configured.
- Team and Workspace data shape.
- Authorized listing and reading of Shared Memory representations through
  dedicated Share Grant list/timeline/detail APIs.
- Revoked-share and Personal Memory exclusion from those representation APIs.
- Removed Workspace member access loss with Team-retained knowledge.
- Personal soft-deletion with a retained Shared Memory representation.
- Decrypted fidelity for Memory Event, LCM leaf, LCM rollup, and Curated Memory
  Team representations, with authorized reads and disabled, removed,
  Workspace-disabled, revoked, and Personal Memory denial cases.
- Completed semantic embeddings for every active Team-visible fixture
  representation. A status-only `embedded` row is insufficient unless its
  dimension-matched vector and model provenance also exist.

The `--with-automated-tests` path additionally runs focused repository tests
for:

- Authorization-before-decrypt guardrails for encrypted Memory companions on
  implemented Personal Memory and Shared Memory representation paths.
- Remote route contracts: browser sessions and scoped device credentials use
  dedicated Shared Memory Share Grant list/timeline/detail APIs plus semantic
  search, answer evidence, and candidate expansion. Generic graph surfaces
  remain unavailable. API Tokens remain Personal Memory only.
- Local-edge fail-closed behavior for stale credentials, stale capabilities,
  disabled upstream route policy, and disabled/private/paused Capture Policy.
- Representation boundaries: revoked Workspace Access, revoked Share Grants,
  and Personal Memory are excluded before Shared Memory decrypt or display.
- Explicit Team Curated Memory representation boundaries: exact-session direct
  roles, mixed-session and missing-source rejection, recursive LCM descendant
  closure, three-key encryption separation, and immediate semantic purge after
  assertion or source invalidation.
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
- Staged remote HTTP probes for the same Shared Memory route contracts when
  run with `--with-staged-remote` against a seeded target backend, including
  positive grant/list/timeline/detail reads, fail-closed generic Team-memory
  surfaces, public/authenticated capability discovery, and generated API-token
  rejection coverage for every active Team-authority route advertised by
  OpenAPI.
- A deterministic Approval Activity package comparison. The fixture uses 38
  Memory Events, one LCM leaf, and a 412 KiB display projection. The command
  reports content-safe record counts, byte counts, and encryption times.

Each printed gate command uses explicit Vitest file and test-name filters. A
failed command stops the run, identifies the failed gate, exits non-zero, and
still removes an automatically provisioned test database.

## Desktop And Manual Gates

`pnpm --filter @koed/desktop test:browser` exercises the built Electron
collaboration surface, including Team and Workspace navigation, Shared Memory,
companion discussion, invitations, realtime update application, reconnect, and
revocation state clearing. It is local UI evidence; it does not replace a
multi-User staged pass.

The staged pass verifies enrollment and account context, a real synchronized
Captured Session shared to another member, live channel and companion updates
without refresh, Workspace read/write boundaries, revocation state clearing,
and Personal availability during a Team-backend outage. Support or
administrative content access requires the separately approved break-glass
flow; ordinary support surfaces must remain content-free.

Use the
[Two-User VPS Dogfood Runbook](two-user-vps-dogfood-runbook.md) for the
repeatable two-Desktop procedure, including isolated local profile state,
database reset rules, per-representation sharing checks, restart/catch-up, and
negative authorization tests.

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

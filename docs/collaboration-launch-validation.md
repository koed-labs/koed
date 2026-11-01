# Collaboration Launch Validation

Run this procedure after a fresh deployment, upgrade, restore, rollback, or
forward fix. Use only the deterministic fixture or a disposable staged tenant.
Do not run destructive test commands against a production database.

## Release Gate

Team collaboration has one atomic, fail-closed switch:
`KOED_TEAM_COLLABORATION_ENABLED`. It must be exactly `true` or `false` and must
have the same value in API and Worker processes. `false` disables Team chat,
Team sharing and Cross-Identity Sync, Team realtime, enrollment/upstream Team
routes, Team-scoped Memory, replay-prune jobs, support/lifecycle routes, and
device-mediated high-risk operations. Retention purge enforcement continues as
safety maintenance for already-retained data. Personal collaboration,
Personal Memory, Projection, embedding, and LCM work remain available. There
are no independently deployable feature flags for those Team families.

## Evidence Rules

Retain only:

- immutable commit, artifact digest, deployment label, CI run, and fixture
  version;
- command, UTC start/end time, exit status, test counts, HTTP status, safe error
  code, bounded queue counts, and named log events;
- redacted screenshots containing fixture display names and fixture content;
- backup manifest/status output, migration names, and pass/fail summaries.

Never retain customer Memory or chat content, prompts, search text, request or
response bodies, cookies, bearer/device/API tokens, token prefixes, passwords,
connection strings, encryption material, raw headers, package bytes/manifests,
vectors, decrypted database values, or raw exception traces. Store secrets in
the CI/staging secret mechanism, not shell history or the release record.

## Automated Commands

From the repository root, install and build the exact commit, then run the
cheap CI-equivalent gates:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm fmt:prettier:check
pnpm lint
pnpm typecheck
pnpm typecheck:test
pnpm db:migrate:check
DATABASE_URL='postgres://koed:koed@127.0.0.1:5432/koed' pnpm db:migrate:acceptance
DATABASE_URL='postgres://koed:koed@127.0.0.1:5432/koed' REDIS_URL='redis://127.0.0.1:6379' pnpm test:required-suites
```

`db:migrate:acceptance` creates and drops a disposable database on the named
server. Its database user needs `CREATEDB`; set
`KOED_MIGRATION_SMOKE_DATABASE` and `KOED_MIGRATION_SMOKE_ADMIN_DATABASE` only
when the defaults are unsuitable.

Seed and validate the deterministic multi-user state. `DATABASE_URL` is the
fixture database; the automated tests use a different disposable database.

```bash
pnpm team-fixture:reset
pnpm team-fixture:seed
pnpm team-fixture:validate
KOED_LAUNCH_TEST_DATABASE_URL='postgres://koed:koed@127.0.0.1:5432/koed_launch_test' \
  pnpm team-launch:validate --with-automated-tests
pnpm --filter @koed/desktop test:browser
```

Build and smoke the packaged Desktop on the current macOS or Linux host:

```bash
pnpm desktop:package:smoke -- --build --json --timeout-ms 420000 \
  --diagnostics-dir "${TMPDIR:-/tmp}/koed-desktop-smoke-diagnostics"
```

On a release runner with verified pinned models already cached, add
`--embedding-model-source <gguf>` to make Personal/Base smoke independent of
model-host availability. The packaged CLI verifies the pinned embedding hash
after pre-seeding. Packaged lifecycle smoke uses the real Desktop manager's
private IPC harness. Team coverage proves missing verified Privacy assets fail
closed; positive Team provisioning requires complete matching-version pins embedded
in the trusted control plane and actual native lifecycle acceptance. Component
signer roots are not prerequisites. Do not treat negative coverage as positive Team proof.

CI must pass the `Check DB migration files`, `Run DB migration acceptance
matrix`, `Required acceptance suites`, build, and packaged Desktop smoke jobs
for the same commit. Do not substitute a local pass for a missing CI job.

## Desktop approval validation

Use the [live Desktop action inventory](desktop-approval-ux.md#live-desktop-action-inventory),
[ADR 0024](adr/0024-tiered-desktop-action-approval.md), and the
[action credential matrix](team-collaboration-action-credential-matrix.md).
The accepted ADR and backend policy take precedence over historical proposal text.
Use the deterministic fixture or a disposable staged tenant with separate Desktop
state. Preserve model caches and keep fixture databases separate from test databases.

For every inventory action and risk-sensitive branch, record these boundaries:

1. Start from current authoritative Team, Workspace, invitation, grant, or device state.
2. Initiate the action through its normal Desktop control.
3. Check that the backend selects the tier from authoritative action context.
4. Check that the local edge accepts only that tier and keeps credentials outside renderer state.
5. Check the ceremony: Direct, exact in-app Native review, or independently authenticated browser Step-up.
6. Cancel and reject stale or expired reviews before checking successful execution.
7. Check exact one-use grant consumption or authoritative pre-consumption denial.
8. Check that Desktop reconciles the result without a stale pending state.
9. Check that bundled consent and source-download stages remain separately auditable without extra prompts.

Record the selected tier, redacted request status, visible consequence, mutation
result, and mismatch. Never record credentials or grant secrets. Exercise all
risk branches rather than using one manual action as proof of the entire inventory.
Use focused shared-contract, backend approval-policy, local-edge grant-control,
Desktop reconciliation, and API-hosted browser checks when those boundaries change.

For browser Step-up, the five-minute grant expiry continues during sign-in.
After expiry, the page must stay inert and show safe-close guidance. Request a
new exact grant. A stale browser session must authenticate before actionable
controls appear. Approval cannot override current Team or Workspace authority.

Use the identity providers advertised by `/v1/capabilities`. WorkOS-only deployments
must return to the same exact activation after verified authentication. Local
password or developer-profile checks do not qualify a real WorkOS tenant.
For sharing, check the current single-review flow for consent and durable Pending
Share acceptance. Exercise detail expansion and reduction separately.

## Sharing performance measurements

From the repository root, run the synthetic package measurement when qualifying
Approval Activity handling:

```bash
pnpm approval-activity:measure-sharing
```

The command uses the production Cross-Identity Sync schema and envelope encryption.
It checks control digests and record/byte invariants without printing Memory or keys.
Synthetic measurements do not establish before/after performance for an unavailable
original Captured Session or a target deployment.

Use content-safe route durations and bounded Pending Share stages, timestamps,
retry counts, and redacted failure codes to measure acceptance through activation.
Check that acceptance returns before background activation and that owner-only
lifecycle events reconcile without polling. Preserve publication authority and
source/consent bindings through replacement and restart.

Staged qualification must cover two Users, every semantic representation,
revocation, exact Conversation Source Access, and a two-host network interruption.
Measure frame time under the target deployment's load against the existing 100 ms
limit. Track missing comparable-source measurements and unresolved staging gates
in the backlog rather than treating synthetic or local passes as completion.

## Staged Remote Probe

Inject values through the staging secret runner. Do not paste them into a
shared terminal transcript:

```bash
export KOED_LAUNCH_BASE_URL='https://staging-api.example.invalid'
export KOED_LAUNCH_BROWSER_ORIGIN='https://staging.example.invalid'
export KOED_LAUNCH_SESSION_COOKIE='<secret Cookie header>'
export KOED_LAUNCH_DEVICE_CREDENTIAL='<secret Koed-Device value>'
export KOED_LAUNCH_API_TOKEN='<secret Personal API Token>'
export KOED_LAUNCH_TEAM_WORKSPACE_ID='<fixture Workspace UUID>'
export KOED_LAUNCH_TEAM_NODE_ID='<fixture Memory Node UUID>'
export KOED_LAUNCH_LOCAL_EDGE_BASE_URL='http://127.0.0.1:3300'
export KOED_LAUNCH_LOCAL_EDGE_BACKEND_ID='<registered backend id>'
pnpm team-launch:validate --with-staged-remote
```

The staged probe requires the seeded fixture, proves browser and device paths,
proves Personal API Token rejection, and proves scoped device credentials can
use local-edge Team semantic search, answer, and candidate expansion when both
local-edge variables are supplied.

## Actor-By-Actor Manual Flow

Use separate browser profiles and Desktop state for every actor. Start with
`pnpm team-fixture:reset && pnpm team-fixture:seed`; record fixture version and
case labels, never entity identifiers, credentials, or content.

For a live two-User Private VPS or Team Self-Hosted pass, follow the
[Two-User VPS Dogfood Runbook](two-user-vps-dogfood-runbook.md). It defines the
local profile isolation, reset/start order, remote enrollment, real Captured
Session sharing, representation-level checks, and restart behavior that the
fixture flow below does not reproduce.

1. **Alice, owner:** sign in, enroll one local edge, open the Electron
   Workspace channel, send one message with a unique idempotency key, retry the
   same send, and observe one message. Share Alice's eligible fixture session,
   approve its representation, open the companion discussion, and confirm the
   Team timeline updates without polling.
2. **Bob, member:** sign in separately. Read and reply in Electron, mark it
   read, and open the active Electron shared session. Confirm Bob cannot read
   Cloud Workspace chat or Memory because his Cloud Workspace Access is
   disabled. Confirm Bob's Personal notes are visible only to Bob.
3. **Carol, admin:** confirm the Alice/Bob direct message is absent. Exercise a
   Direct additive action, a Native-review reversible action, and a Step-up
   privilege/access-removal action. Confirm only Step-up opens the browser;
   stale, reused, downgraded, or altered grants are rejected; and each
   successful action is audited once.
4. **David, member:** confirm the revoked Electron share is absent while his
   Personal source remains available to David. Confirm no revoked companion
   discussion or representation can be opened.
5. **Erin, read-only member:** read the Ingestion Workspace and confirm write,
   share-management, and high-risk attempts fail.
6. **Dana, disabled member:** confirm Team catalog, chat, Shared Memory,
   realtime, and high-risk routes reveal no Team content.
7. **Frank, removed/non-member:** confirm the same Team denials while Personal
   state remains usable.
8. **Realtime recovery:** as Alice, take a Team snapshot and high-water cursor,
   apply and acknowledge Bob's next event, reconnect from that cursor, and
   confirm no duplicate. Replace the subscription and confirm the old stream
   closes. Use an expired cursor or revoke access and confirm Team state clears
   before one authoritative resnapshot.
9. **Atomic disable:** set `KOED_TEAM_COLLABORATION_ENABLED=false` for API and
   Worker and restart both. Confirm `/v1/capabilities` reports Team
   collaboration, Team Workspaces, Share Grants, Cross-Identity Sync, and
   enrollment unavailable; Team routes return `404`; Personal notes, Personal
   realtime, Personal Memory, Projection, embedding, and LCM still work. Verify
   retention purge safety maintenance remains active without admitting new Team
   work.

## Backup, Rollback, And Forward Fix

Before migration, disable Team collaboration and restart API and Worker, then
stop the Worker and all remaining writers before creating and verifying a backup
using [Backup And Restore](backup-restore.md).
Never run an older binary against a database with newer migrations.

For rollback, restore the pre-change application artifact, database backup,
environment, and encryption providers as one unit. Clear Team-only local state
as described below, start services with the switch `false`, rerun Personal and
Team-denial checks, then enable the switch and repeat staged validation.

For a forward fix, leave the database at its current migration, deploy the
compatible fixed artifact with the switch `false`, restart API and Worker,
rerun migrations, backup verification, required suites, and Team-denial checks,
then enable and repeat staged validation. Record which path was used.

## Team-Only Disconnect And Restart

- **Supervised `koed-server`:** disconnect each registered Team backend with
  `node packages/koed-server/dist/cli.js upstream disconnect --id <backend-id> --json`.
  Retry until remote revocation and local cleanup complete. Then run
  `node packages/koed-server/dist/cli.js stop --json`, set the switch, run
  `node packages/koed-server/dist/cli.js restart --json`, and verify with
  `node packages/koed-server/dist/cli.js status --json`. Do not delete
  `KOED_HOME`, Personal credentials, or Personal state.
- **Compose:** set the switch in the Compose environment, then run
  `docker compose --env-file .env -f examples/server-compose/docker-compose.yml up -d --force-recreate koed-server`
  and `docker compose --env-file .env -f examples/server-compose/docker-compose.yml ps`.
  Use the Desktop disconnect action before recreation for enrolled local edges;
  do not remove Postgres volumes.
- **Hosted:** revoke/disable enrolled Team device credentials through the
  authenticated backend flow, set the same switch on every API and Worker
  replica, perform a rolling restart, and verify old Team streams close and all
  replicas advertise the same capabilities. Keep Personal services running.

In every mode, close Team windows/streams, discard Team subscription IDs,
replay cursors, pending Team sends, and decrypted Team renderer state, then take
a fresh Team snapshot after re-enable. Preserve Personal subscriptions, pending
Personal work, API Tokens, and Personal Memory.

## Monitoring And Decision

Manually test the post-enable path through one successful Cross-Identity Sync
cycle. Apply the thresholds and queries in [Observability](observability.md).
Any authorization leak, successful Team use by an API Token,
decryptability/key failure, retained-content exposure, replay gap, retention
terminal failure, or nonzero failed sync state triggers immediate atomic
disablement. Repeated transient failures or stale sync state trigger a forward
fix while the switch remains off.

## Release And Signoff Record

```yaml
release:
  commit: "<sha>"
  artifact: "<immutable id and digest>"
  deployment: "<environment/id>"
  migration: "<from/to migration and result>"
  switch_initial: false
  switch_enabled_at_utc: "<timestamp or not-enabled>"
evidence:
  ci_run: "<URL/id>"
  required_suites: "<pass/fail>"
  fixture_validation: "<report id>"
  staged_probe: "<report id>"
  packaged_desktop_smoke: "<artifact/result>"
  backup_manifest: "<content-free id/result>"
  restore_smoke: "<target/result>"
  rollback_or_forward_fix: "<path/result>"
  atomic_disable_test: "<result>"
  manual_actors: "<Alice/Bob/Carol/David/Erin/Dana/Frank results>"
monitoring:
  window_utc: "<start/end>"
  ops_status_samples: "<locations/results>"
  log_query_results: "<content-free summary>"
  triggered_conditions: []
decision:
  residual_risks: []
  release_owner: "<name, approve/reject, timestamp>"
  security_reviewer: "<name, approve/reject, timestamp>"
  operations_reviewer: "<name, approve/reject, timestamp>"
```

A missing command result, observation window, or required decision is a failed
release gate.

# Desktop Approval Tier Validation

## Purpose

This document records a disposable local validation of every row in the
[Live Desktop Action Inventory](desktop-approval-ux.md#live-desktop-action-inventory).
It is both a reproducible runbook and the observed-behavior ledger for the
current worktree.

Validation date: 2026-08-03

Target topology:

- Koed Desktop and its local edge run from the current source checkout.
- The Team Backend runs in the isolated local Docker Compose stack at
  `http://127.0.0.1:3300`.
- Explorer runs at `http://127.0.0.1:5174`.
- The backend uses the `developer` profile with the explicit developer-only
  Team-backend capability switch. This does not represent the identity setup
  for Team Self-Hosted or Koed-managed cloud.

## Evidence Standard

Each inventory row needs evidence at the boundaries relevant to its proposed
tier:

1. The shared Desktop command contract admits only the declared intent.
2. The Team Backend selects the tier from authoritative action context.
3. The local edge accepts only the backend-selected tier and keeps device
   credentials and Action Grant secrets outside renderer state.
4. Desktop presents the matching ceremony: none for Direct, an in-app exact
   review for Native review, or independent browser authentication for Step-up.
5. The exact one-use grant executes once and Desktop reconciles the
   authoritative result.
6. Bundled stages remain separately auditable without presenting an
   independent User prompt.

`Confirmed` means the focused automated boundary evidence matches the accepted
policy. The evidence column distinguishes rows that also received a manual
fresh-stack Desktop tracer from rows covered by the automated Desktop, local
edge, Team Backend, repository, and Explorer boundaries. `Mismatch` means the
deployed behavior differs from the accepted policy. Manual tracers sample each
ceremony class; they are not presented as a substitute for the exhaustive
branch suites.

## Validation Flow

### 1. Establish the inventory and expected policy

1. Read `docs/desktop-approval-ux.md`, especially the 18-row Live Desktop
   Action Inventory.
2. Read `docs/adr/0024-tiered-desktop-action-approval.md`; the accepted ADR and
   backend policy are authoritative where the original proposal retains
   historical wording.
3. Read the deterministic Team fixture truth sheet and launch-validation
   checklist before creating assertions:
   `docs/team-saas-synthetic-fixture.md` and
   `docs/team-saas-launch-validation.md`.

### 2. Reset only the disposable local server stack

Resolve the target before deletion:

```bash
docker compose --env-file .env \
  -f examples/server-compose/docker-compose.yml ps --all
docker volume ls \
  --filter label=com.docker.compose.project=server-compose \
  --format '{{.Name}}'
```

Stop the stack, then remove only the disposable server-state volumes:

```bash
docker compose --env-file .env \
  -f examples/server-compose/docker-compose.yml down --remove-orphans
docker volume rm \
  server-compose_koed-device-proof \
  server-compose_koed-server-data \
  server-compose_postgres-data \
  server-compose_redis-data
```

Preserve `server-compose_embedding-model-cache`; model files are not test data
and do not affect authorization state.

### 3. Deploy and prove a fresh backend

```bash
docker compose --env-file .env \
  -f examples/server-compose/docker-compose.yml up -d --build
docker compose --env-file .env \
  -f examples/server-compose/docker-compose.yml ps
curl --fail --silent --show-error http://127.0.0.1:3300/ready
curl --fail --silent --show-error http://127.0.0.1:3300/v1/capabilities
```

Before seeding or creating a User, verify that the new Postgres volume contains
no prior Team or User rows. Do not print encryption keys, session cookies,
device credentials, or fixture bearer values into the report.

Observed on 2026-08-03:

- PostgreSQL, Redis, the embedding service, and Koed server all reached Docker
  `healthy` status.
- `/ready` reported `ok` for API, PostgreSQL and its version, migrations,
  pgvector, Redis, the embedding service and model, and the work queue.
- `/v1/capabilities` reported schema version 6, release `0.4.4`, the
  `developer` deployment profile, local authentication and device enrollment,
  and `partial` Team Workspaces, collaboration, and Share Grants.
- A direct aggregate query returned `0|0|0` for Users, Teams, and Team
  memberships before bootstrap.

### 4. Bootstrap deterministic actors and Desktop enrollment

1. While the database still has no Users, create the validation User through
   the supported local setup helper. Run it from the repository root and enter
   the email, display name, and password interactively so no credential is
   written to this report or shell history:

   ```bash
   ./register.sh
   ```

   The helper sends the entered values to the loopback-only `POST /auth/setup`
   endpoint. It unsets its password variable on exit. Keep the chosen password
   available for the later browser-authenticated enrollment and Step-up checks.

2. Seed and validate the synthetic Team fixture only after confirming the
   target profile is the isolated local `developer` profile. The server
   Compose topology intentionally keeps Postgres private, so run the fixture
   commands inside the `koed-server` container:

   ```bash
   docker compose --env-file .env \
     -f examples/server-compose/docker-compose.yml exec -T koed-server \
     pnpm team-fixture:seed
   docker compose --env-file .env \
     -f examples/server-compose/docker-compose.yml exec -T koed-server \
     pnpm team-fixture:validate
   docker compose --env-file .env \
     -f examples/server-compose/docker-compose.yml exec -T koed-server \
     pnpm team-launch:validate --with-automated-tests
   ```

   Observed: the seed created and validated 7 synthetic Users, 3 Workspaces,
   13 memories, and 6 collaboration threads. The dedicated validator passed
   every documented visibility, revocation, retained-knowledge, decryption,
   collaboration, and encrypted-at-rest assertion. The broader launch
   validator passed migration acceptance, required collaboration,
   authorization, realtime, IPC, UI, accessibility, Personal Device Sync,
   tenant-boundary, API-runtime, and hosted-operations gates. Its containerized
   Electron command could not start because the server image has no Linux GUI
   libraries, so the exact Desktop Electron interaction gate was run on the
   macOS host instead.

3. Register the fresh Docker backend in Desktop, refresh capability schema 6,
   and enable only the route families needed by the inventory.
4. Start device enrollment, inspect the exact requested operation families in
   Explorer, approve through the authenticated browser session, exchange the
   credential, and activate the backend.
5. Confirm Personal Memory remains local and the renderer never receives the
   upstream credential or Action Grant secret.

For Step-up validation, the five-minute Action Grant clock continues while the
User signs in. If authentication finishes after expiry, Explorer must render an
inert failure with safe-close guidance and Desktop must not execute the action.
Request a new exact grant instead of retrying or reviving the expired one. Once
the fresh page is approved, Desktop retrieves the result, submits the mutation
with the command request id bound into the grant, and verifies either one
consumption or an authoritative pre-consumption denial.

#### WorkOS-backed deployments

The approval protocol is independent of the browser identity provider.
Explorer loads the advertised providers from `/v1/capabilities`: Team
Self-Hosted can offer local sessions and WorkOS/AuthKit together, while
Koed-managed cloud offers WorkOS/AuthKit only. When fresh authentication is
required, a WorkOS-capable Step-up page renders `Sign in with WorkOS`, follows
`/auth/workos/login`, and returns to the same exact activation after the
verified callback creates a fresh Koed browser session. The decision endpoint
then applies the same exact review, device binding, expiry, and one-use grant
checks used after local authentication.

Outside the isolated `developer` profile, Team creation, sensitive Team
administration, and invite acceptance retain the configured-provider verified
WorkOS identity requirement. The developer-only switch used in this run is
ignored by Team Self-Hosted and Koed-managed cloud. Provider selection and the
WorkOS identity guards are covered by focused tests; this local run did not
authenticate against a real WorkOS tenant.

### 5. Run the focused boundary suites

These commands exercise the shared command schema, all backend policy branches,
Team Backend grant routes, local-edge tier enforcement, Desktop reconciliation,
and browser terminal behavior:

```bash
pnpm --filter @koed/shared exec vitest run \
  src/collaboration-contract.test.ts
pnpm --filter @koed/api exec vitest run \
  src/high-risk/approval-policy.test.ts \
  src/high-risk/routes.test.ts \
  src/local-edge/collaboration-action-grant-control.test.ts
pnpm --filter @koed/desktop exec vitest run \
  src/collaboration/renderer-client.test.ts \
  src/CollaborationApp.test.tsx \
  src/renderer/services/desktop-commands.test.ts
pnpm --filter @koed/explorer exec vitest run \
  src/koed/HighRiskActionApproval.test.tsx
```

Current focused approval result: 201/201 tests passed: 38 shared, 67 API, 84
Desktop, and 12 Explorer tests. The added Explorer case proves a WorkOS-only
Step-up page offers no local credential fields. Separately, all 45 Desktop
manager tests and the focused non-default invitation Workspace repository test
pass.

The host Electron interaction gate also passes after repairing stale fixture
expectations for required Team Presence, the two-message Shared Session,
finite startup prewarming, delivery/activity navigation commands, and the
Native-review Action Grant status/decision contract.

### 6. Exercise and record each Desktop action

For each row below:

1. Begin from authoritative current Team, membership, Workspace, Share Grant,
   invitation, or Personal Device state.
2. Initiate the action from its normal Desktop control.
3. Record whether Desktop opened no second ceremony, an exact Native review, or
   a Step-up browser page.
4. For risk-sensitive rows, run every listed branch rather than treating one
   branch as proof of the whole row.
5. Confirm the mutation only occurs after the required decision, cancellation
   causes no mutation, and the result reconciles without a stale pending state.
6. Record redacted request status, selected tier, visible review consequence,
   mutation result, and any mismatch. Never record credentials or grant
   secrets.

## Current Behavior

|   # | User-facing action                             | Accepted tier / branches                                                             | Current policy behavior                                                                                                       | Validation evidence                                                                                                                                                                                                                                                                                                                                                                                                                         | Status    |
| --: | ---------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
|   1 | Create a Team                                  | Direct                                                                               | Backend returns `direct`; no review metadata or activation URL is valid.                                                      | Live + automated: Desktop created `Approval Validation 2026-08-03` with no second ceremony; the exact grant was consumed once.                                                                                                                                                                                                                                                                                                              | Confirmed |
|   2 | Join a Team                                    | Native review                                                                        | Exact Team, membership, and initial Workspace context are reviewed in Desktop.                                                | Automated boundary: exact invite lookup, review schema, Native decision, acceptance, replay, email, and selected-Workspace repository paths pass.                                                                                                                                                                                                                                                                                           | Confirmed |
|   3 | Create a Workspace                             | Direct                                                                               | Backend returns `direct` for the additive creation.                                                                           | Live + automated: Desktop created `Tier Validation` with no second ceremony; the exact grant was consumed once.                                                                                                                                                                                                                                                                                                                             | Confirmed |
|   4 | Create an invitation                           | Native review                                                                        | Desktop review identifies recipient, role, default Workspace access, and expiry.                                              | Live + automated: Desktop showed the exact recipient, role, selected non-default Workspace, `write` access, and 72-hour expiry; approval created the pending invite and consumed the grant once.                                                                                                                                                                                                                                            | Confirmed |
|   5 | Revoke an invitation                           | Native review                                                                        | Desktop review identifies the pending invitation and explains that existing members are unaffected.                           | Automated boundary: authoritative lookup, exact review, Native confirmation, execution, stale version, and terminal-state cases pass.                                                                                                                                                                                                                                                                                                       | Confirmed |
|   6 | Change a member role                           | Promotion: Step-up. Demotion: Native review.                                         | Backend derives promotion/demotion from the authoritative current role; unknown current role fails toward Step-up.            | Automated boundary: promotion, demotion, unchanged, missing-current-state, owner, and last-owner branches pass.                                                                                                                                                                                                                                                                                                                             | Confirmed |
|   7 | Disable a member                               | Step-up                                                                              | Independent browser approval is required; owner and last-owner checks remain authoritative.                                   | Automated boundary: Step-up-only selection, browser review, exact execution, and owner/last-owner rechecks pass.                                                                                                                                                                                                                                                                                                                            | Confirmed |
|   8 | Leave a Team                                   | Native review                                                                        | Desktop review states loss of Team and Workspace access; last-owner protection is rechecked at execution.                     | Automated boundary: exact Native review, cancellation, execution, and last-owner denial pass.                                                                                                                                                                                                                                                                                                                                               | Confirmed |
|   9 | Archive a Workspace                            | Native review                                                                        | Desktop review names the Workspace, retained-memory consequence, and reversibility.                                           | Automated boundary: exact Native review, version binding, execution, and retained-memory wording pass.                                                                                                                                                                                                                                                                                                                                      | Confirmed |
|  10 | Restore a Workspace                            | Direct                                                                               | Backend returns `direct`; restore executes from the explicit Desktop control.                                                 | Automated boundary: Direct status, explicit Desktop control, exact version binding, and execution pass.                                                                                                                                                                                                                                                                                                                                     | Confirmed |
|  11 | Change Workspace Access                        | `write` → `read`: Native review. Expansion or disable: Step-up.                      | Changes remain local draft state until deliberate apply; backend independently classifies every exact change.                 | Live + automated: `write` → `read` showed exact Native before/after review and consumed once. `read` → `write` for a synthetic member required fresh browser Step-up, executed from a valid manager context, advanced access from version 1/read to version 2/write, consumed exactly 1/1 use, and wrote one execution receipt. Expiry, pre-consumption authorization denial, removal, partial-apply, and stale-version branches also pass. | Confirmed |
|  12 | Prepare a source preview                       | Direct                                                                               | Read-like preparation returns `direct` and creates neither consent nor a Share Grant.                                         | Automated boundary: Direct selection, representation allowlist, preview revision/hash, and no-consent/no-grant effects pass.                                                                                                                                                                                                                                                                                                                | Confirmed |
|  13 | Record sharing consent                         | Bundled stage                                                                        | No standalone Desktop approval exists; exact consent is recorded inside the reviewed share or representation-change decision. | Automated boundary: no public standalone command exists; bundled consent and Share Grant records remain separately auditable.                                                                                                                                                                                                                                                                                                               | Confirmed |
|  14 | Share Memory with a Workspace                  | LCM Leaves/Rollups: Native review. Memory Events or unknown representation: Step-up. | One exact decision binds consent and Share Grant creation while keeping distinct audit records.                               | Automated boundary: both tier branches, preview binding, exact combined review, consent, grant creation, replay, and rollback cases pass.                                                                                                                                                                                                                                                                                                   | Confirmed |
|  15 | Revoke a Share Grant                           | Native review                                                                        | Desktop review explains loss of ordinary Team recall without deleting Personal Memory.                                        | Automated boundary: exact Native review, Personal Memory retention wording, version binding, and revocation pass.                                                                                                                                                                                                                                                                                                                           | Confirmed |
|  16 | Change the shared representation               | Detail reduction: Native review. Detail increase or unknown current state: Step-up.  | One review binds replacement consent and the exact representation mutation.                                                   | Automated boundary: reduction, increase, unchanged, unknown-current-state, replacement consent, exact execution, and rollback branches pass.                                                                                                                                                                                                                                                                                                | Confirmed |
|  17 | Move a Conversation to another Personal Device | Established target: Native review. New/unverified target: Step-up.                   | Review identifies current and target devices; exact source download is bundled into the transfer when required.               | Automated boundary: established, new, stale, and ambiguous target trust; exact source binding; one reviewed execution; and durable initiating-operation cases pass.                                                                                                                                                                                                                                                                         | Confirmed |
|  18 | Fork a Conversation on another Personal Device | Established target: Native review. New/unverified target: Step-up.                   | Review identifies both devices and independent lineage; exact source download is bundled when required.                       | Automated boundary: established, new, stale, and ambiguous target trust; independent lineage; source binding; and one reviewed execution pass.                                                                                                                                                                                                                                                                                              | Confirmed |

## Findings

The isolated Compose stack was rebuilt from the current worktree after
permanently deleting its device-proof, server-data, PostgreSQL, and Redis
volumes. The embedding-model cache was deliberately retained. All four
services reached healthy status, and a direct pre-bootstrap PostgreSQL query
returned zero Users, zero Teams, and zero memberships.

The live Native invitation tracer found and fixed a real repository defect:
invitation creation and acceptance locked the Team's oldest Workspace instead
of the exact selected default Workspace. Both paths now lock and validate that
exact active Workspace. The focused migrated-Postgres regression test and the
fresh-stack Desktop invitation both pass.

The live Desktop startup also exposed two nested timeouts while bundled local
services were healthy: the main-process aggregate status command allowed only
30 seconds, and the renderer abandoned that IPC after 15 seconds. The Desktop
manager now allows 120 seconds and runs its package/status probes in parallel;
the renderer allows 135 seconds. A fake-clock regression accepts a status that
finishes after 120 seconds, and the final rebuilt Desktop reaches the main UI
with the local Docker Team visible.

The expired Step-up attempt supplied a negative tracer: Explorer remained
inert, displayed safe-close guidance, and submitted no decision. A later
approved attempt was denied before consumption because the validating actor had
already reduced their own access to `read`; this demonstrates that browser
approval does not override current Team and Workspace authorization. The
corrected tracer used a synthetic member with `read` access in `General`, where
the owner retained `write`. Browser Step-up approved the exact `read` to `write`
change, the mutation advanced the row from version 1 to version 2, the grant was
consumed exactly once, and one execution receipt was persisted.

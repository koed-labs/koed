# Team SaaS Synthetic Memory Fixture

This fixture is the shared synthetic data set for Team SaaS backend data, API
authorization, dedicated Shared Memory grant/list/timeline/detail
representations, Agent, and later Electron validation.

It creates a deterministic near-real Koed Team with seven users, three
Workspaces, every collaboration thread kind, production-shaped encrypted
Shared Memory representations, private memories, revoked shares, disabled and
removed access, and Team-retained knowledge after personal deletion.

The goal is to let humans and Agents test against the same known world instead
of inventing one-off examples for each PR.

For release readiness, use this fixture with the launch validation checklist in
[Team SaaS Launch Validation](./team-saas-launch-validation.md).
The launch validation suite also includes encrypted fixture-boundary
regressions that mirror this truth sheet with encrypted shared, private,
revoked, removed-member, suspended-entitlement, queue, audit, and embedding
source cases.

## Commands

Run from the repository root.

```bash
pnpm team-fixture:seed
```

Loads the repository `.env`, runs DB migrations, resets only this fixture's
rows, seeds the fixture, and validates the core access expectations.

```bash
pnpm team-fixture:validate
```

Validates the already-seeded fixture against the expected access outcomes.

```bash
pnpm team-launch:validate
```

Runs the launch validation report against the already-seeded fixture.

```bash
pnpm team-fixture:reset
```

Removes only child rows and test sessions belonging to
`team-saas-fixture-v1`. The deterministic fixture User and Team shells remain
so reset cannot cascade-delete unrelated rows later owned by a fixture User or
associated with the fixture Team. Seed upserts those shells before rebuilding
the fixture. Reset does not truncate the database or use User/Team ownership as
a fixture marker.

All commands require `DATABASE_URL`. `pnpm team-fixture:seed` loads the root
`.env` before running migrations, so a normal local clone can use the same
environment file as the other operator scripts.

The fixture commands fail closed unless `NODE_ENV=test` or the process is a
local development process with the `developer` (or omitted) deployment
profile. They reject production, Private VPS, Team Self-Hosted, and
Koed-managed cloud profiles.

## Local API Test Credentials

When `API_TOKEN_PEPPER` is configured, seeding creates deterministic sessions
with fixed row IDs and expiry. The corresponding fixture session secrets are
reusable local-only test bearer credentials: anyone with a fixture secret and
the matching test pepper can authenticate as that synthetic User until reset
or expiry. The fixture device credentials use the same production
`API_TOKEN_PEPPER` hashing path and can exercise scoped device authorization
when the pepper is configured. Use both credential types only with an isolated
local fixture database.

Seeding does not create password-login credentials. It preserves an existing
valid Argon2 password hash on a fixture User so a locally configured browser
login continues to work across reseeds; otherwise password login fails with
invalid credentials.

For manual Desktop enrollment, provision a disposable fixture User password
through the same production Argon2id hashing path used by `/auth/register` and
`/auth/login`, then verify login before opening the enrollment URL. Do not add a
fixed fixture password to this document, the seed, committed configuration, or
test output.

An isolated developer fixture API used as a Team backend must start with
`KOED_DEVELOPER_TEAM_BACKEND_ENABLED=true` and advertise partial or available
Team capabilities. Its browser public URL and CORS origin must exactly match
the origin registered in Desktop. When starting `apps/api` directly, use the
API process variables `BROWSER_PUBLIC_URL`, `CORS_ORIGINS`, and
`COOKIE_SECURE`; `API_BROWSER_PUBLIC_URL`, `API_CORS_ORIGINS`, and
`API_COOKIE_SECURE` are supervisor inputs. Keep the fixture backend on a
dedicated initialized `KOED_HOME` so its verified deployment identity remains
bound to the fixture database.

For a disposable WSL fixture opened by a Windows browser, use the loopback
hostname that the browser actually receives as `BROWSER_PUBLIC_URL` and allow
both `http://localhost:<port>` and `http://127.0.0.1:<port>` in
`CORS_ORIGINS`. Verify login with an `Origin` header matching the browser URL;
a command-line login without `Origin` does not prove the browser-origin check.

The fixture API and Worker must use the same `DATABASE_URL`, queue backend,
application and Team encryption-provider lineage, and Privacy Filter Service.
When starting `apps/worker` directly, set `PRIVACY_SERVICE_URL` and
`PRIVACY_SERVICE_TOKEN`; `PRIVACY_SERVICE_HOST` and `PRIVACY_SERVICE_PORT`
alone do not enable privacy materialization in the Worker. A Share accepted by
the API can otherwise remain in `privacy_filtering` even though the standalone
Privacy Filter Service is healthy.

Do not publish or copy fixed fixture cookie values into documentation, issue
comments, shared chat, or committed config. The command profile guard rejects
shared deployment profiles; do not bypass it or seed the fixture into shared,
staging, or production environments with a normal shared `API_TOKEN_PEPPER`.

Seed, validate, reset, API, and Worker processes must resolve the same
application and Team encryption-provider lineage. In a supervised deployment,
use its generated runtime provider configuration for fixture commands. Do not
seed through bootstrap shell keys and then ask supervised processes using a
different generated key lineage to decrypt or embed those rows; the resulting
key-ID mismatch is an invalid fixture setup, not a recoverable row or product
fallback.

## Team

| Person | Fixture email           | Team state         | Purpose                                               |
| ------ | ----------------------- | ------------------ | ----------------------------------------------------- |
| Alice  | `alice.fixture@koed.ai` | Enabled owner      | Team owner, personal collaboration, and fixture actor |
| Bob    | `bob.fixture@koed.ai`   | Enabled member     | Active member with disabled access to one Workspace   |
| Carol  | `carol.fixture@koed.ai` | Enabled admin      | Admin and owner of retained Team knowledge            |
| David  | `david.fixture@koed.ai` | Enabled member     | Active member and owner of a revoked Share Grant      |
| Dana   | `dana.fixture@koed.ai`  | Disabled member    | Must not receive Team collaboration                   |
| Erin   | `erin.fixture@koed.ai`  | Enabled member     | Read-only Workspace member                            |
| Frank  | `frank.fixture@koed.ai` | Removed/non-member | User row remains, but no Team membership remains      |

## Workspaces

| Workspace                   | Project path                                | Access model                                                                                                                       |
| --------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Electron Team App           | `/fixture/koed/electron-team-app`           | Alice, Bob, and David can write. Bob and David may share owned Memory. Carol and Erin can read.                                    |
| Cloud Memory Platform       | `/fixture/koed/cloud-memory-platform`       | Alice, Carol, and David can write. Alice and Carol may share owned Memory. Bob has been removed and has disabled Workspace access. |
| Managed Knowledge Ingestion | `/fixture/koed/managed-knowledge-ingestion` | Alice, Carol, and David can write and may share owned Memory. Bob and Erin can read.                                               |

## Memory Truth Sheet

| Memory                          | Owner | Workspace                   | Representation     | State                           | Expected Team behavior                                                                                                                       |
| ------------------------------- | ----- | --------------------------- | ------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace Memory Timeline UX    | Bob   | Electron Team App           | Memory Events      | Active share                    | Visible to authorized Electron Workspace members.                                                                                            |
| Agent Collaboration Rooms       | David | Electron Team App           | LCM Leaves         | Active share                    | Visible to authorized Electron Workspace members.                                                                                            |
| Revoked Electron Experiment     | David | Electron Team App           | Memory Events      | Revoked share                   | Hidden from Team reads; remains David's personal memory.                                                                                     |
| Private DevOps Scratchpad       | Bob   | Electron Team App           | Memory Events      | Private                         | Hidden from Team reads.                                                                                                                      |
| Flat User-Owned Memory Model    | Alice | Cloud Memory Platform       | LCM Rollups        | Active share                    | Visible to authorized Cloud Workspace members.                                                                                               |
| Cloud API Superset Contract     | Carol | Cloud Memory Platform       | Memory Events      | Active share                    | Visible to authorized Cloud Workspace members.                                                                                               |
| Team Recall Provenance Contract | Carol | Cloud Memory Platform       | Curated Assertions | Active share                    | Visible to authorized Cloud Workspace members with exact-session direct-source expansion through its Memory Event, LCM leaf, and LCM rollup. |
| Retained Billing Grace Decision | Carol | Cloud Memory Platform       | LCM Leaves         | Personal deleted, Team retained | Visible to authorized Cloud Workspace members even though Carol's personal source is soft-deleted.                                           |
| Removed Member Deployment Note  | Bob   | Cloud Memory Platform       | LCM Rollups        | Active share                    | Visible to authorized Cloud Workspace members, but not to Bob after his Cloud Workspace access is disabled.                                  |
| Private Pricing Scratchpad      | Alice | Cloud Memory Platform       | Memory Events      | Private                         | Hidden from Team reads.                                                                                                                      |
| Provider Fallback Ingestion     | David | Managed Knowledge Ingestion | Memory Events      | Active share                    | Visible to authorized Ingestion Workspace members.                                                                                           |
| Checksum Dedupe Inventory       | Carol | Managed Knowledge Ingestion | LCM Leaves         | Active share                    | Visible to authorized Ingestion Workspace members.                                                                                           |
| Memory Inbox Product Boundary   | Alice | Managed Knowledge Ingestion | LCM Rollups        | Active share                    | Visible to authorized Ingestion Workspace members.                                                                                           |
| Private Agent Prompt Scratchpad | David | Managed Knowledge Ingestion | Memory Events      | Private                         | Hidden from Team reads.                                                                                                                      |

## Collaboration Truth Sheet

All five collaboration threads and their messages have deterministic physical
IDs derived from fixture idempotency keys. Thread names, topics, message bodies,
metadata, and full provenance values are stored through the production
encryption path. The collaboration tables retain only required markers,
authorization/routing IDs, an opaque provenance ID, and outbox routing fields.

| Thread             | Scope                  | Kind                        | Participants/access                                      | Expected history                                          |
| ------------------ | ---------------------- | --------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Release notes      | Personal               | `personal_channel`          | Alice only                                               | One private channel message                               |
| Product            | Electron Workspace     | `workspace_channel`         | Workspace readers can read; writers can post             | Two messages                                              |
| Alice/Bob          | Team                   | `dm`                        | Alice and Bob                                            | Two messages                                              |
| Launch review      | Team                   | `group_dm`                  | Alice, Bob, and Carol                                    | One message                                               |
| Timeline companion | Electron Shared Memory | `shared_session_discussion` | Authorized Workspace members with the active Share Grant | Two messages; Alice has read the first and has one unread |

Dana and Frank must receive no Team threads. Erin can read the Electron
Workspace channel but cannot write to it. Personal threads must never appear in
Team thread lists.

## Expected Checks

Use these as the first API/data-level assertions before adding UI checks.

| Actor | Workspace                   | Should see                                                                                                                                                  | Must not see                                                           |
| ----- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Carol | Electron Team App           | Workspace Memory Timeline UX; Agent Collaboration Rooms                                                                                                     | Revoked Electron Experiment; Private DevOps Scratchpad                 |
| Alice | Cloud Memory Platform       | Flat User-Owned Memory Model; Cloud API Superset Contract; Team Recall Provenance Contract; Retained Billing Grace Decision; Removed Member Deployment Note | Private Pricing Scratchpad                                             |
| Bob   | Cloud Memory Platform       | Nothing                                                                                                                                                     | All Cloud Workspace memories, because his Workspace access is disabled |
| Bob   | Managed Knowledge Ingestion | Provider Fallback Ingestion; Checksum Dedupe Inventory; Memory Inbox Product Boundary                                                                       | Private Agent Prompt Scratchpad                                        |

The active Shared Memory rows collectively exercise `memory_events`,
`lcm_leaves`, `lcm_rollups`, and `curated_assertions`. The positive Cloud
Curated representation has four complete direct-source links in one Captured
Session: its Conversation Item, Memory Event, LCM leaf, and LCM rollup. Its
encrypted expansion material lets practical semantic search prove fidelity for
all four representation layers without exposing canonical IDs. The launch
suite's focused repository regression additionally exercises mixed-session
denial, three distinct encryption providers, and immediate invalidation.
Validation lists authorized Workspace Share
Grants and decrypts each representation through the dedicated production
repository. Timeline metadata and detail content come from the representation,
not canonical owner-private `messages`, `memory_events`, or `memory_nodes`.
The revoked representation must not list or decrypt for an otherwise authorized
Team reader. Bob's explicit `can_share_owned_memory` permission supports the
protected Personal-to-Team preview, consent, and share flow without treating
ordinary Workspace write access as sharing authority.

## Conversation Source Access Truth Sheet

Conversation Source Access is an independent capability. Most active Shared
Memory grants deliberately have no source grant. The fixture adds only these
three deterministic, origin-signed, encrypted owner-source cases:

| Source                      | Shared Memory                | Mode                  | Expected behavior                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline continuous source  | Workspace Memory Timeline UX | `continuous`          | The owner retains exact encrypted source bytes. Authorized Electron Workspace readers receive a policy-bound sanitized derivative and may follow later sanitized generations. Its synthetic email and API-key canary must never appear in Team reads. |
| Agent rooms snapshot source | Agent Collaboration Rooms    | `snapshot`            | The owner retains both exact segments. Authorized readers receive only a sanitized derivative of segment 0; the later stored segment remains outside the grant. Segment 0 ends at a completed turn and supports sanitized fork export.                |
| Revoked experiment source   | Revoked Electron Experiment  | `continuous`, revoked | No Team reader can list or decrypt a sanitized source derivative. The owner's exact source remains Personal.                                                                                                                                          |

Fixture validation decrypts the exact owner-private JSONL bytes, checks the
snapshot and continuous bounds through the production repository, proves the
revoked grant is denied, and verifies deterministic grant/revocation audit
events. A running Privacy Filter Service and Worker materialize the sanitized
Team source derivative; Team route tests require typed placeholders and reject
the original synthetic canary. The automated launch gate also runs the source
routes for browser-session and device-credential authorization, Personal API
Token denial, sanitized fork export, SSE authorization loss, consent expiry,
cursor binding, and integrity failures.

The automated fixture gate also runs a synthetic semantic preview above 2,048
privacy fields. Validation confirms bounded transport requests, durable chunk
resume after Worker restart, no partial Team visibility, and one complete
publication after the final chunk is attached.

## Agent Testing Playbook

1. Run `pnpm team-fixture:seed`.
2. Read this document before writing tests or prompts.
3. Verify data/API behavior first: authorization, collaboration history, and
   Shared Memory grant/list/timeline/detail representation reads must match the
   truth sheet.
4. Run the normal Shared Memory embedding reconciliation, then verify Team
   semantic search, answer evidence, and candidate expansion against the same
   truth sheet. They operate only over grant-scoped representations and are not
   alternate views over canonical owner-private rows. The generic Team graph
   remains unavailable.
5. Treat any mismatch as either a fixture bug or product bug. Do not silently
   alter the fixture assumptions.
6. When the Electron app is ready, reuse this same fixture for UI-level checks.
7. If a failure blocks launch validation, create or link a Linear ticket before
   release.

## Design Notes

- The reset mechanism is fixture-scoped. It deletes deterministic fixture rows
  by IDs and source/idempotency markers instead of treating all rows owned by a
  fixture User or associated with the fixture Team as fixture data. The focused
  live test proves an out-of-marker Memory Event owned by Alice survives while
  an in-marker stale row is removed.
- Reseeding compares a normalized snapshot across every seeded table family,
  decrypted Shared Memory, collaboration state, encryption companions, and
  outbox rows. Only generated timestamps, outbox cursors, generated container
  IDs, and randomized envelope bytes are normalized.
- The data intentionally includes edge cases, not only happy paths.
- The fixture preserves production-shaped canonical Personal Memory rows for
  personal-boundary tests, but Team validation never treats those rows as a
  Shared Memory read model. A hostile canonical secret canary regression proves
  canonical payload, message, and summary changes cannot enter an already
  materialized Team representation.
- The fixture does not precompute embeddings. Team semantic search and answer
  evidence produce hits only after the normal Worker embedding reconciler has
  processed pending grant-scoped representation items. This is an intentional
  readiness precondition, not a lexical fallback. Seeding writes the same
  plaintext-free pending item/chunk routing metadata as production
  materialization; reset/snapshot validation rejects missing metadata or
  canonical source identifiers in those rows.
- Encrypted LCM Leaf and Rollup fixtures include nested source expansion
  material. Authorized tests can therefore prove rollup-to-leaf and
  leaf-to-event drill-down instead of stopping at summary retrieval.
- The Curated fixture uses the production protected-storage shape: encrypted
  Personal Curated topic, assertion, and source payloads; encrypted
  owner-private artifact and preview; and an encrypted Team representation.
  Its semantic routing row contains only grant-scoped pseudonymous lineage.
- Bob's Cloud Workspace removal tests that user-owned contributions can remain
  useful to the Team while the removed member loses access.
- Carol's retained billing memory tests that personal deletion does not destroy
  Team-retained knowledge for authorized Workspace members.
- Revoked and Personal Memory cases prove Shared Memory representation reads do
  not overreach.
- Shared source artifacts and previews use an owner-private fixture envelope;
  Team representation chunks and collaboration fields use a separate Team
  fixture envelope. Both use the production repository shape with synthetic,
  non-production local-test key material. Validation requires exact encrypted
  payload coverage for collaboration names/topics/bodies/metadata/provenance,
  Shared Memory artifacts/previews/chunks, and checks that collaboration
  outbox/storage surfaces contain no sensitive fixture plaintext. The
  deterministic web-session values are reusable local-only test bearers, not
  production secrets.

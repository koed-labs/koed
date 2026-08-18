# Approval Activity and asynchronous sharing validation

Status: Local implementation and automated validation are complete.
Target-environment release validation remains.

## Automated evidence

- Approval Activity trusted classification: 9 focused shared-contract tests.
- Codex transcript classification and replay: 7 adapter tests.
- The complete API suite passes 917 tests with two skipped cases. Focused route,
  realtime, high-risk binding, local-edge control, and command-registry checks
  are included in that result.
- The complete Desktop suite passes 452 tests with one skipped platform case.
  It includes the active `Personal > Memory > Shares` route rather than only
  the legacy collaboration route.
- The changed database boundary passes 78 real-Postgres tests in one disposable
  database run. The complete Shared Memory repository suite contributes 60 of
  those checks.
  The tests include durable browser-authorized Pending Share activation and
  lifecycle events for pause, resume, and retry. They also include replacement
  without an access gap and recovery after a repository restart. Other tests
  cover stalled work, parent revocation, and Approval Activity correction.
- Approval Activity remediation now has direct real-Postgres coverage for a
  stable dry-run inventory, bounded bytes, and derivative counts. The tests
  cover ambiguous rollback, LCM invalidation, and semantic-sync deletion. They
  also cover snapshot audit records, Team revocation events, and idempotent
  reruns.
- The required Postgres-backed collaboration suites pass against a separate
  disposable local database: 3 constraint, 19 repository, and 4 Team-creation
  tests. The encrypted tenant-boundary selection adds 34 passing repository
  tests.
- The complete repository test command passes, including 351 Shared, 385 Koed
  Server, 258 MCP Server, 178 Worker, and 147 evaluation tests. One fixture
  integration case and three platform/environment cases are intentionally
  skipped by their suites.
- Shared, DB, API, Desktop, and MCP Server type checks pass, including the test
  typecheck.
- Full ESLint, Prettier, Drizzle migration consistency, and `git diff --check`
  pass.
- Migration acceptance passes clean migration, populated upgrade, interrupted
  recovery, backup/restore, idempotent rerun, and old/new boundary scenarios.
- Pending Share acceptance and representation replacement both require a
  durable local source-work record before Desktop receives success. Replacement
  keeps Workspace access active and defers the atomic grant/representation
  switch to the restart-safe Team worker.
- Owner-share pages use one signed, authority-issued snapshot timestamp and
  immutable creation ordering. A separate owner-authorized detail operation
  refreshes the selected split-view pane. Owner-only Pending Share lifecycle
  events are reauthorized and materialized from durable state through the
  existing collaboration realtime stream. The global announcement pipeline
  reports completion and failure outside the Shares tab.
- The owner Shares route does not poll. It refreshes authoritative current and
  history records after an owner-only lifecycle event or an explicitly marked
  authoritative snapshot recovery.
- HTTP request diagnostics provide content-safe route duration, while Pending
  Share records expose a bounded current stage and timestamps. They also expose
  the attempt count and an enumerated, redacted failure code. Candidate and
  authoritative preview records expose item counts, byte counts, and
  timestamps. These fields give acceptance-to-activation time without Memory
  content, credentials, provider errors, or exact source bytes.
- Source Electron interaction validation passes owner-wide Shares navigation,
  stable focus, keyboard-reachable controls, polite live status, destructive
  confirmation, and reduced motion. The rebuilt packaged macOS application
  passes the same Shares checks. Its packaged recovery gate also proves one
  apply after crash/redelivery and redaction for API, broker, enrollment, and
  realtime failures.
- Packaged startup creates the BrowserWindow before probing or reading the
  operating-system secret provider. This prevents a macOS Keychain wait from
  leaving the User without a visible application window. PDS initialization
  still completes before the managed runtime resumes.
- The rebuilt macOS application passes package integrity validation.

## Deterministic performance evidence

Run this command from the repository root:

```bash
pnpm approval-activity:measure-sharing
```

The command uses the production Cross-Identity Sync schema and envelope
encryption. It does not print Memory content or encryption keys.

The synthetic fixture has the same reported shape. It contains 38 Memory
Events, one LCM leaf, and a 412 KiB Approval Activity display projection.

The run on 2026-08-12 produced these results:

| Measurement             | Before correction | After correction | Difference |
| ----------------------- | ----------------: | ---------------: | ---------: |
| Protocol records        |                39 |               38 |         -1 |
| Plaintext package bytes |         3,439,616 |           62,797 | -3,376,819 |
| Encrypted package bytes |         4,588,454 |           86,027 | -4,502,427 |
| Encryption time         |         15.444 ms |         0.501 ms | -14.943 ms |

The ordinary 37-event control had the same canonical digest and byte counts in
both runs. The measured encryption times were 0.435 ms and 0.427 ms. The
measurement command checks these byte and digest invariants on each run.

The isolated real-PostgreSQL workflow gate measured these stages:

| Stage                    |      Time |
| ------------------------ | --------: |
| Candidate preview        |  3.539 ms |
| Authoritative preview    | 16.354 ms |
| Pending Share acceptance |  5.775 ms |
| Pending Share activation | 97.183 ms |

The activation ran after Pending Share acceptance returned. Thus, the measured
foreground response did not wait for activation.

This synthetic result is reproducible local evidence. It is not a replacement
for a measurement of the original 3.84 MB package.

## Durable implementation invariants

- A materialized share must match the owner-reviewed candidate manifest. If
  the candidate exceeds its consent boundary or cannot be reproduced, sharing
  fails closed instead of truncating or substituting content.
- Curated candidates may use only evidence from the selected Captured Session.
  Cross-session leaf and rollup provenance is rejected, and source invalidation
  removes every derived representation.
- Pending Share workers remain idle when Team collaboration is disabled.
- Creating, replacing, pausing, resuming, retrying, and revoking a Pending
  Share requires current owner authority. Replacement preview authority is
  distinct from command authority, and neither may be replayed.
- Replacement keeps the existing Share Grant available until the new companion
  and representation are complete. Publication then switches the grant and
  representation atomically.
- Worker retries use state and version comparisons. A concurrent revocation
  wins over stale work and cannot finish with a contradictory lifecycle state.
- Approval Activity remains outside semantic Memory. Correction inventories
  and removes legacy derivatives, invalidates affected LCM and sync state, and
  is idempotent for records that were already excluded.
- Approval Activity classification uses the same canonical trusted-marker
  predicate for Memory Event and linked Conversation Item reads.
- Candidate construction, owner-share listing, and authority lookups use
  bounded batches. Candidate limits are enforced before decryption.
- A Share Grant stays unavailable to Workspace list and read operations until
  its required companion exists and the reviewed manifest has been verified.
- Observable Pending Share lifecycle changes publish distinct operation
  versions to the owner. Silent retries preserve the current control version.
- Owner-share pagination uses immutable creation ordering and binds cursors to
  their original pagination context.
- The Desktop Shares flow remains keyboard accessible, preserves detail focus
  during lifecycle updates, announces status politely, confirms destructive
  actions, and respects reduced-motion settings.

## Fixture and staged status

The deterministic Team fixture was selected using the repository
`koed-team-fixture-testing` workflow and run against the installed bundled-local
runtime. `pnpm team-fixture:seed` migrated, seeded, and validated 7 Users, 3
Workspaces, 13 memories, and 6 collaboration threads. No production, registered
Private VPS, or Docker environment was used.

`pnpm team-launch:validate --with-automated-tests` exercised its isolated
database and passed all automated gates. These gates include migration,
authorization, realtime, IPC, renderer, accessibility, Personal Device Sync,
encrypted tenant boundaries, API runtime boundaries, and hosted operations.
The Electron gate also passed. It proved Team switching, invitations, message
delivery, Shared Memory layouts, replay recovery, and stale-event access purge.

An earlier run measured one frame at 131.4 ms against the 100 ms limit. The
final complete run passed, so the failure did not recur. The staged capacity
gate must still measure frame time under target deployment load.

The following acceptance evidence therefore remains environment-dependent and
must be run before release:

1. Run staged two-User validation for Pending Share activation, all three
   semantic representations, revocation, and exact Conversation Source Access.
   Local real-Postgres tests prove repository and worker restart replay. They do
   not prove recovery from a two-host network interruption.
2. Capture before/after encrypted package-byte and record-count measurements
   on the original reported Captured Session. The only retained baseline is 38
   Memory Events, one LCM leaf, a 3.84 MB encrypted package, and approximately
   412 KB for the approval display projection before encryption. The source
   fixture is not present in this checkout, so an after measurement would not
   be comparable. Also run the staged capacity gate and record frame time under
   target deployment load.

These are explicitly unmet validation criteria, not inferred passes. The
implementation must not be considered release-ready until they pass or are
linked to release-blocking tickets.

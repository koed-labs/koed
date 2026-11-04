# Peer-online Sync Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Exercise authenticated checkpoint exchange and read-only materialization between two isolated databases without running Authority or Relay services.

**Architecture:** A test-only in-process harness uses locally issued test certificates, authenticated lifecycle fixtures, and existing package and database APIs. It does not prove independent installations, network security, production scheduling, or decentralized governance.

**Tech Stack:** TypeScript, Vitest, PostgreSQL, pnpm, existing PDS cryptographic and repository APIs.

**Spec:** `docs/superpowers/specs/2026-11-03-peer-online-sync-slice-design.md`

## Global Constraints

- No production listener, configuration, pairing, relay, deletion propagation, or PDS V1 behavior change.
- Two distinct disposable PostgreSQL databases; skipped database tests are not acceptance.
- Do not bypass package certificate verification or fabricate a normal Session as a replica.
- No success until durable receiver materialization; do not advance a production cursor.
- Keep proposed ADR and untracked prototype work intact.

## Review Focus

- A substituted lifecycle head or floor must fail authentication before use (Task 1).
- A matching deletion floor must prevent materialization (Task 3).
- A missing predecessor must remain pending until explicitly retried (Task 3).
- A duplicate valid package must not duplicate source items (Task 3).
- A replica must reject normal source-item and source-journal writes (Task 3).

## Files and boundaries

- Create `packages/db/tests/fixtures/personal-peer-lifecycle.ts`: signed test lifecycle and floor binding.
- Create `packages/db/tests/fixtures/personal-peer-sync.ts`: two-database fixture and in-process delivery.
- Create `packages/db/tests/personal-peer-online-sync.test.ts`: integration and adversarial coverage.
- Reuse `packages/db/tests/fixtures/personal-source-device.ts` where feasible; change only if required to provision a genuine signed head.
- Create `docs/peer-online-sync-development-slice.md`: exercised and substituted boundaries.

## Task 1: Authenticated lifecycle fixture

**Reference:** `packages/shared/src/personal-device-sync-adversarial-fixture.test.ts`, `packages/db/tests/fixtures/personal-source-device.ts`.

- [ ] Write tests requiring a signed group statement chain and a signed tombstone, with a floor derived from the validated tombstone. Reject altered signatures, wrong group or previous head, substituted head, missing control, and altered floor token.
- [ ] Run those tests and verify they fail before fixture implementation.
- [ ] Implement the test-only fixture using existing signing and validation primitives. Bind every advertised `(logicalMemoryId, deletionFloorToken)` to a validated tombstone and verify group, sequence, previous hash and head. Do not describe the existing synthetic random head as authenticated.
- [ ] Run the focused tests and confirm they pass.

## Task 2: Real checkpoint publication and in-process receiver

**Reference:** `packages/db/tests/personal-source-sync.test.ts:176-365`, `apps/worker/src/personal-device-sync-runtime.ts:1920-2059`.

- [ ] Write an integration test with two independently migrated databases: create an eligible captured Session with completion evidence; publish a checkpoint and materialize a read-only replica in the other database. Assert durable receiver state, not upload success.
- [ ] Run the test and verify it fails before the harness exists.
- [ ] Implement a test fixture that provisions both peers, group, policies, certificates, repository assignment and inbox state. Publish using existing checkpoint APIs. Validate the Task 1 lifecycle and floor binding before verification; verify/decrypt, retain and materialize through existing constituent APIs. Keep delivery in-process; do not pretend it exercises worker lifecycle orchestration.
- [ ] Run the test with two distinct database URLs and verify a pass with no skips.

## Task 3: Cumulative, bidirectional and adverse cases

**Reference:** `packages/db/tests/personal-device-checkpoint-receiver.test.ts`.

- [ ] Add failing tests for B→A independently, a cumulative second checkpoint, duplicate delivery, and pause/resume with explicit retry; assert replica contents and no duplicate ledger/items.
- [ ] Add failing tests for missing predecessor then catch-up; incompatible history; tampering; wrong recipient; authenticated nonempty unrelated and matching deletion floors; and normal source-item and source-journal writes against a replica. Assert no false durable success on failures.
- [ ] Run the tests and record expected failures; implement the minimum harness behavior to pass while retaining existing certificate, floor and materialization checks. A missing predecessor stays pending, and duplicate package delivery is idempotent.
- [ ] Run the complete focused integration suite with two distinct databases and verify all cases pass without skips.

## Task 4: Document and verify

- [ ] Document exact exercised APIs and substituted lifecycle, inbox, delivery and retry boundaries in `docs/peer-online-sync-development-slice.md`. Explicitly exclude actual network auth/replay, worker orchestration, capture hook, Projection, Recall, restart recovery, pairing, deletion convergence and production readiness.
- [ ] Run the focused integration suite, relevant existing DB and shared package tests, applicable typechecks, formatting and lint. Record exact commands, results, skips and environment limitations.
- [ ] Independently review the completed diff for test validity, false success, fixture security assumptions, and unintended production changes. Re-run checks after any fixes.

**Known investigation:** Existing worker lifecycle fetches and applies deletion floors separately; this test's explicit authenticated floor binding is a harness substitution, not proof the production worker does so. Investigate any production security implications separately; do not broaden this slice silently.

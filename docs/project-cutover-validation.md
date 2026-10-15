# Project cutover validation

Ticket 16 uses one coordinated Project behavior change. Migration 0062 runs the
historical assignment transition once. The release uses current protocol
profiles and does not add a feature flag or a legacy Memory body reader.

## Assignment and storage evidence

The native assignment migration test starts from schema 0061 with recorded and
explicitly reassigned Sessions. It covers old, additive-period, invalidated, and
future-dated rows. Every existing assignment becomes unresolved and advances its
version. Complete Session provenance, Memory Event rows, and repository
observations remain unchanged.

The same test covers continued capture, duplicate ingestion, re-import, stale
writes, explicit reassignment, and reset. Repeated migrations preserve later
User assignments and new Sessions. See
[`project-assignment-cutover-migration.test.ts`](../packages/db/tests/project-assignment-cutover-migration.test.ts)
and [`repository-assignment.test.ts`](../packages/db/tests/repository-assignment.test.ts).

## Sync evidence

Genuine pre-cutover Directed Sync fixtures cover queued uploads, partial uploads,
and applied uploads with a lost acknowledgement. Current source and target
Workers communicate through the authenticated target API. They reconcile the
old sequence, preserve encrypted chunks and raw Memory, and complete a V2
package at the next sequence. Both Sessions retain unresolved assignments. The
API accepts V2 chunk metadata and rejects V1 bodies. These rehearsals use a stub
embedding workflow and prove transport and storage. See
[`directed-sync-profile-cutover-rehearsal.test.ts`](../packages/db/tests/directed-sync-profile-cutover-rehearsal.test.ts).

Native PDS migration fixtures cover cumulative source and receiver upgrades and
closed source and receiver upgrades. They exercise the actual migration chain,
signed profile boundaries, retained ciphertext, stable Session identity, raw
mappings, local overrides, and reset to unresolved history. Shared contract tests
and Worker/API regressions cover the current publication and selection paths.
See [the PDS protocol](personal-device-sync-protocol.md),
[ADR 0058](adr/0058-signed-checkpoint-profile-baselines.md), and
[ADR 0059](adr/0059-authenticated-directed-sync-profile-transitions.md).

## Retrieval and inspection evidence

Native repository tests cover effective Project equality, device-local identity,
raw retrieval, graph queries, Curated Memory, expansion, reassignment, and
unauthorized writes. Memory-browser output uses the same scope IDs as its filter.
Unresolved history remains available through authorized owner inspection. Scoped
Session lookup rejects legacy display IDs and mismatched effective assignments.
See [`repository-recall.test.ts`](../packages/db/tests/repository-recall.test.ts)
and [`capture-routes.test.ts`](../apps/api/src/memory/capture-routes.test.ts).

The durable task repository suite covers encrypted persisted requests, worker
replacement, repeated collection, claim fencing, cancellation, expiry, failure,
and Team access loss. MCP and API regressions cover pinned repository context,
blocking and submit-and-collect delivery, reconnect, observation timeout, and
fresh authorization checks. They reuse the existing task runtime. They do not
add automatic completion delivery.

## Team fixture assessment

A read-only export of the maintained synthetic Team fixture was restored into a
disposable PostgreSQL database. Migration 0062 transitioned all 14 Sessions.
Hashes proved that 11 Share Grants, 14 Conversation Items, 14 Memory Events,
15 Memory Nodes, and 71 encryption companions remained unchanged. Session fields
outside the assignment transition also remained unchanged. Migration replay
preserved the resulting state.

The clone retained all 11 semantic routing rows and 10 stored 1024-dimension
vectors. The existing fixture validator passed its complete visibility and
decryption matrix. The base launch validator confirmed completed embeddings
for Memory Events, LCM leaves, LCM rollups, and Curated Memory. The maintained
fixture remained unchanged.

This assessment uses the [Team fixture truth sheet](team-saas-synthetic-fixture.md).
It does not claim that the separate staged SaaS billing, operations, capacity,
or multi-User launch gates ran. The base launch report marks its additional
repository launch gates as `not_run`. See
[Team launch validation](team-saas-launch-validation.md).

## Local checks

The current shared contract suite passed 578 tests. The selected PDS Worker/API
integration suites passed 42 tests. Durable recall, context, scheduler, and API
authorization regressions passed 153 tests. The native durable-task repository
suite passed 13 tests. Desktop Project contracts passed 26 tests. Core regressions
passed 47 tests. Answer-worker evidence selection passed 75 tests, including
canonical reference handling and selected parents with partial children. The
API evidence contract passed seven tests.

Watcher, discovery, and Capture Hook regressions passed 106 tests. Native managed
capture checks passed nine cases, and historical import checks passed three.
Watcher cases isolate their Koed homes. Native suites skip before database setup
when no test database is configured.

The full workspace TypeScript build, test typecheck, repository lint, and
formatting checks passed. The Desktop package build also passed. The built
Project workspace renderer validator passed with an isolated Electron profile.

## Release boundary

The Project cutover is locally validated on the integration branch. The User
approved one minor changeset for this change. The dependent Global work in tickets
17 and 18 remains a separate integration checkpoint. Push, pull request creation,
and merge to main remain separate release actions.

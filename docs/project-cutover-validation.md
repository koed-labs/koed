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

## Global integration evidence

Tickets 17 and 18 are integrated after the ticket 16 checkpoint. Native Personal
Global tests cover candidate recovery, stronger foreign evidence, overlap,
unknown and mixed provenance, time bounds, owner isolation, and captured PDS
branches. A missing PDS branch observation gives no branch bonus. A local move
to another repository cannot reuse the source branch.

The complete native Shared Memory repository suite passes all 87 cases. The
merged Global contract, worker, context, and API suites pass 109 tests. Native
durable task tests pass 15 cases, including encrypted known and explicit-null
Global context. Workspace compilation, test typechecking, lint, and formatting
also pass after integration.

## Project creation follow-up

The Projects header creates named local Projects without selecting or creating
folders. Empty Projects remain assignment destinations. Both Conversation and
Project headers expose **Move**. A whole-Project move includes all current
owner-visible Sessions and routes later captures to the same destination.
Automatic capture identity and the legacy unresolved cutoff remain intact.

Focused Desktop regressions cover named creation, cancellation, errors, empty
destinations, individual moves, whole-Project moves, and reset navigation. The
isolated Electron check creates an empty named Project and moves an existing
Project into it. Native tests cover more than 500 Sessions, owner isolation,
transaction rollback, future routing, route flattening, cycle rejection, and
continued legacy history. MCP tests cover rootless Project recall and pinned
routing context. These checks use disposable profiles and databases.

## Conversation folder recall follow-up

The supported integrations now pass the Conversation folder independently of
the MCP process's startup directory. Regressions cover native hook rewrites,
concurrent folders, both delivery modes, invalid paths, explicit Project
targets, Global scope, managed adapters, and remote transport authority. Setup
and repair tests cover both packaged and contributor hook installation.

Native checks used Codex CLI 0.162.1, Claude Code 2.1.267, and the Pi 1.1.0 SDK
with isolated profiles and a recording local recall service. Codex and Claude
passed their real native hook inputs through the stdio adapter. Claude used a
deterministic local model endpoint. Pi executed its installed extension through
the native SDK in both blocking and non-blocking modes. Each resolved a Git
subdirectory to the expected repository Project.

The Codex app-server check deliberately starts both its process and MCP adapter
outside the Conversation folder. Its untrusted hook is skipped, so the adapter
uses the request's single native workspace root. Ambiguous roots require an
explicit target or trusted hook. These checks verify transport and Project
resolution, not answer quality, and do not constitute a VS Code UI test.

### VS Code extension UI verification

The installed `openai.chatgpt` extension 26.51007.21434 was then driven through
its actual Codex sidebar in VS Code 1.140.0, using its bundled Codex
0.162.0-alpha.17.2. An unmodified local copy of the editor let UI automation
distinguish the test window from the User's existing window. Disposable profiles,
a deterministic local model endpoint, and a recording local recall service kept
the test independent of live credentials and Memory. No live credentials were
read or copied.

The first Conversation opened repository `alpha`. The same editor window then
switched to the `package` subdirectory inside repository `beta` and started a
new Conversation. Both calls supplied only the query and blocking delivery mode;
they omitted `project_id`, `conversation_cwd`, `repository_context`, and Search
Domain. The actual code-mode calls reached the stdio adapter, defaulted to
Project scope, and resolved distinct repository identities for `alpha` and
`beta`. Both returned markers were visibly displayed in the sidebar.

The MCP child deliberately started in a third folder, and native hooks were
omitted. The extension's per-request workspace metadata selected each correct
repository, including the Git root above `beta/package`, without retaining the
previous Conversation's Project. This verifies the UI transport and production
Project discovery path. Semantic retrieval and answer quality remain outside
this fixture check. No additional product code change was needed.

## Fresh historical import assignment follow-up

Fresh imports now prefer recorded Git metadata, then current Git discovery in
the recorded absolute folder, then a local folder Project.
Focused tests cover Codex, Claude Code, and Pi registration, missing folders,
reused Git checkouts, conflicting metadata, invalid paths, Windows paths, and
stable folder grouping within one profile. Claude auxiliary components use the
main transcript's recorded folder. Caller directories cannot replace missing
historical context.

The Git discovery follow-up covers upstream/origin precedence, subdirectory
resolution, local repositories without remotes, conflicting anchors, missing
folders, and foreign recorded paths. Recorded source-time Git remains authoritative
when today's checkout differs. Current branches remain unknown for historical
activity. Existing recorded folder assignments remain unchanged through replay.

A resolver check against existing Git checkouts with a disposable Koed profile
returned their expected portable repository identities. The check changed no
live assignments. The running Desktop process needs a restart to load the change;
existing imported folder groups still require an explicit move to merge.

Eighteen PostgreSQL assignment regressions cover fresh assignment, replay, manual
overrides, reset, and invalidated-session re-import. The separate migration 0062
acceptance test also passed. It preserves the one-time cutoff and prevents
continued capture from automatically resolving existing history. Tests used
disposable databases and isolated local profiles.

The larger catch-up controls remain a follow-up in `TODO.md`. Automatic selection
still uses the last 30 days and at most 50 Conversations per supported AI Client.
This change adds no migration or startup repair of existing assignments.

## Release boundary

The Project cutover and dependent Global work are locally integrated and
validated. The User approved one minor changeset for this change. Push, pull
request creation, and merge to main remain separate release actions. The main
branch must receive the complete Project cutover before the Global follow-on.

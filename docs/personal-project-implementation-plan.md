# Personal Project implementation plan

Package 1 replaces Project reassignment with independent Personal grouping and
recall. A Conversation retains its recorded Git and Folder context when a User
adds it to a named Project. Existing Team sharing remains operational.

The implementation baseline is `codex/repo-targeted-recall` at `8896cc14`.
This plan follows the agreed
[recall and continuous sharing model](recall-and-continuous-sharing-model.md).
P1-01 defines the compatible [Personal selection contract](personal-selection-contract.md).
The implementation has landed locally. P1-17 integrates the current callers
and retires legacy replacement writes. Projects are new on this branch; the
User removed the existing-Project upgrade requirement on 20 October 2026. See the
[validation record](personal-project-validation.md) for executed acceptance.
The User chose to omit the recommended minor changeset on 20 October 2026.
The ordered work items are tracked in
[TODO.md](../TODO.md#package-1-personal-project-remediation).

## Confirmed product decisions

The following decisions are confirmed in the discussion on 19 October 2026.
They define Package 1 behavior and its tests.
They also define the membership boundary that Package 2 consumes.

| Decision             | Required behavior                                                                    |
| -------------------- | ------------------------------------------------------------------------------------ |
| Folder matching      | Match only the selected Folder. Do not include subfolders.                           |
| Conversation context | Keep the original recorded context until the User explicitly corrects it.            |
| Multiple Projects    | Allow one Conversation to belong to multiple named Projects.                         |
| Project nesting      | Do not support Projects inside Projects in Package 1.                                |
| Direct inclusion     | Adding a Conversation includes that Conversation only.                               |
| Rule inclusion       | Adding a Git Anchor or Folder includes existing and future matching Conversations.   |
| Recall               | Offer independent named Project, Git Anchor, and Folder targets.                     |
| Source identity      | Project membership changes no source context, ownership, or logical Memory identity. |

Folder matching uses the recorded working directory, not the enclosing Git root.
A Conversation captured in `/work/koed/api` does not match Folder `/work/koed`.
Both can match the Koed Git Anchor. Later working-directory observations do not
add more matching Folders to the same Conversation.

## Engineering defaults

These choices make the package concrete without changing the confirmed model.
They are implementation defaults, not additional decisions attributed to the User.
Record any necessary change to these defaults before implementing it.

| Area                  | Default                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Removal               | Remove direct inclusion. If a rule also includes the Conversation, offer an explicit exclusion from that Project.      |
| Exclusion             | A Project exclusion wins over all inclusions in that Project. It affects no other Project or source filter.            |
| Add back              | Explicitly remove the exclusion using the current membership version.                                                  |
| Capture Policy        | Named membership adds no new capture-policy behavior. Preserve existing Capture Targets during migration.              |
| Folder identity       | Bind a Folder to its originating device/profile and normalized directory context. A path alone is insufficient.        |
| Folder lifecycle      | Preserve recorded identity. A replacement directory or a new device cannot inherit it from an equal path.              |
| Context correction    | Version Git and Folder corrections independently. Preserve original provenance and audit the correction.               |
| Project ownership     | Store named Projects under the owning User. Equal names never merge identities.                                        |
| Membership evaluation | Derive membership from inclusion rules and exclusions. Do not rewrite each matching Session on every rule change.      |
| Migration             | Add a forward migration. Preserve uncertain source context as unresolved rather than infer it from today's filesystem. |

Use the existing platform-aware directory normalization at registration.
Retain the captured path for display and provenance.
Do not lowercase paths across platforms or use string-prefix matching.
Exact directory equality must remain independent of Git-root discovery.

## Scope boundary

Package 1 owns Personal schema, source context, membership, recall, Desktop
organization, Personal Device Sync, and assignment migration.
It also owns compatibility work needed to keep existing Team flows operational.
It does not create continuous sharing rules, change sharing modes, or add Team
grouping authority. Those changes belong to Package 2.

Preserve selected-anchor discovery from
[ADR 0057](adr/0057-selected-repository-identity.md).
Retain source eligibility, time bounds, deletion rules, retrieval budgets,
and the AI Client synthesis boundary. A new grouping does not require new
embeddings or a new synthesis service.

## Source and membership contracts

Keep three facts separate: recorded source context, explicit source corrections,
and named Project membership. Capture writes the original Git and Folder
context once for the logical Conversation. Continued capture records later
observations without replacing that context.

Reuse the existing repository assignment for Git corrections where possible.
Remove `local_project` from new source-context writes.
Accept that legacy kind only in migration and explicit compatibility decoding.
An explicit unresolved correction must continue to suppress automatic matching.

The proposed storage responsibilities are:

| Record                   | Responsibility                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Named Project            | Owner, stable identity, name, version, and retained deletion state                    |
| Project inclusion        | Project, selector kind, source identity, version, and removal history                 |
| Project exclusion        | Project and logical Conversation identity with a version                              |
| Session Folder context   | Original Folder identity and provenance, separate correction, and version             |
| Selection change journal | Durable owner-scoped changes needed for synchronization and downstream reconciliation |
| Legacy identity mapping  | Exact old-to-new identifiers and migration evidence                                   |

The table names are implementation choices. Keep membership operations in a
focused repository module. Use one selection predicate across retrieval and
Desktop inventory. Avoid adding separate conditional membership implementations
to each caller of the large database repository.

For an eligible Conversation, Project membership is the union of direct,
Git Anchor, and exact Folder inclusions, minus Project exclusions.
Every join also checks ownership and current source eligibility.
Return each logical source once and retain all inclusion reasons.

Use the existing verified logical source binding for references that cross
Personal devices. A database Session UUID is only a local reference.
A source that is not yet available on a receiving device remains pending there.
Missing source data cannot become a fabricated Conversation.

The database becomes authoritative for the named Project catalog and membership.
Import existing named entries from `projects.json` once, including empty Projects.
Keep checkout discovery and device navigation in the local catalog.
Retain exact legacy aliases for migration, without maintaining two mutable
authorities for the same named Project.

## Recall request contract

Introduce a typed Personal recall target that is distinct from caller context.
The proposed field is `recall_target`. Its supported kinds are `project`,
`repository`, `folder`, `session`, and `global`.
Project, Folder, and Session targets use owner-checked opaque identifiers.
Repository targets use a validated selected identity.

Keep `repository_context` as caller provenance for Global repository preference.
It must not substitute for an explicit target.
With no explicit target, resolve trusted caller context to its repository or
exact Folder. Never select an umbrella Project merely because it contains that context.

Normalize legacy `search_domain`, `project_id`, and `session_id` only at the
adapter boundary. Decode known legacy target types and exact aliases.
Reject unknown or ambiguous targets. Reject requests that mix conflicting new
and legacy selectors. Do not apply the old source-to-named-Project recall redirect.

Store one canonical target in new durable requests.
Workers and database queries consume that target, not independently interpreted
legacy fields. Version the request and capability contracts where required.
Keep Team requests on their existing authorized path until Package 2.
Reject unsupported Team Folder or named-group targets without widening the search.

Pin target identity before task acceptance. Membership remains live, as current
Personal assignment filtering does today. Each query and expansion checks current
membership, exclusions, ownership, and source eligibility.
Retrying a task must not infer a new target from the worker's directory.

For a live Project, removal of a member takes effect on subsequent retrieval.
Removed source content cannot survive through expansion of an older summary.
Global recall remains Global, with an independent bounded repository preference.
Adding Project membership cannot change the source's repository classification.

## Schema and compatibility

Project integration is new on this branch. Create named Projects directly in the
owner-scoped catalog; no existing-Project conversion, profile ownership review,
repair inventory, or interactive activation is required. The former P1-14 and
upgrade-specific parts of P1-15 are superseded by the User's decision on
20 October 2026.

Committed migration history through `0046_project_scoped_recall` remains unchanged.
The unreleased branch migrations formerly numbered 0047–0069 are consolidated in
`0047_personal_project_model`, with their ordered statements, backfills, and guards
preserved. Existing pre-branch databases upgrade through this single migration.
Databases that applied the temporary branch history require a separate reset or
reconciliation; this cleanup does not modify them or relax checksum verification.
Historical upgrade tables are unused; there is no application workflow for
populating them. Normal startup installs the current schema before serving Project
requests.

Source facts, logical Memory identity, signed sync packages, and existing Team
grants retain their independent boundaries. Project membership never changes
Capture Policy or removes a Capture Pause. Current source correction and capture
controls do not depend on a Project upgrade.

## Personal Device Sync

Membership configuration must synchronize independently of Conversation capture.
Use an encrypted, authenticated journal with stable Project and inclusion
identities, causal revisions, and retained removals.
Do not overload the existing anchor-selection protocol with unrelated membership records.

Reuse the existing transport, key rotation, replay protection, and device checks.
Define explicit merge behavior for independent operations and conflicts on the
same inclusion. Arrival order and device clocks cannot choose the winner.
A conflicting inclusion must not widen membership until it is resolved.

Sync Folder provenance with its originating context inside encrypted payloads.
Replicas can match that source context. An equal path on the receiving device
does not establish a local Folder match or checkout association.
Keep local filesystem acceptance separate from receiving membership records.

Source assignment transport must carry Git and Folder facts independently of
named membership. Preserve explicit local corrections when later source packages
arrive. Keep the existing historical-unresolved boundary and signed provenance.
New membership records do not change any Team grant snapshot.

## Implementation sequence

Each work item must leave the branch buildable and keep its tests passing.
Add compatible schema and contracts before switching runtime behavior.
Activate the complete Personal model only after migration and compatibility tests pass.

| Order | Work item                                                                    | Dependencies              | Completion evidence                                                                             |
| ----- | ---------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| P1.1  | Define shared source, Folder, membership, and recall-target contracts        | Confirmed decisions above | Contract fixtures cover exact Folder matching, legacy decoding, and unknown states              |
| P1.2  | Add schema, owner-scoped membership repository, versions, and change journal | P1.1                      | Real PostgreSQL tests cover inclusion, exclusion, overlap, stale writes, and owner isolation    |
| P1.3  | Separate capture-time Folder and Git context and source corrections          | P1.1, P1.2                | All supported producers preserve original context across later turns, import, retry, and resume |
| P1.4  | Replace Personal retrieval predicates and durable request handling           | P1.2, P1.3                | All evidence stages honor each target before candidate limits and through expansion             |
| P1.5  | Add Personal membership sync and source-context compatibility                | P1.1, P1.2, P1.3          | Two-device tests cover offline changes, replay, conflicts, removals, and older peers            |
| P1.6  | Replace Personal Desktop organization and filter controls                    | P1.2, P1.4                | UI and native-flow tests use the same membership inventory as recall                            |
| P1.7  | Integrate current callers and retire legacy writes                           | P1.3 through P1.6         | Projects work directly while source context, capture policy, and Team authority remain separate |
| P1.8  | Run integrated acceptance and document the Package 2 contract                | P1.7                      | Required tests execute without skips and the end-to-end Personal example passes                 |

Schema design starts during P1.1 and P1.2. P1.7 integrates the supported
readers and writers. No existing-Project upgrade is required.

## Code ownership map

These paths identify the existing integration points.
New focused modules can own membership and target evaluation.
The implementation must update all consumers of the existing assignment predicate.

| Responsibility            | Existing entry points                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts          | [`repository-identity.ts`](../packages/shared/src/repository-identity.ts), [`repository-assignment.ts`](../packages/shared/src/repository-assignment.ts), [`personal-desktop-contract.ts`](../packages/shared/src/personal-desktop-contract.ts)                                                                                                                                        |
| Catalog and discovery     | [`project-metadata.ts`](../packages/koed-server/src/project-metadata.ts)                                                                                                                                                                                                                                                                                                               |
| Capture and correction    | [`captured-session-repository.ts`](../packages/db/src/captured-session-repository.ts), [`repository-assignment.ts`](../packages/db/src/repository-assignment.ts), [`settings-repository.ts`](../packages/db/src/settings-repository.ts)                                                                                                                                                |
| Membership transition     | [`project-routing-repository.ts`](../packages/db/src/project-routing-repository.ts), [`schema.ts`](../packages/db/src/schema.ts), [`graph-routes.ts`](../apps/api/src/memory/graph-routes.ts)                                                                                                                                                                                          |
| Recall adapters and tasks | [`memory-tool-schemas.ts`](../packages/mcp-server/src/memory-tool-schemas.ts), [`repository-recall-context.ts`](../packages/mcp-server/src/repository-recall-context.ts), [`memory-answer-task-coordinator.ts`](../packages/mcp-server/src/memory-answer-task-coordinator.ts)                                                                                                          |
| Retrieval and expansion   | [`project-scope-sql.ts`](../packages/db/src/project-scope-sql.ts), [`repository.ts`](../packages/db/src/repository.ts), [`memory-node-repository.ts`](../packages/db/src/memory-node-repository.ts), [`curated-memory-recall.ts`](../packages/db/src/curated-memory-recall.ts), [`curated-memory-records.ts`](../packages/db/src/curated-memory-records.ts)                            |
| Global preference         | [`global-repository-context-sql.ts`](../packages/db/src/global-repository-context-sql.ts), [`repository-recall.ts`](../packages/shared/src/repository-recall.ts)                                                                                                                                                                                                                       |
| Personal sync             | [`personal-repository-assignment.ts`](../packages/shared/src/personal-repository-assignment.ts), [`pds-repository-assignment.ts`](../packages/db/src/pds-repository-assignment.ts), [`personal-project-selection-repository.ts`](../packages/db/src/personal-project-selection-repository.ts), [`personal-device-sync-service.ts`](../apps/worker/src/personal-device-sync-service.ts) |
| Desktop                   | [`ProjectActions.tsx`](../apps/desktop/src/renderer/views/personal/ProjectActions.tsx), [`MoveConversationDialog.tsx`](../apps/desktop/src/renderer/views/personal/MoveConversationDialog.tsx), [`project-memory-ui.ts`](../apps/desktop/src/project-memory-ui.ts)                                                                                                                     |

## Validation and completion

Create synthetic sources from two Users and two devices.
Include two clones of one repository, a separate repository, a subfolder,
a same-named folder on another device, and unresolved history.
Exercise both known source context and explicit corrections.

| Boundary               | Required result                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Exact Folder           | Parent, child, and sibling directories do not match each other. Git-root resolution cannot broaden Folder selection.                 |
| Stable context         | Later turns in another directory do not change original matching. A correction changes matching without erasing provenance.          |
| Membership             | One Conversation can belong to two Projects. Nested Project input is rejected. Direct inclusion admits no unrelated sources.         |
| Automatic inclusion    | Existing and future matching sources appear without rewriting their source assignments.                                              |
| Exclusions and overlap | Exclusion affects one Project. Multiple inclusion reasons return one source. Removing one reason preserves another.                  |
| Retrieval              | Raw events, LCM, Curated Memory, graph views, and expansion use the same predicate. Mixed summaries expose no out-of-scope content.  |
| Tasks                  | Blocking and non-blocking calls use the same pinned target. Retry and collection do not rediscover the worker's directory.           |
| Personal sync          | Membership and removals survive offline delivery, replay, and device restart. Equal foreign paths establish no identity.             |
| Migration              | Unknown context remains unknown. Explicit corrections and Capture Pauses survive. Old clients cannot recreate replacement semantics. |
| Team compatibility     | Personal edits do not change existing grants, consent, representations, source access, or repository snapshots.                      |

Extend existing suites rather than replace their negative authorization cases.
Useful starting points include
[`repository-recall.test.ts`](../packages/db/tests/repository-recall.test.ts),
[`repository-recall-context.test.ts`](../packages/mcp-server/tests/repository-recall-context.test.ts),
[`project-assignment-cutover-migration.test.ts`](../packages/db/tests/project-assignment-cutover-migration.test.ts),
and
[`PersonalMemoryViews.test.tsx`](../apps/desktop/src/renderer/views/personal/PersonalMemoryViews.test.tsx).

Run database tests against a disposable fixture database.
The existing recall suite skips without `DATABASE_URL`.
The old cutover suite uses `PROJECT_CUTOVER_TEST_DATABASE_URL` and requires an
empty database. Give the new migration suite an equally explicit fixture boundary.
A skipped database or sync test does not establish acceptance.

Run formatting, lint, and affected package typechecks and builds before integration.
Cover shared, database, core, API, MCP, local server, worker, and Desktop packages
when their contracts change. Run focused unit and integration suites per work item,
then the full Personal flow and existing Team snapshot-preservation regression.
Record exact executed commands and results with the completed implementation.

The package is complete when the confirmed product decisions pass these tests,
all required producers and readers use the new model, and migration is repeatable.
The existing Team compatibility evidence must pass on the resulting branch.
Documentation must distinguish implemented behavior from Package 2 work.

## Package 2 handoff and release

Provide owner-authorized enumeration of a Project, Git Anchor, Folder, or
Conversation with stable logical source identities, inclusion reasons, and versions.
Provide a change cursor and bounded pagination that detect stale enumeration.
Package 2 must reconcile current membership after changes or missed notifications.
None of these contracts authorizes Team publication.

Document source changes, membership changes, exclusions, and removals separately.
The consumer must receive enough information to reconcile without copying private
content into a notification. Keep all raw paths and Personal metadata inside
their authorized Personal boundary.

This implementation warrants a minor release because it changes organization,
recall behavior, contracts, and Personal sync. The User chose to omit the
recommended changeset on 20 October 2026, satisfying the changeset decision
requirement in `AGENTS.md`. No release notes or package versions were changed.
The plan itself does not establish release readiness. The
[validation record](personal-project-validation.md) records the local checks;
release, push, and merge remain separate authorized actions.

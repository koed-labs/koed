# Personal Project validation

> Current history: the 27 October cleanup consolidated the final branch into
> migrations 0047–0049 and removed unused upgrade staging. Earlier numbered
> migration results below are historical evidence. See
> [Database Development](database-development.md#unreleased-project-migration-consolidation)
> for the current 50-entry journal and preservation/reconciliation procedure.

## Branch cleanup validation — 27 October 2026

The branch history now has three migrations, 0047–0049, instead of 31.
Main migrations 0000–0046 remain byte-for-byte unchanged. The three Project SQL
bodies are unchanged by the main merge; only their filenames and snapshot chain
move after main’s external-agent migration. The final schema omits six
unused upgrade staging tables and the retired Project routing table; active
Capture Target records and source-assignment evidence remain.

Validation covered:

- All six migration acceptance scenarios, including concurrent startup,
  transaction rollback and backup/restore with complete schema comparison.
- Nine reconciliation cases covering the original and consolidated alpha heads, exact-history preservation, unknown
  history, retained staging evidence, unmatched routes, changed functions,
  external dependencies, rollback after schema verification failure and missing
  backup. The three merged-migration tests also passed.
- A populated main-schema upgrade using the synthetic Team fixture. All foreign
  keys validated; protected source data remained identical, and existing grants
  produced the expected consent-bound sharing reasons and publications.
- A backup/restore rehearsal of an existing branch database. Every row in every
  surviving table remained identical after reconciliation, and the resulting
  schema matched a fresh database.
- All 173 Shared Memory scenarios across an isolated full run and focused
  rechecks. The full run passed 172 cases; the remaining case passed after its
  encryption assertion was restricted to representation content. The focused
  recheck also covered Privacy failure isolation. Each case now uses a fresh
  database cloned from a migrated template while retaining real concurrent
  connections.
- Personal membership/default/cutover suites, default Project API checks, the
  maintained Team authorization fixture, encrypted configuration transport,
  Directed Sync cutovers, Desktop navigation tests and six browser journeys.
  Production artifacts excluded validation fixtures.

Repository lint, formatting, workspace and test typechecks, migration metadata
and ADR numbering checks also passed. See
[Database Development](database-development.md) for the local reconciliation
command and Shared Memory test prerequisites.

## Package 1 verification fixes

On 20 October 2026, review of local commit `6d7ce920` identified two gaps:
public MCP selection of Personal Projects and exact Folders, and missing LCM
Summary change notifications. Both fixes now have regression coverage.

The public adapter accepts an explicit Project or Folder `recall_target` without
requiring a caller directory. Local, direct, and remote Personal submission bind
the target to the authenticated User. New tasks persist the versioned selection
before execution. Conflicting legacy selectors, cross-owner targets, and Team
routing fields are rejected. Searches and expansion retain the accepted scope.
Existing Git, Session, and Global request forms retain their current defaults.

Forward migration `0048_personal_summary_changes` observes LCM node creation,
updates, invalidation, and deletion. A completed summary now produces a source
notification even when a manual Conversation title prevents a Session update.
The regression also checks owner isolation and content-free event payloads.
The migration applies to the already-installed Package 1 baseline; migration
`0047_personal_project_model` was not rewritten.

The final focused acceptance runs passed 500 tests across 40 files:

| Boundary                                                                            | Files | Tests |
| ----------------------------------------------------------------------------------- | ----: | ----: |
| Public MCP, transport, durable tasks, remote submission, execution, capture         |    10 |   179 |
| Personal membership, Folder rules, recall, consumer, tasks, migration compatibility |    12 |    59 |
| Encrypted two-device source, membership, and rule delivery                          |     3 |     3 |
| Existing Team Shared Memory repository                                              |     1 |    87 |
| Desktop selection, membership, correction, and transfer controls                    |    12 |   130 |
| Shared recall contracts                                                             |     1 |    28 |
| Prompt loading                                                                      |     1 |    14 |

These checks used disposable PostgreSQL 17 databases. The consumer regression
also passed when applying 0048 to the previously tested 0047 database. Team
acceptance passed all 87 cases in a fresh database with other checks idle.
An earlier concurrent run hit per-test timeouts and a later contaminated
assertion; that run does not establish acceptance. Production and test
typechecks, Drizzle metadata validation, full formatting, and whitespace checks
passed. The final full `pnpm lint` rerun also passed after adding an explicit
query-result type to the new regression test. The existing native Electron
acceptance was not repeated because these
fixes change the MCP boundary and database journal, not Desktop interactions.

The exact commands for the final runs were:

```sh
pnpm typecheck
pnpm typecheck:test
pnpm --filter @koed/mcp-server typecheck
pnpm --filter @koed/db migrate:check
pnpm lint
pnpm fmt:prettier:check
git diff --check

pnpm --filter @koed/mcp-server exec vitest run tests/personal-recall-request.test.ts tests/memory-tool-executor.test.ts tests/memory-answer-task-coordinator.test.ts tests/memory-answer-task-runtime.test.ts tests/remote-backend-runtime-client.test.ts tests/mcp-memory-answer-tasks.test.ts tests/mcp-v2-protocol.test.ts tests/codex-memory-dispatch.test.ts tests/memory-answer-task-scheduler.test.ts tests/capture-folder-context.test.ts --no-file-parallelism
pnpm --filter @koed/mcp-server exec vitest run tests/prompt-loader.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/personal-membership.test.ts tests/personal-folder.test.ts tests/personal-folder-rule.test.ts tests/personal-project-rule.test.ts tests/personal-project-exclusion.test.ts tests/personal-project-selection.test.ts tests/personal-source-correction.test.ts tests/personal-selection-consumer.test.ts tests/repository-recall.test.ts tests/memory-answer-task-repository.test.ts tests/memory-answer-task-request.test.ts tests/merged-migrations.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/personal-rule-delivery.test.ts tests/personal-membership-delivery.test.ts tests/personal-source-closed-sync.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/shared-memory-repository.test.ts --no-file-parallelism
pnpm --filter @koed/desktop exec vitest run src/project-folder-filters.test.ts src/project-conversation-folders.test.ts src/project-memory-ui.test.ts src/project-row-presentation.test.ts src/koed-server/project-selection-command.test.ts src/ipc/managed-project-preload.test.ts src/renderer/views/personal/PersonalMemoryViews.test.tsx src/renderer/views/personal/PersonalAskNotes.test.tsx src/renderer/views/personal/ProjectMembershipActions.test.tsx src/renderer/views/personal/ProjectSyncDetails.test.tsx src/renderer/views/personal/SourceContextCorrectionDialog.test.tsx src/renderer/views/personal/ProjectTransferCard.test.tsx --no-file-parallelism
pnpm --filter @koed/shared exec vitest run src/repository-recall.test.ts --no-file-parallelism
```

Database commands used their existing fixture environment variables, each set
to isolated disposable databases. No production or existing application database
was used. This closes the two verification findings and supplies the Package 2
selection handoff without granting Team publication authority.

## Original implementation acceptance

Local acceptance was executed on 20 October 2026 against disposable PostgreSQL
17 databases. Package 1 implements independent Personal Project membership,
recorded Git and exact Folder recall, reviewed source corrections, Personal
sync, and direct Project use. The existing-Project upgrade was removed at the
User's request on 20 October 2026 because Projects are new on this branch. A minor
release was recommended; the User chose to omit the changeset on 20 October 2026. No release notes or package versions were changed. Local completion does
not authorize a push, merge, deployment, or release.

## Migration consolidation

On 20 October 2026, the 23 unreleased migrations formerly numbered 0047–0069
were consolidated into `0047_personal_project_model.sql` and one final Drizzle
snapshot. The 208 executable statements retain their original order, including
custom functions, guards, and backfills. SQL, snapshots, and journal entries
through committed migration 0046 remain unchanged. The consolidated snapshot
retains the former final schema and links directly to snapshot 0046.

Existing pre-branch databases upgrade normally. Databases that applied the
temporary branch chain are not silently accepted or rewritten; they require a
separate reset or reconciliation. No existing database was modified or reset.

Validation used an isolated PostgreSQL 17 cluster with disposable databases:

- All 15 migration acceptance scenarios passed, including interrupted transaction
  recovery, idempotency, historical data boundaries, and backup/restore.
- Three focused consolidated-migration cases passed: earlier main, pre-branch
  0046, and rejection of discarded unreleased history. Failed upgrades roll back
  schema and ledger changes; reruns preserve existing migration records.
- Original and consolidated chains produced the same schema fingerprint on both
  fresh installs and populated pre-branch upgrades. Comparison includes columns,
  constraints, indexes, triggers, enums, functions, and sequences. Existing
  synthetic owner and Conversation fields remained unchanged.
- The old 70-entry branch ledger is rejected by the consolidated build without
  writing to that database. Fresh/consolidated databases have 48 ledger entries.
- Drizzle metadata validation, the database package build, targeted lint,
  formatting, and whitespace checks passed. The application regression suites
  were not repeated for this migration-only cleanup.

Migration numbers in the earlier acceptance evidence below refer to the original
branch sequence. The consolidated baseline ends at
`0047_personal_project_model`; the forward summary-notification fix follows in
`0048_personal_summary_changes`.

## Upgrade workflow removal

The existing-Project dialog, profile ownership confirmation, catalog conversion,
repair inventory, activation endpoint, and preserved-target repair controls have
been removed. Projects are created directly. The former 0064–0069 schema objects
remain in the consolidated branch migration as historical schema; they do not
require a User upgrade step. See Migration consolidation below for the current
migration baseline.

The acceptance evidence below records the earlier full integration run. Its
upgrade-specific cases and commands are historical and no longer apply to the
current application. Checks for the removal are recorded separately below.

## Checks after upgrade workflow removal

On 20 October 2026, production and test typechecks passed (`pnpm typecheck`
and `pnpm typecheck:test`). Targeted ESLint, Prettier, and `git diff --check`
passed for the changed files. No SQL migration was changed and no database
fixture was restarted.

The following focused command passed all 110 cases across three files:

```sh
pnpm --filter @koed/desktop exec vitest run src/ipc/personal-memory-preload.test.ts src/renderer/views/personal/PersonalMemoryViews.test.tsx src/renderer/views/preferences/PreferencesView.test.tsx --no-file-parallelism
```

The full integration suite and native Electron harnesses were not repeated for
this removal. Their earlier results below describe the prior integration run.

## Acceptance evidence

| Requirement                               | Executed evidence                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepared activation and writer retirement | Two staged activation cases through migration 0069; three Capture Target rehearsal cases; real API retirement checks; native and unit UI checks. Source facts and Memory IDs remain unchanged.                                                                                                                                                                                                                                                                |
| Legacy compatibility                      | Fifteen durable task cases, six checkpoint receiver modes, signed source delivery, native capture and historical import database cases. Old named assignment evidence does not create a current Project or Capture Target.                                                                                                                                                                                                                                    |
| Independent selection                     | Six integrated Personal suites cover 17 cases. A synthetic Koed Conversation belongs to Release and Research, each with unrelated Git sources. Original Koed Git recall excludes those unrelated sources. Exact Folder cases exclude parents, children, siblings, and foreign directory identities.                                                                                                                                                           |
| Live changes                              | Rule, overlap, exclusion, correction, future capture, and two-device journeys execute against real databases. The task case removes membership during an in-flight search, recovers the same pinned request after lease expiry, and collects its terminal result. A second task loses a physically deleted source during search; later Git, graph, and Curated expansion cannot recover it.                                                                   |
| Repeatable upgrade                        | The original resumable catalog rehearsal executes supported activation after preserving Capture Targets. Effective policies and Capture Pauses survive. Later User edits remain intact. Unknown origin remains blocked from source export after legacy roles are archived and removed.                                                                                                                                                                        |
| Existing Team behavior                    | All 87 Shared Memory repository cases, 47 focused Team API cases, and five deterministic fixture cases pass, including the live fixture. These cover consent, grants, fixed repository snapshots, encrypted representations, Conversation Source Access, private/revoked denial, and retained knowledge. Real remote MCP database cases and all 15 transactional Team-task authority cases also pass, including revocation before terminal-result decryption. |
| Package 2 consumer                        | Both bounded consumer cases pass on migration 0069, including transaction commit ordering, stale pages, restart, missed changes, removal, and owner isolation. The signed rule-delivery journey reconciles sync-applied changes.                                                                                                                                                                                                                              |
| Native UI                                 | All four built Electron harnesses pass: workspace, Folder controls, collaboration, and managed preview. They use synthetic renderer fixtures and complement the real database and API tests.                                                                                                                                                                                                                                                                  |

## Commands and results

Commands ran from the repository root. Connection values identified local
synthetic databases and are omitted here. Database fixtures need the environment
variables named below; they must never point at a User's working database.
Native Electron commands used separate disposable profile directories.

| Command                                                                                                                                                              | Result                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm fmt:prettier:check`                                                                                                                                            | Passed; final documentation formatting is checked again before completion.                                                                                                    |
| `pnpm lint`                                                                                                                                                          | Passed; touched regression fixtures also received targeted lint checks.                                                                                                       |
| `pnpm typecheck`                                                                                                                                                     | Passed across production sources.                                                                                                                                             |
| `pnpm typecheck:test`                                                                                                                                                | Passed across test sources.                                                                                                                                                   |
| `pnpm build`                                                                                                                                                         | Passed across the workspace, including Desktop.                                                                                                                               |
| `pnpm db:migrate:check`                                                                                                                                              | Passed.                                                                                                                                                                       |
| `pnpm db:migrate:acceptance`                                                                                                                                         | All 15 scenarios passed, including historical upgrade, rollback, restore, and rerun. Uses `DATABASE_URL`, `PG_DUMP_BIN`, and `PG_RESTORE_BIN`.                                |
| `pnpm --filter @koed/db exec vitest run --no-file-parallelism`                                                                                                       | 550 passed. Dedicated staged and optional database suites, plus the added replacement-policy regression, are accounted for separately below.                                  |
| `pnpm --filter @koed/desktop exec vitest run --no-file-parallelism`                                                                                                  | 961 passed.                                                                                                                                                                   |
| `pnpm --filter @koed/mcp-server exec vitest run --no-file-parallelism`                                                                                               | 1,305 passed. Its 15 database capture/import cases passed separately with `DATABASE_URL`.                                                                                     |
| `pnpm --filter @koed/api exec vitest run --no-file-parallelism`                                                                                                      | 1,271 passed. All 35 database integration cases are exercised separately with `DATABASE_URL` and `KOED_OAUTH_TEST_DATABASE_URL`; the remaining skip is Linux-specific.        |
| `pnpm -r --workspace-concurrency=1 --filter @koed/shared --filter @koed/core --filter @koed/worker --filter @koed-labs/server exec vitest run --no-file-parallelism` | Shared 610, core 47, and local server 722 passed. Worker 362 passed after its three fixture expectations were corrected. Its database checkpoint case also passed separately. |
| `pnpm test:required-suites`                                                                                                                                          | All required non-empty suites passed: database, API, authorization, realtime, IPC, Electron UI, and accessibility. `DATABASE_URL` selects a dedicated fixture database.       |
| `node --test scripts/team-saas-fixture-lib.test.mjs`                                                                                                                 | Five passed, zero skipped, with `NODE_ENV=test` and a migrated disposable `DATABASE_URL`.                                                                                     |

The following dedicated DB commands also passed. Each runs with its indicated
fixture environment; staged upgrade tests require fresh databases.

```sh
pnpm --filter @koed/db exec vitest run tests/personal-selection-consumer.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/shared-memory-repository.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/memory-answer-task-repository.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/personal-source-closed-sync.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/personal-rule-delivery.test.ts --no-file-parallelism
pnpm --filter @koed/db exec vitest run tests/personal-membership-delivery.test.ts --no-file-parallelism
```

Activation, Capture Target, upgrade, and consumer cases use
`P1_ACTIVATION_DATABASE_URL`, `P1_CAPTURE_TARGET_DATABASE_URL`,
`P1_UPGRADE_DATABASE_URL`, and `P1_SELECTION_CONSUMER_DATABASE_URL` respectively.
Shared Memory and durable tasks use `SHARED_MEMORY_TEST_DATABASE_URL` and
`MEMORY_ANSWER_TASK_TEST_DATABASE_URL`. Each signed two-device journey uses its
own fresh `P1_SOURCE_ORIGIN_DATABASE_URL` and `P1_SOURCE_RECEIVER_DATABASE_URL`.

The PV cutover removes the old hidden Folder-filter demonstration.
Its recorded command below is historical.
Use [Project cutover validation](projects-default-view-validation.md) for the current native Project and source route.

The native commands for this historical record were:

```sh
pnpm --filter @koed/desktop exec electron scripts/validate-project-workspace.mjs
pnpm --filter @koed/desktop exec electron scripts/validate-project-folders.mjs
pnpm --filter @koed/desktop exec electron scripts/validate-collaboration-interactions.mjs
pnpm --filter @koed/desktop exec electron scripts/validate-managed-preview.mjs
```

The transactional Team-task command is `pnpm --filter @koed/db exec vitest run tests/memory-answer-team-authority.test.ts --no-file-parallelism`, with
`MEMORY_ANSWER_TEAM_AUTHORITY_TEST_DATABASE_URL` pointing at a disposable database.
It creates and removes its own isolated fixture database.

Normal package commands intentionally skip fixtures without their explicit
inputs. Those skips do not count as acceptance. The required Personal, Team,
migration, capture, cursor, and signed two-device gates listed here were enabled
and executed. Live Pi execution, the optional Redis priority integration, the opt-in Privacy capacity benchmark,
platform-specific Linux checks, packaged distribution validation, and staged
multi-User/cloud readiness are separate gates; this record does not claim them.
The existing Team fixture is validated for compatibility, not as a claim that a
new hosted deployment has completed model embedding or launch readiness.

## Implemented Project transfer controls

On 20 October 2026, the approved Transfer design replaced the named Project's
separate control buttons. The latest header uses a three-dot Rename/Sync menu and a standard icon-only
setup control. The transfer card opens in a centered modal and no longer shifts
the underlying Conversation view. Recorded-source drill-down and breadcrumbs distinguish browsing from
selection. Both panes remain fixed in height and scroll independently; narrow
windows stack the panes. The card has no explanatory footer or Ask buttons.

The Project inventory now carries active direct inclusion records independently
of the currently selected Conversation list. This keeps excluded direct reasons
available to remove without changing the exclusion. The card preserves existing
source context, overlapping reasons, Capture Policy, and Team authority.

Validation for this change:

- Production and test typechecks passed, including the shared inventory contract.
- Five focused Desktop UI/IPC suites passed 81 cases. The new card and existing
  main-process boundary suites passed 102 cases; seven overlap with the first run.
  The final eight-case transfer suite also passed, including a remote edit
  invalidating Undo. The 95-case main-process suite passed again with explicit
  direct-inclusion inventory pass-through coverage.
- Four API schema cases passed, including retained direct inclusions with an
  empty selected Conversation list.
- The production Desktop build passed. The real Electron check passed at 1100,
  736, 620, and 360 pixels: stable card/pane dimensions across drill-down,
  independent scrolling, preserved selection scroll positions, no horizontal
  overflow, and the edit pencil opening its dialog. A 500-pixel detail column
  inside an 1100-pixel window also stacks the panes through a container query.
- Targeted lint, formatting, and diff consistency passed.

Commands include `pnpm typecheck`, `pnpm typecheck:test`, the focused Vitest
suites `ProjectTransferCard`, `PersonalMemoryViews`, `ProjectMembershipActions`,
`ProjectSyncDetails`, `personal-memory-preload`, `manager`, and `graph-schemas`,
`pnpm --filter @koed/desktop build:package`, and
`pnpm --filter @koed/desktop exec electron scripts/validate-project-transfer.mjs`.
The full integration suite was not repeated for this UI change.

## Project setup dialog refinement

The setup card now starts closed and opens in a centered modal over the window.
The header has equal-sized setup and three-dot buttons; Rename and Sync live in
the menu. The underlying Conversation content does not move when setup opens.
Drill-down, breadcrumbs, independently scrolling lists, and versioned membership
writes retain their existing behavior. Closing setup returns focus to its button;
Rename and Sync return focus to Project actions. A pending membership write
prevents the setup dialog from closing.

For this refinement, four focused Desktop suites passed 66 cases. Production and
test typechecks, targeted lint, formatting, the Desktop build, and native Electron
checks passed. Native checks cover four viewport widths, equal header button
sizes, dialog centering, unchanged underlying content position, independent
scrolling, source navigation, and Rename/Sync menu-to-dialog focus restoration.
A narrow detail column no longer constrains setup width. The full integration
suite was not repeated.

## Project setup draft and included-source navigation

The right pane now offers All, Git Anchors, and Folders, with matching caret
navigation through recorded Folders to effective Project Conversations. A nested
Conversation can be excluded without removing its parent rule. Folder groups
derived from a Git Anchor are navigation only, while explicit rules and direct
inclusions remain individually removable.

Arrow actions now stage a local draft. Cancel, close, and Escape discard it;
Confirm saves it. Undo restores the preceding draft snapshot. Confirm retains
the opening Project version, checks source previews and Conversation membership,
and stops on the first failure. A failed or partially saved batch cannot be
replayed from the same dialog; the error reports saved changes and requires
reopening setup.

The focused ProjectTransferCard suite passed 13 cases covering staging, Cancel
and reopening, local Undo, exact-Folder writes, included-source navigation,
Conversation exclusion, existing exclusions, stale versions, wrong previews,
partial failure without replay, and independent scroll positions. Desktop build,
targeted lint, and native Electron checks passed. Native checks cover four widths
(1100, 736, 620, and 360 pixels), right-side drill-down, independent scrolling,
footer visibility in short windows, centering, and Cancel focus restoration.
The full integration suite was not repeated for this UI refinement.

## Conversation checklist and source comparison cards

The selected Checklist and Compare designs now use production components.
Conversation membership is reviewed when the checklist opens and staged locally.
Confirm pins each affected Project to its reviewed version; direct-only removal,
rule-based exclusion, separate direct reasons, reviewed Add back, and Sync conflict
blocking retain their distinct behavior. Cancel discards checkbox edits. Failed
or partial saves require reopening and cannot replay a saved operation.

The source comparison card edits one axis at a time. Review changes shows an
authoritative before/after preview and Project impact; Confirm applies only that
review ID and source revision. Changing the axis or target invalidates the review.
Cancel and reopening clear it. Pending synchronized sources remain blocked, and
conflicting candidates remain available for explicit review.

Three focused Desktop suites passed 26 cases: ProjectMembershipActions,
SourceContextCorrectionDialog, and ProjectTransferCard. Coverage includes staged
writes, Cancel/reopen, direct removal with overlapping rules, reviewed exclusion
revisions, stale versions, partial saves without replay, synchronized exclusion
conflicts, wrong-Conversation reviews, and invalid correction previews.
Production and test typechecks, the Desktop build, targeted lint, and formatting
passed. Native Electron checks cover 1100, 620, and 360 pixel widths at a 600 pixel
height, scrolling content with visible footers, fresh drafts after Cancel, source
impact preview, and explicit reviewed Confirm. The full integration suite was
not repeated for this UI change.

## Pre-commit UI cleanup

The full-app membership acceptance case and native workspace journey now use the
checklist and Confirm flow. The full-app case verifies that adding and removing
membership do not write until Confirm, while the open Conversation and recorded
source remain unchanged. The native journey confirms that only the selected
Conversation is added and the original source inventory remains available.

Unused membership, destination, and retired assignment-dialog styles were
removed. Each Conversation card now shares its opening handler between its menu
and standalone button triggers. The superseded root PLAN.md and unrelated
ISSUE.md were preserved outside the commit in ignored scratch storage.

The focused CollaborationApp membership case, native project-workspace
acceptance, Desktop build/typecheck, targeted lint, formatting, and whitespace
checks passed. The remaining application test suites were not repeated for this
cleanup.

## Package 2 handoff

Package 2 consumes the owner-authorized selection contract in
[Personal selection](personal-selection-contract.md#bounded-personal-selection-consumer).
It must finish bounded enumeration, combine every inclusion reason, retain the
change cursor, and reconcile stale or missed windows before using current
membership. Native Session IDs are local evidence; only a verified source
reference establishes portable identity. Cursor events contain metadata rather
than source content.

Membership, source-context correction, exclusions, availability, and removals
remain separate facts. This contract grants no Team publication authority.
Package 2 still owns consent, destination policy, sharing reasons, publication,
and Team acceptance. Personal Projects remain private sharing selectors.
The User deferred Team collections on 20 October 2026.
Existing Team grants and repository snapshots retain their current meaning.

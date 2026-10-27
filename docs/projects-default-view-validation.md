# Projects default view validation

Recorded on 27 October 2026 for PV-01 through PV-07 in [tickets.md](../tickets.md).
The implementation uses the existing Project catalog, membership engine, source identities, and worker scheduling.
[Personal inventory](personal-inventory.md) describes the architecture.
[ADR 0063](adr/0063-default-project-identities-and-automatic-provenance.md) records the default identity and synchronization decision.

## Existing-data result

The representative PostgreSQL fixture starts with 601 logical Conversations.
Reconciliation processes 37 source headers per batch through the durable worker path.
The API follows stable inventory pages, and the real Desktop store consumes the result.
Every starting Conversation remains reachable through a Project or the separate source views.

The initial result contains four named Projects, two Git Anchors, and three exact Folders.
Two checkout Folders share the Koed anchor. One Folder has standalone non-Git history.
A separate User-created Project keeps the same name as the automatic Koed Project.
One Conversation retains unresolved context. No local execution Folder is inferred from recorded paths.

The fixture excludes one Conversation and adds the research anchor to Koed.
The Project contains 598 distinct members after overlapping reasons are counted once.
The selected exact Folder contains 299 members. Its nested Koed-anchor selection contains 298 members.
The exclusion applies to both selections, and the nested selection does not include the other anchor's history.

Rename survives later capture. The Project grows to 599 members.
Removing research from Koed and deleting its automatic Project survive repository restart and another research capture.
The Koed Project then contains 598 members. Both research Conversations remain available through their independent Git source.
The final inventory contains 603 reachable Conversations and three named Projects.

| Final classification                                   | Measured result |
| ------------------------------------------------------ | --------------: |
| Git Anchors                                            |               2 |
| Exact Folders                                          |               3 |
| Equal source identity rows after canonical aggregation |               0 |
| Equal-label groups with distinct identities            |               2 |
| Logical Conversations represented in overlapping views |             602 |
| Unresolved Conversations                               |               1 |
| Available Conversations without a Project              |               3 |

Overlapping views retain one logical identity per Conversation.
The zero repeated-identity rows describe the aggregated result, not an absence of overlap in the input.
Separate classification cases cover repeated identities, equal paths on different devices, parent and child Folders, and replaced directory lifetimes.
The fixture source is [personal-project-default.test.ts](../apps/api/src/memory/personal-project-default.test.ts).

## Persistence, recall, and sharing

Nineteen final PostgreSQL journeys pass across the default lifecycle, device convergence, and membership suites.
They cover atomic source drafts, stale versions, rollback, rename, exclusion, removal, guarded retirement, later capture, and restart.
The current Project, Git, and exact Folder Ask targets retain their selection through request retries and thread reuse.
Compound targets and foreign owner selections fail.

The membership retrieval journey exercises search, evidence expansion, and current source authorization after membership and source changes.
MCP checks retain the accepted selection for each evidence expansion and pin explicit Desktop Ask targets.
Desktop checks cover Recent Conversations, deep links, source filters, back navigation, missing selections, and local Folder choice.
The API checks cover named inventory and ordered Desktop Ask submission.

Five convergence journeys use two isolated PostgreSQL databases with real signed records and encrypted Personal transport packages.
They cover automatic creation before pairing, equivalent offline roots, later rename, concurrent User edits, removal, deletion, delayed replay, and restart.
Pending source metadata creates neither a Conversation nor a default Project.
Verified source readiness and corrections schedule the same reconciliation path as local capture.
Owner translation retains the originating Folder device, profile, and directory lifetime.
An unrelated owner cannot receive the configuration or read the source.

Four sharing regression cases pass against disposable databases.
Project edits change the existing continuous-sharing consumer through actual membership.
They create no consent, Workspace Access, or Conversation Source Access.
Existing Team snapshots retain their published context while later shares use current selections.
The documented Team fixture also passes its positive and denial matrix for seven Users, three Workspaces, fourteen memories, and five thread kinds.
This scope does not claim full Team launch qualification or staged VPS validation.

## Native UI validation

Run the automated Project journey from the repository root:

```bash
pnpm --filter @koed/desktop build:validation
pnpm --filter @koed/desktop exec electron scripts/validate-projects-default.mjs
```

The shared browser runner uses a disposable native Electron profile, synthetic
Memory and a simulated AI Client. The journey checks the clean header, Project
actions menu, exact execution Folder selection, draft retention, repeated Project
switching, Folder filtering, and Ask. It retains layout and focus checks at narrow
and short window sizes, plus renderer fault collection.

Screenshots and the result record are written under `scratch/pv-07/native-ui`.
The runner closes the window and removes its profile after validation. The completed
manual demo launcher and preview mode have been removed; automated browser checks
remain part of `pnpm --filter @koed/desktop test:browser`.

These results are automated native UI evidence and agent screenshot inspection.
A User-run manual session and a physical two-computer session were not performed.
The two-database convergence fixtures supply the device-sync evidence.

## Cutover and release scope

Projects is the default Personal navigation destination. Ask remains an explicit destination.
Named Project rows, independent source views, and native checkout metadata use separate inventory boundaries.
The rejected Project move commands, session-assignment bridge, and unused UI hooks remain removed.
The User requested restoration of the Folder filter dropdown after the cutover.
The current title dropdown restores Folder checkboxes and Select all for named Projects and independent source views.
Source-context correction and local checkout associations retain their separate authority boundaries.

The workspace TypeScript build and test type check pass.
The 352 focused checks, four shell navigation checks, and two targeted API checks pass.
Full lint, formatting, migration metadata, and ADR numbering checks pass.
They include the production Desktop renderer and preload build as well as the native validation renderer.
The full unrelated repository test suite was not run.

A minor release remains the recommendation because the change adds visible navigation, source management, automatic organization, and synchronization behavior.
The User explicitly requested that the implementation changeset remain omitted for now.
This work does not deploy the feature, reset active data, or claim a physical device dogfood run.

## Project header regression

A follow-up on 27 October 2026 fixes headers that accumulated while the User switched Projects.
The header and Ask panel used the same sibling React key.
The renderer now gives the header, management controls, and Ask panel distinct keys for each Project.
This preserves their separate state and removes the previous header during navigation.

The regression fails before the fix with two visible headers after one switch.
Both focused cases pass after the fix, with management controls enabled and disabled.
The native demonstration also passes repeated switching with one current header and one current Ask target.
This UI identity fix changes no service boundary or data flow, so architecture documentation needs no update.

## Restored Folder dropdown

A further User request on 27 October 2026 restores the Project title dropdown.
It includes Folder checkboxes, an indeterminate Select all control, and Show all beside the filtered list.
The same header supplies these controls for named Projects and source views.

Visibility preferences use the existing local per-Project store.
They survive Project switching and refresh, and malformed preferences remain protected against overwrite.
A Folder filter intersects the current Sources selection and authorized Project membership.
The complete Project remains available to the dropdown, and Ask retains its displayed Project or source target.

The focused restoration check covers saved visibility, all and no Folders selected, source intersections, and unchanged membership.
The native demonstration exercises the restored dropdown alongside repeated Project switching.
The synthetic non-Git fixture uses distinct checkout identities for its separate Folders.

## Startup loading regression

The original cutover loader waited for all source pages, then named and Folder inventories, before it displayed any Project.
It also deferred native metadata and reconciliation status until that complete read finished.
This made the first Project display depend on the full captured history.

The follow-up adds an initial named Project read and keeps complete source enumeration in concurrent background work.
Independent inventories and native reads start together. Parallel requests share their API-origin status probe.
The existing owner checks, native execution proof, source cursors, and logical deduplication remain in place.

Controlled delayed-response checks show Projects and their Conversations while source enumeration and native enrichment remain blocked.
They cover late initial responses, superseded loads, initial-read failure, source failure, and subsequent refresh.
The workspace check opens a Project during that delay and retains one header after source loading completes.
These checks prove the dependency is removed. They do not report a measured startup time for the active User profile.

## Project header simplification

A later User request on 27 October 2026 moves New Conversation into the three-dot Project actions menu.
The Project header no longer renders the Sources or Ask collapsible sections.
The main Project list no longer offers Browse by source.
These presentation choices supersede the corresponding earlier PV-04 UI examples.

The Folder dropdown, source-management dialog, dedicated Personal Ask destination, and managed execution Folder checks remain available.
The updated workspace checks cover the clean header, both management and fallback menus, local Folder choice, disabled remote launch, and saved Folder visibility.
The native demonstration follows this current menu flow and retains the header-switching regression check.

## Folder chip in the real composer

On 27 October 2026 the User chose prototype A, the compact toolbar chip, and requested draft preservation when changing Folders.
The real `ConversationInput` now hosts the chip beside permissions and AI Client settings.
The chip shows the basename; its menu and accessible label retain the full path.
Choosing another Folder updates execution and command discovery without remounting the composer.
An unavailable selection disables launch and requires a new choice while retaining the draft.
A pending start locks the Folder choice, and a retry retains the original launch identity.

The 81 focused input, composer, and workspace checks pass.
They cover two Folder choices with the same textarea and draft, the selected native execution identity, unavailable Folders, and a lost start response with an idempotent retry.
Desktop type checking, the production and validation builds, targeted lint, and formatting pass.
The isolated Electron demonstration passes all nine checks without renderer faults.
Its screenshots were inspected for the selected chip and full-path menu in the real composer.
No real AI Client or active profile was used.

The prototype is preserved as a primary source on local branch `prototype/folder-composer-2026-10-27`,
commit `8807cd5dcc5ce5dc2425008e7eda6baf401aefda`.
Its `docs/prototypes/folder-composer.md` records the question and the User's choice.
Only the selected production design remains in the current application.

## Ask Project choices and shared input

On 27 October 2026 the User requested named Projects on Ask and the same shared input with the Folder chip.
Ask now reads the named catalog, including Projects without a path or local execution capability.
The Project selector replaces the old directory-opening action and includes Projects outside the three recent cards.
The cards exclude raw Git, Folder, and unresolved inventory entries.

Ask uses the same `NewConversationComposer`, `ConversationInput`, and `ConversationFolderPicker` as Project launch.
The existing execution resolver provides only native Folders eligible for the chosen Project.
The draft and AI Client settings survive Project and Folder changes.
Losing a selected Folder disables launch until the User chooses another Folder.
Chat retains its isolated directory and displays Automatic Folder in the same toolbar.

The 13 focused Ask, Notes, and launch-retry tests pass.
The cases cover named catalog choices, empty and remote Projects, directory-free Project identities, startup retries, draft preservation, unavailable Folders, selected execution targets, and independent Chat.
The isolated native demonstration passes eleven checks without renderer faults.
Its Ask checks select a named Project through the menu, change Folders twice with the same draft input, and send that prompt using the selected opaque Folder identity.
The narrow-window check keeps the input and Send control within the viewport.
Desktop type checking, production and validation builds, targeted lint, and formatting pass.

## Folder availability after a macOS remount

The harness Project exposed a stale numeric device marker in its native Folder registration.
The directory still existed with the same inode and nanosecond creation time, but its mount device number changed.
The strict numeric comparison therefore removed its local execution choice.

Capture and execution now share the directory marker and registration resolver.
A stable macOS volume UUID, inode, and creation time identify new observations.
An existing numeric marker can be adopted at the same host-bound path when its inode and creation time match and current volume metadata is available.
A capture observation updates the marker while preserving the Folder and directory-lifetime identifiers.
Read-only availability does not change registration or captured history.

Eight focused shared and native cases pass.
They cover remount adoption, identity retention, read-only lookup, duplicate registrations, changed inodes and creation times, mismatched volume UUIDs, real directory replacement, and device rotation.
The real harness directory passes the rebuilt native lookup with its original Folder and directory-lifetime identifiers.
The lookup uses the active profile without starting an AI Client or changing that profile.
The shared package, server, Desktop, and complete source runtime builds pass, along with targeted lint and formatting.

## First launch from an empty native checkout

The dev-vm Project had native checkout metadata but no exact Folder registration and no captured Conversations.
The launch menu therefore had no execution choice even though the local checkout existed.

Contract version 27 adds a strict native preparation operation that accepts only an opaque local checkout identifier.
After publishing the catalog, Desktop prepares unregistered native checkouts selected by current Project Git rules.
Electron main requires the current host proof, checks the live Git source without probe caching, and verifies its current matching remote.
An existing unavailable registration blocks this path, including a replaced directory at the same path.
The operation creates no captured source context and changes no Project membership.

The 60 focused native preparation, inventory state, preload, and contract tests pass.
They cover first launch, idempotent preparation, real directory replacement, changed portable Git context, missing host proof, rejected renderer paths, early catalog display, and failed optional preparation.
The dev-vm Folder was prepared from its known native checkout and live Git context in the actual profile.
The resulting native availability lookup succeeds, and existing Folder registrations remain unchanged.
No Conversation was started and no captured history was rewritten.
The shared package, complete source runtime, and Desktop builds pass, together with targeted lint and formatting.

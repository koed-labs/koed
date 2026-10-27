# Projects as the default view

Date: 27 October 2026.
Baseline: `codex/repo-targeted-recall` at `6afcf869`.
Status: approved by the User on 27 October 2026, including the ticket breakdown and blocking edges. Implementation has not started.

The Projects view will list named Projects. Each Project will contain Conversations selected through Git Anchors, exact Folders, or direct inclusion.
Koed will create useful default Projects from recorded sources. Users can rename these Projects and change their sources.
Git checkout Folders will appear beneath their Git Anchor when recorded context establishes that relationship.

The current branch is not deployed. Its new Project contracts, components, routes, and storage structures can change directly.
This work does not need compatibility adapters, dual writes, old client support, or upgrade screens for those branch components.
That permission does not authorize deleting the User's captured Memory or resetting the active development profile.

## Agreed scope and implementation defaults

The agreed direction establishes one Project experience, source navigation beneath Projects, editable names, flexible grouping, and removal of redundant top-level entries.
The following sections record the approved lifecycle and implementation defaults.

The scope includes default creation, recorded-source reconciliation, navigation, membership management, and Personal Device Sync.
It preserves exact Folder matching, independent source recall, multiple Project membership, and the prohibition on nested Projects.
It does not add automatic semantic grouping, a general Project merge tool, recursive Folder matching, or a new sharing model.

## Current implementation

The backend already stores named Projects, source rules, direct inclusions, exclusions, and membership revisions.
Rules already select existing and future Conversations. Renaming a named Project retains its identity and source rules.
The Desktop setup dialog already supports multiple Git Anchors, Folders, and individual Conversations.

Desktop currently combines three inventories into one Projects list:

- Git and historical context groups from the Conversation graph.
- Named Projects from the membership catalog.
- Exact Folders from the Folder inventory.

This explains how one Conversation can appear through a Git grouping, a Folder grouping, and a named Project.
Some equal labels can also represent different devices, directory lifetimes, or unresolved history.
The individual live `koed-alt` entries still need classification. Code inspection does not establish that every repeated label is a duplicate identity.

The current graph request reads at most 500 Conversations. Default creation and duplicate classification must use complete source inventories, not this page.
The existing checkout display helper can group paths beneath repository roots. That display behavior cannot define exact Folder identity or membership.

## Target experience

The main list contains named Projects, including those created automatically.
Project rows show the editable name, a distinct Conversation count, and a compact source summary.
The interface does not distinguish a manual Project from an automatically created Project as separate product types.

Opening a Project shows its combined Conversations immediately.
A Sources control exposes its Git Anchors, exact Folders, and direct inclusions.
A Git Anchor expands to recorded Folder contexts, with path and device labels when needed.

For example, the Koed Project can include the Koed Git Anchor and an independent design-notes Folder.
The Git Anchor can expose both the `koed` and `koed-alt` checkout Folders.
A Research Project can include two unrelated Folders without a Git Anchor.

Source navigation has explicit semantics:

- A Project view selects the union of its inclusions, minus its exclusions.
- A source filter inside that Project selects the intersection with its current members.
- A nested Folder filter also respects the selected Git Anchor when that Folder has several recorded Git contexts.
- Browse by source opens an independent Git Anchor or exact Folder selection.
- Independent and unresolved Conversations remain reachable through a separate system view.

The system view is not a named Project and does not count as one.
It also exposes available Conversations that belong to no Project after deliberate removal.
Search can find a Project through its name or source labels without adding source rows to the main list.
Back navigation retains the selected Project, source filter, and Conversation when those identities remain available.

Ask continues to show its explicit recall target.
A list filter does not silently change Ask scope. The Project Ask target remains the Project, with that scope visible beside the input.
Browse by source provides independent source Ask targets. A Project-and-source compound recall target is outside this change.

A Project with several local Folders cannot supply one implicit execution directory.
New Conversation actions use an explicit Folder choice and can remember that choice locally.
Remote-only, historical, and unavailable Folders remain browsable. They do not become local launch or reveal targets.

## Default Project creation

A default source key identifies one automatic creation decision.
It contains the source kind and canonical source identity within the owning Personal scope.
It never uses a display name, a bare path, an enclosing directory, or overlap between remote lists.

Use the existing named Project catalog and inclusion rules for defaults.
Add only the provenance and retained creation decisions needed to make initialization repeatable and respect later User actions.
There must be no second catalog of virtual Projects that becomes a real catalog after the first rename.

The default-creation decision follows this order:

1. Resolve the source from recorded, owner-authorized context.
2. Honor any retained suppression or previous initialization decision.
3. If an active Project already includes that exact source through a rule, record that it is managed and skip default creation.
4. If a portable or device-local Git Anchor is known, create one default Project with that Git rule.
5. If a proven standalone Folder is known, create one default Project with that exact Folder rule.
6. If context is uncertain, leave the Conversations accessible without inventing an assignment.

Direct inclusion of a few Conversations does not establish a rule for their entire source.
Several Projects can include the same source intentionally. Default creation must not choose a primary owner among them.
The source rule determines membership. A creation decision only prevents duplicate or unwanted initialization.
Removing the last rule for a managed source is also a retained User choice.
Reconciliation must not respond by creating a new default that reverses that removal.

A Project receives its initial name from the repository label or Folder basename.
The name remains stable after creation, including after later metadata refreshes.
Another clone or worktree with the same selected Git Anchor extends the same rule's results without creating another Project.

Automatic creation must retain deliberate changes:

- Rename preserves the Project identity, rules, exclusions, and creation decision.
- Removing the seed rule prevents initialization from restoring it or creating a replacement Project.
- Deleting a default Project retains the source decision that prevents automatic recreation.
- Removing a directly included Conversation preserves any other inclusion reasons.
- An explicit Project exclusion overrides all reasons within that Project.
- Users can explicitly create another Project or add the source to an existing Project after suppression.
- Empty Projects remain manageable until the User deletes them.

Project deletion does not delete captured Memory.
Existing sharing reconciliation still processes real membership or Project deletion changes through its established rules.
Source presentation changes alone do not create or revoke sharing authority.

## Folder and Git relationships

A Folder identifies one exact directory context with its recorded deployment, device, profile, and directory lifetime.
Two equal paths from different devices or directory lifetimes remain distinct.
The selected Git identity determines Git grouping across clones and worktrees.

Nest a Folder beneath a Git Anchor only when effective recorded context or verified checkout provenance establishes the relationship.
Do not infer historical Git identity from the current filesystem, a Folder basename, or another Conversation at the same path.
A Folder with mixed Git and non-Git history can appear in several filtered source views.
Every view keeps the same Folder identity and returns only its stated selection.

A Folder fully represented by a Git rule does not receive a redundant automatic wrapper.
If a Folder also has confirmed non-Git Conversations, its exact Folder rule can justify a separate default Project.
That rule includes the full exact Folder selection, so intentional overlap with Git Projects remains possible.
Unknown context is not proof that a Folder is non-Git.

If a standalone Folder later gains a Git Anchor, retain existing User choices.
Automatically retire its old Folder default only when it is demonstrably untouched, fully covered, and has no exclusions, direct additions, or sharing attachments.
Otherwise, show the source relationship and offer normal source-management actions. Do not silently merge the Projects.
Changing a checkout's selected anchor does not rewrite earlier Conversation context or retarget a Project rule.

## Handling existing entries

Classify the complete recorded inventory before changing presentation or membership.
The classification must explain what each repeated row represents and which Conversations remain reachable.
Use the same repeatable process for existing development data and later source discovery.

| Existing entry                                    | Treatment                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Two rows with the same canonical Git identity     | Show one source entry and reuse one default-creation decision.                |
| Several checkout Folders with the same Git Anchor | Show them beneath that anchor, with exact Folder filters.                     |
| Several rows for the same full Folder identity    | Show one Folder entry and deduplicate logical Conversations.                  |
| Equal Folder labels with different identities     | Retain distinct entries and show path, device, or historical context.         |
| Raw source grouping also represented by a Project | Remove the raw grouping from the main list and retain it in Browse by source. |
| Existing User-created Projects with equal names   | Preserve both identities and their membership.                                |
| Unknown or conflicting historical source context  | Keep it accessible with an explicit unresolved label.                         |

The main duplicate problem is overlapping navigation, not duplicated Memory storage.
Presentation cleanup must not delete Conversations, rewrite source assignments, or change logical source identifiers.
Only a separately reviewed source correction can repair genuinely wrong recorded context.
Existing correction controls remain available from the source view.

There is no general merge-by-name operation in this plan.
Users regroup by adding source rules to the intended Project, then removing unwanted rules or deleting empty Projects.
Previews show distinct affected Conversation counts and current inclusion reasons before applying a change.
Concurrent edits invalidate the preview and require a fresh view.

## Implementation boundaries

First separate the Project catalog from source inventories through the existing read path.
This is a focused prefactor of inventory composition, source classification, and selection state.
It does not require a rewrite of the full Personal Memory view or unrelated runtime services.

The backend owns default creation and its retained decisions.
The renderer requests authorized operations and displays results. Rendering or refreshing a GET response does not create Projects.
Project creation, the seed rule, the default decision, and the membership journal entry commit together under the existing owner transaction boundary.

Native source capture and verified source-context corrections schedule reconciliation after the source becomes durable.
Verified source arrival through Personal Device Sync uses the same boundary.
An initial bounded scan covers existing records, and a durable retry path resumes failed work after restart.
Use existing runtime scheduling where practical. Source capture remains accepted if a later organization step needs retry.

Local checkout discovery supplies navigation metadata. It does not independently create a second Project or prove historical source identity.
The initial scan and later reconciliations use source-level queries with stable pagination.
They cannot depend on a rendered Conversation page, a recent-activity cutoff, or loading every transcript into memory.

Membership stays dynamic through the existing selection engine.
Project creation does not copy Conversations, replace capture assignments, rebuild embeddings, or introduce backend LLM calls.
Selection consumers continue to share the same membership and exclusion rules.

### Current integration points

These references locate the current design. Tickets describe behavior rather than copying these paths.

- `apps/desktop/src/koed-server/manager.ts` currently combines the three inventories.
- `apps/desktop/src/project-memory-ui.ts` merges source groups with local checkout metadata.
- `apps/desktop/src/project-conversation-folders.ts` builds display groups that must remain separate from exact Folder membership.
- `apps/desktop/src/renderer/views/personal/PersonalMemoryViews.tsx` owns the current Projects pane and navigation.
- `apps/desktop/src/renderer/views/personal/ProjectOrganization.tsx` and its transfer controls already manage named Project sources.
- `apps/api/src/memory/personal-project-routes.ts` and `personal-folder-routes.ts` expose the current owner inventories.
- `packages/shared/src/personal-project-contract.ts` and `personal-source-contract.ts` define Project and source identities.
- The Personal membership repositories, projections, and configuration transport carry catalog changes and retained removals.

## Personal Device Sync

Automatic defaults need a stable portable identity for the same canonical source within one authorized Personal scope.
Use a domain-separated deterministic identity for generated Projects and their seed rules, with the existing native identity mapping.
Derive it from canonical source identity rather than a database-local Session identifier or display name.
Keep default keys and source details inside authenticated, encrypted Personal configuration transport.
An equal derived identifier grants no access and creates no shared checkout-selection association.

Distinguish automatic initialization from User-authored edits in the retained history.
Equivalent concurrent initializations can converge to one default without manufacturing a rename conflict.
Concurrent renames, deletions, source edits, and suppression decisions retain their actual intent and existing review requirements.
An offline initialization cannot override a later deletion or restore a removed source rule.

Test creation before pairing, creation on both offline devices, delayed source arrival, and replay after restart.
Do not create a local Folder rule from an equal receiving-device path.
A source that is unavailable locally remains pending without fabricating a Conversation or execution directory.
No support for older versions of these unreleased branch contracts is required.

## Delivery sequence

Each behavior ticket includes the storage, API, caller, interface, tests, and documentation needed for its outcome.
The first ticket is the focused behavior-preserving prefactor.
The remaining tickets are complete, narrow product slices on the integration branch.

| Ticket | Outcome                                                                         | Blocked by   |
| ------ | ------------------------------------------------------------------------------- | ------------ |
| PV-01  | Separate Project and source inventories without changing current behavior.      | None         |
| PV-02  | Create one persistent default Project for a Git Anchor and honor its lifecycle. | PV-01        |
| PV-03  | Create exact Folder defaults and classify existing duplicate entries.           | PV-02        |
| PV-04  | Make Projects the main navigation and expose sources underneath.                | PV-03        |
| PV-05  | Rename and regroup Projects through consistent source controls.                 | PV-04        |
| PV-06  | Converge defaults and retained User choices across Personal devices.            | PV-03        |
| PV-07  | Complete the branch cutover and demonstrate the integrated behavior.            | PV-05, PV-06 |

PV-04 and PV-06 can proceed independently after PV-03.
This is a dependency statement, not a request to launch parallel agents.
Release the complete change after PV-07. Do not introduce permanent compatibility layers to release an intermediate state.

## Acceptance and demonstration

Use a compact synthetic fixture with one anchor, two checkouts, two standalone Folders, and existing User-created Projects.
Include equal names with unequal identities, exact parent and child Folders, overlapping rules, exclusions, unresolved history, and more than 500 Conversations.
Reuse existing repository, membership, inventory, Desktop, and sync test harnesses.

The final demonstration follows one complete journey:

1. Open existing recorded data and see one Koed Project instead of repeated raw top-level rows.
2. Expand Sources and inspect Conversations from both checkout Folders.
3. Rename the Project and add a standalone Folder without changing source attribution.
4. Capture another Conversation from a matching checkout and see it appear once.
5. Remove a source or delete a default, then restart and confirm that it stays removed.
6. Open Browse by source and recall the exact source independently.
7. Repeat on a paired device, including offline creation and a retained deletion.

Automation covers stale edits, restart recovery, complete inventory paging, device identity, and rejected cross-owner operations.
Focused regression checks cover Project Ask, source Ask, Recent Conversations, deep links, managed execution targets, and existing sharing consumers.
Project changes continue through existing continuous-sharing reconciliation without creating new consent or changing source access authority.
The final record distinguishes automated results, native UI results, and unavailable environments.

## Documentation and release

Update the Project glossary only when implementation adopts the resolved domain change: Projects can also be created automatically.
Keep implementation details and follow-ups in the plan and backlog.
Update architecture documentation for inventory separation, default creation, source navigation, and Personal configuration synchronization.
Correct superseded current-behavior claims while retaining prior validation records as history.

Record the identity and concurrent-initialization trade-off in an ADR when implementing the deterministic identity design.
Remove replaced branch-only components and contracts as their callers move. A development-data reconciliation is not a compatibility API.
Do not rewrite deployed migration history or reset a User profile merely because branch contracts can change.

No changeset is needed for this planning step, as confirmed by the User on 27 October 2026.
The implementation is release-noteworthy. Recommend a minor bump for the new default organization and navigation behavior, then confirm that release choice.

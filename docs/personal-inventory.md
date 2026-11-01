# Personal Project and source inventories

Named Projects, Git Anchors, exact Folders, and local checkout metadata have separate identities.
A named Project uses its owner and Project reference.
A Git Anchor uses its canonical repository scope within the authenticated owner's Personal Memory.
An exact Folder uses its full owner, deployment, device, profile, and directory lifetime reference.
Names and paths provide display information. They do not establish membership or source equality.

The API exposes named Projects through `/v1/personal/projects/inventory` and exact Folders through `/v1/personal/folders/inventory`.
The source endpoint `/v1/personal/sources/inventory` returns separate `gitSources` and `unresolved` arrays.
It reads 100 Conversation headers per page and returns a `nextCursor` when another page exists.
The cursor contains the authenticated owner and the last source, provider thread, and local Session identifiers.
The API rejects a cursor for another owner and applies the normal Personal source authorization to every page.

Source pages use identifier order rather than recent activity or numeric offsets.
Repeated provider thread identifiers remain separate when their local Session identifiers differ.
Activity changes do not shift page boundaries. A refresh includes new captures or source corrections that sort before an existing cursor.
Desktop collects each raw page before it hides nested subagents or removes repeated logical Conversations.
A parent on a later page can therefore hide its nested subagent correctly.

The shared inventory helpers classify recorded source identities and deduplicate logical Conversations.
Deduplication retains local source references and inclusion reasons for navigation and source management.
Repeated views of one logical Conversation do not add their event counts together.
Each Project or source selection still has its own membership boundary.
The existing selection engine continues to apply Project rules, direct inclusions, and exclusions.

Desktop stores named Projects, Git sources, exact Folders, unresolved history, and local checkout metadata separately in its state snapshot.
The main list reads named Projects. Separate source inventories support membership controls and retained Conversation links.
Local checkout discovery supplies execution and display metadata through explicit discovery operations.
Inventory reads do not discover checkouts, create Projects, change membership, or alter captured source assignments.

Startup uses `personal.projects.named.list` to display the existing named inventory before source history finishes loading.
The complete inventory loads concurrently through `personal.projects.list`.
Named, Folder, and paginated source requests run independently. Source pages retain their stable sequential cursor boundary.
Native metadata, available local Folders, and reconciliation status also start independently from source enumeration.
Parallel Personal reads share one active API-origin status lookup.

The first named result can display and open Projects while source details remain pending.
The Sources controls report that loading state instead of treating missing details as a completed empty inventory.
A completed inventory replaces the initial view. Later or superseded initial responses cannot overwrite it.
Refresh keeps the existing complete inventory until its replacement is ready.
An initial-read failure falls back to the complete inventory read. A source-read failure retains any named inventory already loaded.

Transport pages remain bounded. Existing named Project and Folder views retain their 5,000-Conversation view limit.
An unavailable or oversized view produces an error instead of a silently incomplete catalog.
The source header index does not replace the source reconciliation scheduler or authorize capture, sharing, or local execution.

## Default Git Projects

The worker creates one default Project for each eligible recorded Git Anchor.
The source key uses the canonical source selector within authenticated Personal scope.
The Project uses a stable generated identity. Its initial name uses the repository label.
Clones and worktrees with the same selected Git Anchor match its seed rule.
The rule includes existing and future eligible Conversations through the normal membership engine.

Source capture commits a durable reconciliation checkpoint and sends a PostgreSQL notification.
The worker uses the existing notification and retry scheduler to scan bounded pages of recorded source context.
The migration schedules the same scan for existing owners.
Native capture, source corrections, verified source bindings, and replica readiness wake that scan.
The worker never needs to read transcripts or inspect current directories to create defaults.

One owner transaction creates the Project, seed rule, initialization provenance, and membership journal entries.
Concurrent attempts use the existing owner membership lock.
An initialization failure rolls back that transaction and leaves accepted capture and scan work available for retry.
Restart resumes the durable checkpoint. Source changes during a scan cause another complete pass after the current pass.
The worker notifies Desktop through the normal membership update channel.

An active Project rule for the exact source records a managed decision and prevents a redundant default.
Direct inclusion of individual Conversations does not manage their whole source.
Rename preserves identity and membership. Later capture and source metadata changes preserve the chosen name.
Removing a source rule or deleting its Project records suppression in the same owner transaction.
Historical removed rules and deleted Projects also prevent an unwanted replacement during the initial scan.

Suppression prevents automatic creation. It does not prevent an explicit source inclusion or delete captured Memory.
An empty Project remains available for normal management.
Initialization provenance remains separate from User edits in the native membership journal.

## Exact Folders and recorded relationships

A recorded standalone Folder can use the same default creation and suppression lifecycle as a Git Anchor.
The worker requires a known exact Folder and a recorded non-Git source observation.
Missing Git context alone does not prove that a Folder is standalone.
Parent and child Folders remain separate exact selections.
Device, deployment, profile, and directory lifetime remain part of every Folder reference.

The shared classification reports equal source identities, equal labels with distinct identities, overlapping Conversation views, and unresolved history.
Each Folder reports its recorded Git relationships and distinct standalone and unresolved Conversation keys.
A checkout Folder can therefore appear under each Git Anchor that its recorded history supports.
A mixed Folder retains its independent exact selection and accurate counts.
Neither the current filesystem nor a matching basename supplies a historical Git relationship.

The worker creates no Folder default for history that a Git rule fully represents.
Confirmed non-Git history can justify an exact Folder default even when other Conversations in that Folder have Git context.
That rule selects the complete exact Folder. It does not rewrite the captured assignments.
Existing User Projects keep their identities, names, rules, direct inclusions, and exclusions.

If a Folder later becomes fully covered by active Git rules, the worker can retire its untouched automatic Folder Project.
The worker requires the original Project and seed-rule revisions, no other inclusions or exclusions, and complete authorized coverage of the Folder history.
Sharing attachments prevent automatic retirement.
The worker conservatively retains a Project when protected sharing records prevent a conclusive attachment assessment.
Renamed, edited, mixed, and unresolved Projects remain available through the normal source management controls.

## Project and source navigation

The Project list contains named Projects, including automatic defaults and User-created Projects.
Project search includes recorded source labels and exact Folder context.
The Project header contains its title and Folder filter dropdown, source management, and the Project actions menu.
New Conversation is inside the three-dot Project actions menu.
The main Project view has no Sources or Ask collapsible section and no Browse by source entry point.

The Folder dropdown intersects current authorized Project members.
Hidden source-view navigation state does not narrow a named Project after its source-filter controls are removed.
Its saved visibility choices change the Conversation list only.
Personal Ask remains a separate destination.
Its start cards and Project selector use the named Project catalog, including empty and remote Projects.
Raw Git and Folder inventory entries do not become Project choices.
Ask and Project launch use the same `NewConversationComposer`, `ConversationInput`, and Folder chip.
Choosing a Project limits the chip to eligible native Folders through the same Project execution resolver.
Changing Projects or Folders retains the draft and AI Client settings.
A Project with no eligible local Folder remains selectable, but it cannot start local execution.
Chat keeps its isolated Conversation directory and shows an Automatic Folder chip.
The existing explicit Project, Git, and Folder selection contracts remain available to authorized callers.
The Local AI Runtime pins the accepted selection for the existing AI-client synthesis path.

Conversation links retain local source bindings when several physical records represent one logical Conversation.
A missing Project or Conversation falls back to an available source or the Project list.
The retained source inventories do not create catalog entries or add membership.

New Conversation uses a concrete Folder from the native Folder registry.
Choose New Conversation from Project actions to open the launch view.
The launch view places a Folder chip inside the real input toolbar, beside permissions and AI Client settings.
The chip shows the Folder name. Its menu and accessible label include the full path.
A Project with multiple available Folders requires an explicit Folder choice.
Changing Folders keeps the same input mounted and retains the draft and AI Client settings.
The first launch uses the selected opaque native Folder identity.
Once a launch starts, the Folder choice stays locked so an uncertain start retries its original execution.
The read path checks the current host identity, profile, directory marker, and recorded directory lifetime.
On macOS, the marker uses the stable volume UUID, inode, and nanosecond creation time.
A changed mount device number does not create a new Folder.
Existing numeric markers can retain their identity when the native host, exact path, inode, and creation time still match and volume metadata is available.
A live capture observation upgrades that marker without changing the Folder or directory-lifetime identifiers.
Availability reads do not modify the registry.
A different recorded volume UUID, inode, or creation time rejects the old registration.
When stable volume metadata is unavailable, the read requires the original numeric device marker.
Volume metadata is cached only within one availability read, so later reads inspect the current mount again.
If earlier mount-number changes created duplicate native registrations, the resolver prefers the current marker and returns one live choice per directory.
It preserves recorded history and existing identifiers.
The availability read does not create a registration or infer availability from a remote path.
A separate native preparation operation handles first launch from an already known Git checkout with no Folder registration.
After publishing the Project catalog, Desktop prepares only native checkouts selected by current Git rules.
The native operation checks the host proof and fresh Git context before registering the directory.
It refuses an existing unavailable registration and never repairs captured history.
This lets a Project with no captured Conversations start its first Conversation without waiting for capture to create a Folder.
The picker retains a local choice only while that Folder remains available.
Project rules determine which local choices can receive future Conversations in that Project.

The managed execution API resolves the selected native Folder again before it starts execution.
API execution checks reject historical paths without native execution metadata.
Historical graph paths cannot supply a local execution fallback.
An unavailable or remote Folder remains available for browsing and recall.
Read-only Project reconciliation status distinguishes pending organization from an empty inventory.

## Project source management

The same Sources controls manage automatic and User-created Projects.
Rename retains the Project identity, rules, direct inclusions, source context, and existing references.
An open rename draft keeps its reviewed version. A background refresh cannot silently rebase it.

A Project can include several Git Anchors, exact Folders, and individual Conversations.
Canonical targets prevent duplicate rules. Logical Conversation identity determines distinct counts.
The draft shows distinct recorded source matches and overlapping inclusion reasons.
Existing Project exclusions still apply. The Conversation membership review explains the exact current reasons and exclusion state.
Removing one reason leaves other reasons intact. Add back requires the current exclusion revision.

Confirm sends the complete source draft to `POST /v1/personal/projects/:projectId/sources`.
The API validates a bounded list of changes and the reviewed Project version.
The existing membership engine applies every change under one owner lock and one transaction.
A stale version, invalid source, or failed later mutation rolls back the entire draft.
Previews use the same starting version. The UI requires a fresh review after a conflict.
Transport uncertainty does not trigger an automatic retry against a new version.

Regrouping uses explicit additions and removals. Equal names do not merge Projects.
These operations edit membership metadata. They do not retarget a Git Anchor or move captured Memory.
The normal membership notification reaches existing sharing reconciliation.
No source-management operation creates sharing consent, Workspace Access, or Conversation Source Access.
Removing a rule uses the same retained default suppression as a single-source edit.

## Personal device convergence

Automatic Project identity comes from the canonical source key, independently from pairing time.
The existing portable inclusion identity joins each device's native seed rule.
User-created Projects keep independent identities even when their names or sources match.
[ADR 0063](adr/0063-default-project-identities-and-automatic-provenance.md) records this identity trade-off.

Initial catalog and seed-rule revisions retain automatic provenance and the real author.
Equivalent automatic roots can produce one available view while retaining every causal head.
A later User operation takes precedence over an automatic root that its device had not seen.
Concurrent User names, rule changes, and deletions retain the existing review requirement.
Automatic retirement also retains its provenance and cannot override a concurrent User edit.
The database binds the chosen view to its retained revision and rejects hidden concurrent User heads.

The signed, encrypted Personal configuration channel carries default decisions under `project_defaults_v1`.
It publishes initialized sources as managed and retains initialization details in membership history.
Managed decisions cannot reverse retirement or suppression.
Received removals retain suppression through the same helper as local membership edits.
Replay, restart, and later capture cannot automatically recreate a removed default.
An explicit source inclusion remains available after suppression.

Source keys and targets remain inside the encrypted configuration payload and local owner storage.
Receipt checks the current group, witness, receiving device, key, epoch, authority head, and policy.
Owner translation preserves the original Folder device, profile, and directory lifetime.
No decision creates a source row or grants access through an equal key or path.
Verified source readiness and corrections schedule the same bounded reconciliation used by local capture.
Pending source metadata does not create a Conversation or an automatic Project.
A verified closed source creates its default only after body readiness.
An unrelated owner cannot introduce the signed record into that Personal scope or read the source.

## Integrated cutover

Projects is the default Personal destination, and Ask remains explicit.
The shell and workspace resolve system source views from one transient presentation model.
Those views retain source browsing and Conversation breadcrumbs without creating Project catalog entries.

The Project title dropdown retains Folder checkboxes, Select all, and per-Project saved visibility.
These local presentation preferences intersect the current source selection and Project members.
They do not change membership, source assignments, Ask targets, or local execution choices.
The rejected Project move and session-assignment bridge remain removed.
Project source management uses atomic versioned membership changes.
The maintained native Project browser journey runs through `pnpm --filter @koed/desktop test:browser`.
Its automated results and the unperformed User manual and physical two-computer sessions are recorded separately.

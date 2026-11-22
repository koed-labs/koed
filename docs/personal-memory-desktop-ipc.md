# Personal Memory Desktop IPC

Koed Desktop keeps the reusable Personal API Token in Electron main. The
preload and renderer do not receive the token, an Authorization header, or an
API base URL. Electron main derives the local API origin from current
`koed-server` status and accepts it only when it is a credential-free loopback
HTTP(S) origin.

The typed bridge exposes owner-scoped Project, source, Conversation, Ask, and Note operations.
Its inventory read separates named Projects, Git Anchors, exact Folders, and native checkout metadata.
`personal.projects.named.list` reads only the named Project inventory for the initial display.
`personal.projects.list` follows stable source pages to completion for the complete background inventory.
The renderer does not wait for that complete read before it shows named Projects.
Independent inventory and native metadata reads run concurrently, while shared status lookup avoids repeated supervisor probes.
The renderer can also read bounded Recent Conversations, event pages, and Project reconciliation status.

Project management uses reviewed versions and the existing membership engine.
The `explain_sessions` action reads up to 100 Conversations per request through
`POST /v1/personal/projects/:projectId/memberships/explain-batch`. Each batch uses
one owner transaction and checks the reviewed Project version and source ownership.
Settings and source previews request batches sequentially. A failed batch discards
partial membership results but keeps the loaded Sync review accessible.
Contract version 33 replaces the Folder hint creation command with the
read-only `personal.folders.hints.confirm` command described below.

Contract version 32 adds the `list_exclusions` action
(`POST /v1/personal/projects/:projectId/exclusions/list`, owner-scoped, read-only,
version-pinned), which returns the newest available session of every Conversation
currently excluded from the Project. Settings loads these alongside the Project's
members, so the Excluded tab lists every exclusion, whether or not the Project syncs.
The settings editor sends one bounded batch through `personal.projects.manage` with the `apply_sources` action.
The batch can include a rename, source rules, direct membership changes, and a version-pinned exclusion restore.
The API commits the complete batch under one owner lock and transaction.
Contract version 30 adds `personal.folders.hints`, which returns advisory Folder
hints for up to 50 Conversations. Electron main asks the API for recorded evidence
(`POST /v1/personal/sessions/folder-hint-evidence`, owner-scoped and read-only),
then reads the current directory, Git remote, and Folder registry on this device
and scores each Conversation with the Folder-hint scorer. The registry lookup never
registers a directory. The renderer supplies no path and receives only a tier, a
score, an existing Folder reference, and reason codes. The correction dialog shows
one short "Suggested: <name>" row with a Use button, for a medium or strong hint
on an unresolved Folder. A `?` evidence tooltip exists but is hidden for now
(`SHOW_PROPOSAL_WHY`) until its wording is settled; when shown, the tooltip
leads with the reason ("Same Git remote as koed-ai", "Worktree of koed"), then
lists the agreeing reason codes as short lines, strongest first, with the path
(`~` for the home folder) or Git Anchor shown as quieter detail. Weak activity
and transcript-file evidence appear only when nothing stronger agrees. A
worktree is named after its project (`koed · worktree task-1`); the label is
presentation only and never changes Folder identity.
The folder-hint evidence the API returns also carries the AI Client (`sourceRuntime`) and its own session id, so Electron main can read that client's local worktree record on this device.
Contract version 31 widens a hint with a `kind`: `registered` (unchanged),
`worktree-parent` (the registered Folder of the main checkout a linked worktree
belongs to), or `create` (a directory with no Folder yet, named by `directory`).
The Personal API does not expose a standalone Folder observation write. Owner
authentication does not establish that the calling device captured the target
Conversation. Desktop offers no action for `create` hints.
Electron main fetches evidence, scores locally, then sends only distinct scored
Folder references as `proposedFolders` on the same read-only route (at most 100
references per request). The API returns only proposed references backed by the
same owner-scoped recorded facts as correction preview. A registry-only Folder
is not offered as an action. Batches without Folder candidates skip this check.
`personal.folders.hints.confirm` takes a Conversation ID, `registered` or
`worktree-parent` kind, and full Folder reference. Electron main fetches fresh
evidence, checks only that reference, and re-scores the exact kind and reference
on the device. No observation or Folder is written. The versioned correction
preview remains authoritative for the Conversation.
The dialog resolves the suggested Folder to the named Projects whose active rules cover that exact Folder and words the suggestion "Suggested Project: X" when one does ("Suggested Folder" otherwise); a candidate that lands in a Project is preferred. Each Project row in the sidebar shows only its settings menu (⋯), with no counts. Project settings › Conversations shows the number of suggestions beside the page name, and which lists "In Project", "Suggested" and "Excluded" separately; the counts are worked out in the background shortly after start-up, a batch at a time (hints in batches of 50 with a short in-memory cache), and recomputed after an edit. A Conversation excluded from the Project is never suggested for it. Every row on the three tabs shows the AI Client, how the Conversation is or would be connected ("Git Anchor", "Folder", or "Added by you" when no rule matches; "Git Anchor match", "Folder match", "Worktree of koed" for suggestions; "Excluded by you") and its age, with one action: Remove, Add, or Add back. An action only stages a change: the row is tinted with "Will be added", "Will be removed", "Will be excluded" (a Conversation a rule still matches is excluded, since the rule would bring it back) or "Will be added back", and offers Undo. "Keep if rules change" (direct membership) and "Not this one" sit in the row's menu; "Not this one" stages "Will be excluded", and saving excludes the Conversation from the Project, so it moves to Excluded; a kept Conversation shows a padlock, is listed first on In Project, and always has the menu so it can be turned off (with no rule matching, turning it off stages "Will be removed"). The footer counts what saving will do ("1 to add · 1 to remove"). Save changes first applies the Project's own changes, then applies each ticked suggestion exactly as the single dialog does (accept the hint, review the correction against the Conversation's current state, save a version-pinned edit), so the Conversation joins through the Project's Folder or Git Anchor rule rather than direct membership. The two steps are not atomic; a suggestion that fails is reported and the rest still apply. After saving, an excluded suggestion is also hidden in renderer local storage per owner scope on this device, so it is no longer counted as a suggestion, until the suggestion itself changes (a different Folder, Git Anchor or Project).
A hint can also have `kind: "repository"` with a `repositoryKey` (the portable fingerprint of the directory's current remote); the evidence the API returns carries `gitAnchorKnown` so a Conversation that already has an anchor gets none. Accepting one is a Git Anchor correction that needs no device-side step.
A Conversation can return several hints, best first (a registered Folder, the main
checkout of a linked worktree, a new Folder), and a hint may carry the Folder's
`directory` for display. Each hint batch reuses one lazy, bounded asynchronous
Claude Code worktree record index; ineligible Conversations do not trigger that
lookup. A worktree parent must have a known birthtime earlier than the first
Conversation timestamp. A hint alone does not make its Folder eligible for a
correction; the exact Folder reference must already be backed by server correction
context.

Contract version 29 carries the optional Project Kin in named Project inventory and
catalog review. The `set_details` change saves the name and Kin together at the
reviewed Project version.

Contract version 28 adds the `organize` action to `personal.sources.manage`.
Electron main maps it to `POST /v1/personal/sessions/:sessionId/organization`.
It carries the reviewed source context, Project versions, desired direct/excluded membership states,
and up to two explicit source corrections. The renderer supplies no API origin or filesystem mutation.

An ordinary sidebar move changes only the originating and destination Projects.
It removes the originating direct inclusion, excludes the Conversation when a source rule would add it back,
and adds a direct inclusion to the destination. Other Projects, the Folder assignment, and Git Anchor remain unchanged.
An excluded destination requires the exact reviewed exclusion revision and explicit restoration.
Pending or conflicting synchronized exclusions cannot be bypassed.

Advanced moves and the source context editor can also clear or correct Folder/Git assignments.
The UI combines the existing server correction previews for both axes; each preview must match the reviewed context and Project catalog.
The atomic organization operation checks that context and, for source edits, the complete active Project catalog again.
It reuses the existing correction and membership repositories inside one owner transaction, including their sync guards and publication records.
A failed change rolls back all assignments and memberships. Original source evidence and execution Folders are retained.
The result contains bound before/after snapshots. Undo submits their inverse with the resulting source and Project versions;
it fails on intervening edits rather than replacing a stale inventory.

The V1 sidebar exposes these actions through compact Project settings, Conversation menus, and source tags.
Source edits retain their drafts across tabs and save together. Newly selected Project sources load their matching Conversation preview,
without exposing a full-library add picker. Capture provenance is still authoritative for launch reconciliation;
pending membership confirmations must finish before a captured Conversation can be reorganized.

Ask accepts one explicit named Project, Git Anchor, or exact Folder target.
A nested list filter does not change the Ask target.
Native Folder observations come from Electron main through `personal.folders.local.list`.
Contract version 27 adds `personal.folders.local.prepare` for a first launch from an already registered native Git checkout.
Its strict input accepts only `localProjectId`. Electron main resolves the directory from its own metadata.
It requires the current host proof and probes Git without a cached observation.
The current Git source and path must still match the registered checkout, including an observed matching remote for a portable source.
An existing unavailable Folder registration blocks preparation, so this operation cannot adopt a replaced directory.
A successful preparation registers current execution availability without changing captured source context or Project membership.
An equal path in remote history cannot supply an execution Folder.
See [Personal inventory](personal-inventory.md) for identities, counts, and the current navigation boundary.

Folder visibility preferences use the bounded `project_folder_filter_get` and `project_folder_filter_set` commands.
Electron main stores them per Project under the local profile in `config/project-folder-filters.json`.
These commands carry only the Project identity and hidden display-Folder identities.
They use no Personal API request and edit no source or membership records.
The title dropdown applies their selection only to the Conversation list.

The Personal Conversation timeline may also contain a validated `activity`
row for owner-only Approval Activity. Activity rows use a distinct stable ID,
validated display fields, and source chronology. They do not affect Project or
Captured Session Memory counts, and the renderer never infers activity from
arbitrary text. Collaboration IPC separately exposes the owner-wide
`Personal > Memory > Shares` view; it returns bounded Pending Share or Share
Grant DTOs and opaque pagination cursors, never credentials or generic URLs.
`collaboration.get_owned_share` refreshes one selected owner-authorized detail
pane. `pending_share_lifecycle` realtime events contain only content-safe
status and are re-materialized from durable owner state before delivery.

The shared contract uses strict schemas. Preload validates renderer arguments
before IPC and validates main-process results before returning them. The main
IPC handler repeats both validations and admits only the trusted Desktop main
frame. Unknown fields—including credentials, headers, generic URLs or paths,
and remote authority—fail closed.

Electron main maps each operation to a fixed local API method and route. It
constructs query parameters and request bodies from validated domain fields,
bounds response sizes and timeouts, and returns only the renderer DTO. Project
management uses explicit domain identities and reviewed versions. Native execution
uses an opaque Folder identity that the API resolves and reauthorizes locally.
Title updates use the fixed, owner-scoped Captured Session title endpoint. On HTTP 401, main discards the
retained token, provisions a replacement internally, and retries once. No
generic HTTP proxy or compatibility credential command exists.

Managed coding uses separate strict bridges rather than expanding the Personal
Memory bridge. Managed Conversation IPC handles launch, resume, prompts,
runtime actions, usage, transfer, and encrypted drafts. Managed Project IPC
handles exact diffs, queued rooted file reads, terminal lifecycle, terminal
frames, and opaque development-preview lifecycle. Each request is correlated
to one execution and operation; terminal events are correlated to one
renderer-owned connection and preview events to one renderer-owned surface.

Electron main reads the encrypted Desktop Local Credential and uses only its
`managed_file_read`, `managed_terminal`, or `managed_preview` scope against the
loopback API.
Preload and renderer code receive neither the credential nor an API origin.
Main owns terminal WebSockets, validates every frame, bounds payloads and
queues, and closes renderer-owned connections when the sender is destroyed.
The renderer uses a maintained terminal emulator with URI, clipboard, and host
command integrations absent. File and terminal context enter a prompt only by
an explicit opaque attachment reference that the API reauthorizes and resolves.

Development previews retain an additional main-process boundary. The API
publishes only an opaque preview record after proving that a loopback listener
belongs to the current execution terminal's process tree. Electron main alone
may exchange the preview id for the verified navigation URL, and it loads that
URL in a sandboxed `WebContentsView` with a unique non-persistent partition.
The application renderer receives no URL, port, process id, path, credential,
browser storage, DOM access, or generic navigation operation. Preview requests
are limited to the verified origin and its matching hot-reload WebSocket;
permissions, downloads, popups, other local services, private networks, and
external origins fail closed. Detach destroys the view and clears its storage.

## Solo desktop presentation state

The solo desktop uses a separate typed `koed:v1-state:command` bridge for local
appearance, onboarding progress, and the provenance of chats and Projects
created through that interface. Main validates requests and results and stores
the state encrypted under the Electron profile. It derives the provenance scope
from the authenticated Personal User and backend origin; neither credentials
nor the backend URL are exposed to the renderer.

The renderer saves a creation intent before starting a Conversation or creating
a Project, then acknowledges the returned identity. Recovery reuses the same
request key. The registry determines frontend visibility only. It does not
change Capture Policy, historical ingestion, Projection, recall, or source
retention. Capacity errors are explicit and never silently discard records.

The solo presentation retains the existing managed Conversation controller for
streaming, approval, draft recovery and command delivery. Its model and reasoning
controls use the same capabilities, and its onboarding uses the existing local
setup and AI Client commands with their existing consent requirements.

## Recall activity operations

The production v1 renderer uses `personal.recall.list`,
`personal.recall.detail`, and `personal.recall.overview` through the typed
Personal Desktop contract. Main process access is restricted to the corresponding
Personal API Token endpoints under `/v1/memory/recall-activity`; the renderer
receives neither credentials nor a generic HTTP or database capability.

List requests apply metadata filters before keyset pagination and decrypt at most
50 selected question texts, read in one encrypted-payload query. The cursor preserves PostgreSQL timestamp precision.
Refresh can omit content and request hydration for a bounded set of changed IDs;
returned null text means unhydrated, not an empty question. Detail returns bounded
answer/evidence and usage projections without raw provider payloads. Historical
job matches are labelled and do not affect list/chart totals.

The v1 page subscribes to the existing `ask_questions_changed` wire event. Its
name remains compatible with older consumers, and it covers both question
origins. The event carries IDs, not question content, and is only a refresh hint;
every read reauthorizes and reapplies the Personal Memory predicate. Refreshes
coalesce, pause while hidden, reject stale responses, and use a visible fallback
of at least 60 seconds with failure backoff. Each coalesced change re-reads the
list. It re-reads the overview only when ten seconds have passed since the last
overview read, and otherwise schedules one catch-up read for that moment. The
overview error state clears only when an overview read succeeds.

Recall filters also accept a recorded Memory-found result, calling AI Client name
(an empty name selects unknown callers), and minimum/maximum measured duration.
The overview returns result counts, the found percentage with its exact
denominator, known-duration coverage, and a median over individual measurements.
Each question includes nullable versioned metadata; legacy rows remain unknown,
as do fields this build cannot read. The database validates the metadata once,
and filters, overview totals and each returned row all use that one result, so a
row never displays one value and counts as another. `docs/observability.md`
states the rule.
These fields carry no caller authority or stable installation identity.

The overview also returns `filterOptions` for Projects and AI Clients across the
whole date range, independent of pagination and the active filters. Preset date
ranges follow local calendar rollover and resume after sleep. Custom ranges stay
fixed. Question text is bounded to 100,000 characters for presentation. A returned
question sets `queryTruncated` when its display text is shortened, and detail also
sets `contentTruncated`. Stored question content remains unchanged. Usage coverage checks expected attempts
and claimed runs. Personal ownership receipts preserve permission to record late
usage after transient task cleanup without retaining question or answer content. Refreshes
retain the truncation flag when they reuse previously hydrated text.

Overview requests can opt into `bucket: "hour"` for ranges of up to 25 hours.
This covers local calendar days across daylight-saving changes. Existing callers
that omit the field retain automatic day/week/month buckets. Desktop uses hourly
buckets for Today and groups full-range daily totals for longer preset charts;
pagination never determines chart totals.

Recall questions now include an optional nullable `scope` projection. It identifies
the accepted scope kind, provenance and owner-authorized Project labels; the
renderer must not replace it with current Conversation memberships. Project-union
filters use the same retained set in list, overview and linked-usage queries.

List and overview responses include `projectScopeStatus`: `complete`, `updating`,
or `unavailable`. It describes coverage of historical Project identities.
Project-filtered results are incomplete until this status is `complete`.
Desktop hides their totals and chart, labels the partial rows, and refreshes
every two seconds while history is updating and the page is visible. Unavailable
history uses the normal polling interval. Unfiltered totals remain valid.
The field is optional for older backend responses. New overview responses omit
the unused `tokenTimeline` field. The decoder discards this field from older
responses. Token totals and coverage remain.

Recall detail also includes optional nullable `execution` data validated by
`recallExecutionSchema`: effective allowances, consumption/remaining values,
exhaustion, ordered post-admission delivery operations, and final selected evidence
count. These values come from the runtime's retained execution snapshot. They are
separate from `usage`, which keeps its existing provider accuracy and coverage
semantics. Missing older fields stay unknown. Operation lists are bounded at 100
with explicit truncation. No raw trace or omitted evidence content reaches this
surface. See `docs/observability.md` for the accounting boundaries and one-time
historical scope projection.

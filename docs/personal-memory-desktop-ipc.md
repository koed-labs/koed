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
The source editor sends one bounded batch through `personal.projects.manage` with the `apply_sources` action.
The API commits the complete batch under one owner lock and transaction.
The bridge exposes no Project move or captured-source assignment command.
Source-context correction has its own versioned review and operation.

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

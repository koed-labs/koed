# Personal Memory Desktop IPC

Koed Desktop keeps the reusable Personal API Token in Electron main. The
preload and renderer do not receive the token, an Authorization header, or an
API base URL. Electron main derives the local API origin from current
`koed-server` status and accepts it only when it is a credential-free loopback
HTTP(S) origin.

The renderer-facing bridge exposes exactly four typed operations:

- list the current Personal Memory Project graph and Captured Sessions;
- load one bounded page of Memory Events for an explicit Project and thread;
- move or reset one Captured Session's Project assignment by domain ID;
- update one Captured Session's owner-defined title by session ID.

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
assignment resolves the destination Project details from the main-owned graph;
the renderer cannot provide a filesystem path. Title updates use the fixed,
owner-scoped Captured Session title endpoint. On HTTP 401, main discards the
retained token, provisions a replacement internally, and retries once. No
generic HTTP proxy or compatibility credential command exists.

Managed coding uses separate strict bridges rather than expanding the Personal
Memory bridge. Managed Conversation IPC handles launch, resume, prompts,
runtime actions, usage, transfer, and encrypted drafts. Managed Workspace IPC
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

# Personal Ask and Notes

Koed Desktop provides two Personal workflows: Ask and Notes.

## Ask workflow

Ask searches all Personal Memory that is visible to the current User. It uses
the global Search Domain. The first question creates an Ask thread. A later
question can append a turn to that thread.

Each turn has this lifecycle:

1. The Personal API creates a durable `pending` Memory Question.
2. The Local AI Runtime asks Codex to retrieve and synthesize a Memory Answer.
3. The runtime completes the same row as `answered` or `error`.
4. Desktop shows the final, display-safe turn.

If the Local AI Runtime stops after creating a turn but before completing it,
the pending row remains durable. Before a successor runtime accepts new Ask
work, it atomically converts pending Desktop Ask turns owned by the same User
into an explicit retryable error. This prevents an interrupted request from
remaining indefinitely pending while preserving the original thread and turn.

For a global question without retrieval hints, the runtime uses one hydrated
search across the Personal Memory stages. This search avoids duplicate query
embeddings before the worker starts. Questions with retrieval hints retain the
staged scan and routed search path.

The backend does not perform LLM synthesis. The Local AI Runtime uses the
connected Codex installation for synthesis.

Follow-up retrieval uses only the current question. The runtime can send up to
20 completed question-and-answer pairs as conversation context. This context
has a 64 KiB UTF-8 limit. The runtime removes the oldest pairs first. It does
not send evidence, diagnostics, credentials, or authorization data as context.

## Recents

Recents contains only threads that start in Koed Desktop. It does not include
`memory_answer` calls from MCP or other AI Client surfaces.

Recents appears at the bottom of the primary Personal navigation. The Ask
content area does not contain a second navigation pane.

The first question is the thread title. The newest turn controls the order.
Pending and failed threads remain visible. Desktop loads 50 threads per page
and uses an opaque cursor to load older pages.

Memory Question change events refresh the Ask cache. They do not refresh the
Personal Project graph. Desktop keeps prior thread content if a refresh fails.

## Notes workflow

Notes is a first-class, owner-scoped master-detail workspace. A Note has one
stable identity, encrypted title metadata, and immutable numbered body
revisions. It is not a collaboration thread and does not participate in chat
receipts, unread counts, message delivery, or thread lifecycle.

Creating a Note commits the aggregate and revision before returning. Renaming
uses an optimistic title version. Saving a body edit requires the expected
current revision and creates the next immutable revision. A stale title or body
write conflicts instead of overwriting another device. Idempotency keys make
exact retries stable and reject divergent reuse. Desktop provides explicit
Save and Cancel actions; a failed save preserves the draft for retry.

Each revision has durable Projection state. The API projects the current
revision into one idempotent Personal Memory Event and admits its embedding to
the interactive priority lane. A bounded repair service retries pending or
failed revisions without blocking Note reads or edits. The previous projected
revision remains current for recall until its replacement is available. The
successful replacement then supersedes and invalidates older Note revisions
atomically, so Personal recall never moves backwards or exposes two current
versions.

Personal Note events and embeddings remain outside Project counts, Project
activity, Captured Session grouping, chat, and LCM summarization. The encrypted
immutable revisions remain available for provenance and exact sharing.

The full-width layout keeps the Note list beside the detail pane. The narrow
layout uses a list, drill-in detail, and Back action.

### Sharing one Note to a Team

Share is available only after the Note has its exact projected Personal Memory
Event and the User has an active writable Team Workspace. The review dialog
shows one exact immutable Note revision and defaults to Continuous sharing. The
User may instead select an immutable Snapshot. Memory Event is the only
representation; LCM, Curated Assertions, and Conversation Source Access are
not available for a Personal Note.

Approval binds the Note id, positive immutable revision, exact Memory Event id,
logical memory id, owner, destination, current policies, one-item manifest, and
protected hashes. The mutable owner-local Note title is not part of the
immutable source revision and never becomes Team-visible metadata. Koed derives
the Team-visible label from the privacy-filtered representation for the pinned
revision.

Review and initial activation re-read the exact selected revision rather than
silently retargeting to the current Note. A later body edit therefore neither
changes nor invalidates a Snapshot. For a Continuous Share, successful
Projection durably queues the exact newer revision. Rapid edits coalesce to the
latest eligible revision. Privacy classification and Team materialization run
before publication; teammates continue reading the prior sanitized revision
until the new derivative replaces it atomically. Owner-private plaintext never
becomes a fallback Team read.

The local source worker uploads each authenticated, bounded candidate through
the enrolled device credential. The Team
Backend stores a standalone encrypted source artifact and materializes one
encrypted Team Memory Event. This path creates no Captured Session, memory
replica, Cross-Identity Sync relationship, LCM representation, Curated
Assertion, or Conversation Source Access grant. Authorized Team recall retains
provenance for the Share Grant, source artifact, source Note, source Memory
Event, revision, and revision hash. Revocation ends Team recall and companion
access without changing the Personal Note, its Memory Event, or Personal Ask.

## Desktop and runtime boundary

The renderer uses Personal Desktop contract version 7. It can request fixed
Ask list, detail, and submit operations. It can request fixed Note create,
list, detail, title-rename, and body-update operations. Note creation and body
updates supply generated idempotency keys; updates also supply the expected
revision. The renderer cannot provide an owner id,
Memory Event id, URL, HTTP method, header, API Token, or runtime credential.

Electron main authenticates the fixed Note routes with the owner-bound local
app API Token. The create route always targets the local owner. It does not use
upstream personal collaboration routing. The same routes also accept an
authorized browser session or a scoped device credential. This Personal Memory
access grants no Personal chat or Team authority. The API Token never crosses
the preload boundary into the renderer.

Note lists are bounded and use newest-first source-sequence pagination. Exact
Note reads return the current revision, Projection state, and currently bound
Memory Event when available. Initial titles come from the first non-empty body
line. Explicit title changes use encrypted Note metadata and optimistic title
versions; they do not alter revision content or an activated Share. The
protected change stream emits bounded `notes_changed` invalidations after Note
or Projection commits so open Desktop windows can refresh while retaining their
last valid state after a failure. A visible retry action refreshes both the list
and selected detail after a transient service failure.

Electron main maps each operation to one fixed route. It reads the protected
Local AI Runtime registration and calls only `POST /v1/desktop/ask`. The runtime
returns display fields only. It removes evidence and worker diagnostics before
the result reaches Electron main.

Desktop Ask is not an MCP tool. It is not present in MCP discovery or the Local
AI Runtime tool-name list. The existing `memory_answer` MCP tool continues to
use the same authorization and persistence behavior.

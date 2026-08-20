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

Notes is a master-detail workspace under Shares. It presents existing
Notes-to-self messages without a data migration.

Creating a Note uses the fixed owner-scoped Notes route. Electron main sends
the body and an idempotency key to the local Personal API. The API creates or
reuses the local Notes-to-self thread. It stores one message and projects one
Personal Memory Event. The API returns the Note after Projection succeeds.

The Note body is immutable in this release. Desktop does not provide body-edit
or delete actions. If a save fails, Desktop keeps the body and shows an error.

After the durable message is accepted, the Personal API projects it as one
idempotent Personal Memory Event and schedules its embedding in the
interactive priority lane. The Worker preserves this priority when it calls
the Embedding Service. Background capture embedding uses bounded requests so
an interactive search can run between them. The event keeps
the Note's creation time and Notes-to-self message identity, is excluded from
LCM summarization, and is available to the global Ask workflow after embedding
completes. Personal-channel and Team collaboration messages do not use this
Projection path.

The API also reconciles historical Notes in owner-scoped pages. A durable
per-owner cursor records the last processed Notes-to-self sequence and bounded
counts for existing events, created events, embedding admission, and failures.
One malformed Note advances as a recorded failure and does not block later
Notes. Repeated work uses the Note message identity, so it resolves to the same
Memory Event. Personal Note events and their embeddings stay out of Project
graph counts, Project activity, session grouping, and LCM work.

The full-width layout keeps the Note list beside the detail pane. The narrow
layout uses a list, drill-in detail, and Back action.

### Sharing one Note to a Team

Share is available only after the Note has its exact projected Personal Memory
Event and the User has an active writable Team Workspace. The review dialog
shows one immutable Note snapshot. Its mode is always Snapshot, and its only
representation is Memory Event. Continuous mode, LCM, Curated Assertions, and
Conversation Source Access are not available for a Personal Note.

Approval binds the Note id, Memory Event id, logical memory id, owner,
destination, revision 1, current policies, one-item manifest, and protected
hashes. The mutable Note title is not part of the immutable source revision.
The activation-time title becomes independent Share Grant display metadata.
Later Note renames and Share renames do not affect each other.

The local source worker uploads one authenticated, bounded candidate. The Team
Backend stores a standalone encrypted source artifact and materializes one
encrypted Team Memory Event. This path creates no Captured Session, memory
replica, Cross-Identity Sync relationship, LCM representation, Curated
Assertion, or Conversation Source Access grant. Authorized Team recall retains
provenance for the Share Grant, source artifact, source Note, source Memory
Event, revision, and revision hash. Revocation ends Team recall and companion
access without changing the Personal Note, its Memory Event, or Personal Ask.

## Desktop and runtime boundary

The renderer uses Personal Desktop contract version 6. It can request fixed
Ask list, detail, and submit operations. It can request fixed Note create,
list, detail, and title-rename operations. Note creation supplies only the body
and a generated idempotency key. The renderer cannot provide an owner id,
Memory Event id, URL, HTTP method, header, API Token, or runtime credential.

Electron main authenticates the fixed Note routes with the owner-bound local
app API Token. The create route always targets the local owner. It does not use
upstream personal collaboration routing. The same routes also accept an
authorized browser session or a scoped device credential. This Personal Memory
access grants no Personal chat or Team authority. The API Token never crosses
the preload boundary into the renderer.

Note lists are bounded and use newest-first source-sequence pagination. Exact
Note reads return the existing projected Memory Event. Historical titles come
from the first non-empty body line. Explicit title changes use the encrypted
message metadata namespace and optimistic title versions; they do not change
the immutable body or Memory Event. The protected change stream emits bounded
`notes_changed` invalidations after Projection or title commits so open Desktop
windows can refresh while retaining their last valid state after a failure. A
visible retry action refreshes both the list and selected detail after a
transient service failure.

Electron main maps each operation to one fixed route. It reads the protected
Local AI Runtime registration and calls only `POST /v1/desktop/ask`. The runtime
returns display fields only. It removes evidence and worker diagnostics before
the result reaches Electron main.

Desktop Ask is not an MCP tool. It is not present in MCP discovery or the Local
AI Runtime tool-name list. The existing `memory_answer` MCP tool continues to
use the same authorization and persistence behavior.

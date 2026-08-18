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

Creating a Note sends one durable Notes-to-self message. Notes are immutable in
this release. Desktop does not provide edit or delete actions. A failed durable
send remains available through the existing Inbox recovery workflow.

After the durable message is accepted, the Personal API projects it as one
idempotent Personal Memory Event and schedules its embedding. The event keeps
the Note's creation time and Notes-to-self message identity, is excluded from
LCM summarization, and is available to the global Ask workflow after embedding
completes. Personal-channel and Team collaboration messages do not use this
Projection path.

The full-width layout keeps the Note list beside the detail pane. The narrow
layout uses a list, drill-in detail, and Back action.

## Desktop and runtime boundary

The renderer uses Personal Desktop contract version 4. It can request only
fixed Ask list, detail, and submit operations. It cannot provide a URL, HTTP
method, header, API Token, or runtime credential.

Electron main maps each operation to one fixed route. It reads the protected
Local AI Runtime registration and calls only `POST /v1/desktop/ask`. The runtime
returns display fields only. It removes evidence and worker diagnostics before
the result reaches Electron main.

Desktop Ask is not an MCP tool. It is not present in MCP discovery or the Local
AI Runtime tool-name list. The existing `memory_answer` MCP tool continues to
use the same authorization and persistence behavior.

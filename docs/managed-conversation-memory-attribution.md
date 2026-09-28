# Managed Conversation Personal Memory attribution

Each accepted managed prompt, including a first message sent when a chat is
created, gets a Personal Memory search in the conversation's current project or
global scope. A completed search with no matches is recorded as `available`
with no evidence. Retrieval infrastructure failure is recorded as
`unavailable`; authentication and identity errors still fail the request.

The command's encrypted payload stores the retrieval status, evidence, and a
fresh attribution nonce. An initial start command passes that same context to
its generated prompt command. Idempotent retries use the persisted command
payload, so they cannot replace the accepted evidence with a later search.

Provider instructions say retrieved evidence alone does not prove the reply
used it. The final reply may include a reserved internal footer bound to the
actual prompt command ID and nonce. The API accepts `used: true` only when the
footer matches that exact command and the encrypted context is available with
at least one evidence item. Selected evidence IDs must belong to that context.
Malformed, missing, replayed, or mismatched footers produce no Memory-used
attribution. The footer is removed from displayed output before message
clipping.

When a reply is read from encrypted history, the API checks each selected
source against current owner-scoped Personal Memory access. Current source
names and dates can be shown. Deleted or revoked sources use the generic label
`Source no longer available`; saved retrieval metadata is not used as a
fallback. If the reply confirms Memory use but no selected source can be
verified, the client can show a general `From Memory` note. An unavailable
search produces a clear notice without attributing Memory use.

Command IDs, nonces, evidence IDs, source IDs, and raw retrieval text remain in
encrypted command payloads. They are not part of public managed-conversation
events or rendered citation labels.

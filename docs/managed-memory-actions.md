# Memory actions in a managed Conversation

`memory_forget` and `memory_correct` are available to Codex, Claude, and Pi only
inside a locally managed Koed Conversation. External MCP callers receive no
write authority. Both tools return a request receipt; the worker records the
request with its owner, execution, command lease, generation, and current User
prompt. It processes the request after Koed captures the turn. A paused or
failed capture leaves the request pending. A new command cannot adopt it.

Koed uses a citation alias the User actually names, a displayed citation
number in the latest cited answer, or the latest citation actually written in
an earlier assistant message of the same local Conversation. The model's
requested alias cannot redirect an unqualified User request. Ambiguous or
missing references ask the User to identify the memory. “Do not forget” is
not a forget request.

Koed checks the citation's backend, source namespace, owner principal, and
current Personal Memory access. For an owned Curated Memory Assertion, Forget
uses the existing suppression operation. The result is stored durably and the
Conversation shows Undo for seven days. Undo uses a trusted Desktop action ID;
the stored suppression token never enters the renderer request. Chat-derived
sources offer the existing confirmed “Forget this chat” flow. A Team citation
asks the User to contact its owner, without mutating a teammate's Memory.
The chat offer names a target only when source links resolve to one active,
owner-held chat. If the source spans chats, Koed asks which chat the User means.

Correction creates a source-linked `supersede` proposal for the Curated Memory
review pipeline. It never overwrites an assertion. Koed requires the exact
current User statement, captured as one unambiguous Conversation item tied to
that command's `clientUserMessageId`. When that source cannot be verified, the
request ends as unavailable and creates no proposal. Codex uses its canonical
User-message marker. For Pi and Claude, Koed binds the command ID to exactly
one newly captured provider User record between verified source-journal cursors.
It checks the full provider prompt and source generation, and rejects missing,
repeated, internal, or subagent records. No source bytes change. If source
capture is paused or this exact binding is unavailable, Koed creates no proposal;
the request stays pending until capture resumes or reports that source evidence
is unavailable.

Requests and results are owner-scoped encrypted envelopes bound to the exact
Session, execution, command, tool call, and action. The hosted encryption rewrap
command rotates both envelope columns and honors its source-column filter.
The Desktop reads only bounded display results. It sends an action ID for Undo;
the server retrieves the exact receipt under the existing Curated Undo boundary.
Personal API Tokens and scoped device credentials cannot authorize that Undo.

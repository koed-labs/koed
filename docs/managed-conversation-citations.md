# Managed Conversation memory citations

Desktop-managed Codex, Claude Code, and Pi conversations request
`memory_answer` with `response_detail=with_citations`. The completed Koed tool
result includes stable receipt aliases. The assistant places `[m:alias]` after
the claim that the source supports. HQ renders known aliases as numbered memory
chips and lists the cited sources in a From memory row. Unknown aliases have no
source detail.

## Capture and storage

The managed worker observes completed Koed tool results from its provider
transport. It verifies the observed question and each citation against the
current source backend. A model-supplied question ID or alias is never capture
authority. The Personal authority receives the verified locator under the
active execution, generation, owner, and command lease. The final insert checks
the exact dispatching command and unexpired lease in the same transaction.

`managed_conversation_turn_citations` stores an immutable alias and qualified
source identity, with source detail envelope encrypted for the owning User.
The authenticated envelope binds the owner, execution, logical Session,
generation, provider turn, tool call, backend, question, ordinal, alias, source
type, source ID, visibility, and source owner namespace and principal. A source
generation is attached after turn capture and is scoped to that provider turn.
Key rotation rewraps these embedded envelopes through the hosted encryption
rewrap workflow. Session Forget and Delete hide aliases immediately; an Undo or
restore reopens the same encrypted aliases while the existing retention window
allows it.

When completed transient runtime output is removed, HQ reads the durable alias
map. Captured Claude and Pi history can omit the worker's provider turn ID; a
bounded, batched alias lookup under the owner and execution resolves model-visible tags
without treating the tags as an authorization claim. A known provider turn ID
remains an additional filter when available. A completed command triggers one
fresh lookup if a reply appeared before its citation map became readable.

## Opening a source

Every detail open uses the stored locator and requests current source authority.
Personal sources are read from the actual source deployment and must still be
available to the owner. The list shows current Personal source titles only
after the same source check, so a forgotten source leaves no cached title in
the From memory row. An owned message source offers Open message only when a
fresh owner-scoped graph event resolves to the current Project and chat. The
click rechecks the citation before navigation; Team sources never offer a
private chat link. A Team citation uses the enrolled Local Edge Team
credential and a fixed relay to its authoritative Team backend. The backend
rechecks current Workspace and source grants. A revoked or unavailable Team
source keeps its alias but reveals no retained Team text or private chat link.
The renderer clears detail on owner, store, API, or chat identity changes and
rejects late responses from an earlier selection.

If current source verification or citation storage fails during capture, Koed logs a source-free warning and lets the provider turn complete. Unrecorded aliases have no detail and are dropped by the renderer. Capture still waits for a successful durable insert before completing its callback; it never turns an unverifiable source into an authorized citation.

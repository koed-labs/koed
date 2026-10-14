# Personal conversations group independent Agent executions

Accepted 2026-10-07. The User requires multiple Agents from the same or different
AI Clients in one conversation, with sequential execution and bounded context
transfer for the first version.

## Decision

Separate the stable Personal conversation identity from its native provider
executions. Give each Agent a separate resumable provider session, even when two
Agents use the same provider. Keep one title, Project association and visible
conversation timeline. Existing executions remain valid native sources and may
be attached without rewriting their transcripts.

Persist one human request and its ordered recipient deliveries. Coordinate
execution durably, against the same verified conversation checkout. Keep
provider-native command identities, lease fencing, authentication, permissions
and uncertain-delivery recovery intact. Public context supplied between Agents
is bounded and explicitly distinguished from native source provenance.

## Alternatives and consequences

Replacing an execution's fixed provider would break resume and source identity
guarantees. Keeping all Agents inside one native session would also mix their
identities and would not support different providers. Creating an unrelated
visible chat for every Agent would lose the product's shared conversation.

The chosen design adds a conversation-level ordering and recovery boundary,
alongside the existing execution boundary. It requires durable recipient and
execution links, per-participant settings, combined owner-authorized history,
and navigation that hides implementation sessions. It avoids importing one
provider's source records into another provider's native transcript.

Sequential execution avoids simultaneous writes by participants in one
conversation and lets later Agents use earlier results. Parallel editing and
automatic delegation are separate future decisions. Bounded incremental public
context limits repeated prompt input; omitted material must remain explicit.
Any future history synthesis continues to run through the AI Client under
ADR-0001, rather than introducing backend LLM calls.

The implementation and acceptance contract are described in
[Multiple Agents in one Personal conversation](../studio-multi-agent-conversations.md).

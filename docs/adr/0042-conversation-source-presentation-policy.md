# ADR 0042: Conversation Source Presentation Is Independent From Memory Projection

- Status: Accepted
- Date: 2026-08-21

Related decisions:

- [0014 Hosted Personal Replication Uses The Conversation Source Journal](./0014-hosted-personal-source-replication.md)
- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0025 Team Conversation Source Access](./0025-team-conversation-source-access.md)
- [0030 Shared Durable Realtime Client Runtime](./0030-shared-durable-realtime-client-runtime.md)

## Context

The Conversation Source Journal retains complete, ordered AI-client source
records. Memory Projection intentionally selects only records that should
become semantic Memory Events, embeddings, or LCM sources. An owned
Conversation timeline has a different purpose: it must faithfully and promptly
show the User's interaction with the AI Client, including operational items
such as approvals and structured input that are not Memory.

Using Memory Events as the owned Conversation read model delays rendering until
turn sealing and Projection, hides useful non-semantic activity, and couples UI
behavior to embedding policy. Conversely, displaying every retained source
record would expose encrypted reasoning, system context, telemetry, and unknown
provider records that have no safe product presentation.

## Decision

Koed keeps three independent boundaries:

1. **Conversation Source custody** retains every complete source record,
   byte-for-byte and in source order, in the owner-scoped Conversation Source
   Journal. It is not configurable by transcript type. Live provider events may
   exist provisionally before reconciliation, but the Journal remains the
   durable source of truth.
2. **Conversation Item Presentation** decides whether and how an owned source
   or managed-runtime item appears. Its modes are `expanded`, `collapsed`,
   `status`, and `hidden`, paired with a bounded renderer kind.
3. **Memory Projection** independently decides whether a canonical source item
   creates semantic Memory, contributes to embeddings, or enters LCM.

Presentation and Memory Projection use separate DB-backed positive allowlists,
separate revisions, and separate tests. A change to one must not rebuild or
alter the other. Memory Projection policy contains no Conversation-rendering
fields and is not authority for the owned Conversation timeline.

Presentation rules are keyed by source kind, source-adapter version, and
normalized item type. Managed runtime items use their own source kind and
adapter version but pass through the same presentation decision contract. A
rule selects both a presentation mode and a renderer kind; data cannot choose
an arbitrary renderer.

Unknown source types, raw or encrypted reasoning, system/developer context, and
unclassified sensitive records default to `hidden`. User and AI Client
messages render expanded. Tool calls, tool results, and safe reasoning
summaries render collapsed by default. Approval requests, approval outcomes,
structured User input, and bounded lifecycle state render as operational
status or interaction UI while remaining excluded from semantic Memory.

An owned Conversation combines:

- optimistic local User messages;
- provisional provider/runtime events with stable provider identities; and
- presentation items replayed from canonical source.

Provisional items reconcile with canonical source identity instead of creating
a second timeline entry. Memory Events and LCM Summaries never drive rendering
of an owned Conversation. Realtime change references retain their projection
source so the owned timeline refreshes presentation records without inserting
the corresponding semantic Memory Event as a duplicate display item.

Exact Team Conversation Source Access remains separately authorized. It applies
the source grant, sanitization, and audience policy before any source item is
presented. Owner presentation does not grant Team visibility. Semantic sharing
continues to use Memory Events, LCM leaves, or LCM rollups and is unaffected by
this decision.

## Consequences

- Owned Conversations can render immediately without waiting for Projection,
  embeddings, or turn sealing.
- Approvals and other operational activity can remain visible without becoming
  semantic Memory.
- Complete source fidelity is retained even for records hidden from every UI.
- New provider item types fail closed until explicitly classified.
- Rich renderers can be added without changing recall behavior.
- Presentation-policy changes invalidate only the presentation read model.

## Non-Goals

- Making encrypted provider reasoning readable.
- Treating source access as a semantic sharing level.
- Allowing provider payloads or database configuration to load arbitrary UI
  components.
- Letting a Team viewer control the owner's managed Conversation.

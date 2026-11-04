# Capture and Recall Without Managed Conversation Execution

Status: Accepted.

Related decisions:

- [0001 AI Client Synthesis Only](./0001-ai-client-synthesis-only.md)
- [0015 Managed Conversation Execution and Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0016 Exclusive Execution Handoff and Fork Lineage](./0016-exclusive-execution-handoff-and-fork-lineage.md)
- [0034 Conversation Presentation Lifecycle](./0034-conversation-presentation-lifecycle.md)
- [0066 Peer-Online Personal Device Sync and Group Governance](./0066-peer-online-personal-device-sync.md) (Proposed)

## Context

Users work with AI Clients outside Koed. They need their Conversations captured as Personal Memory, made available for inspection and organization, and recalled by an AI Client. Koed has also supported Managed Conversations, in which Koed starts or continues an AI Client interaction and manages its execution. That execution responsibility introduces lifecycle, handoff, and authority obligations beyond the capture and recall product boundary.

## Decision

For now, Koed does not create or continue Conversations, run their AI Client execution, or manage their execution lifecycle on the User's behalf. Users create and continue Conversations in their AI Clients. Koed ingests eligible activity under the User's Capture Policy and makes captured Memory available for inspection, organization, and Recall.

The Desktop app and CLI may display and organize captured Conversations, including grouping them into Projects. Presentation and organization do not grant authority to submit prompts, resume a Conversation, or control an AI Client execution. Koed's MCP Server provides Recall and evidence to an authorized AI Client; Capture Hooks provide capture signals, not an alternative Recall interface. An AI Client may also submit a source-linked Curated Memory proposal for asynchronous review when that MCP capability is available; proposing Memory is not Conversation execution or immediate creation of a Memory Event. Local capture, historical import under applicable consent rules, Projection, deletion, and other Memory operations remain distinct from managed Conversation execution.

This decision removes Koed-managed execution handoff and fork workflows from the current product scope. It does not prohibit an AI Client from creating or continuing its own Conversation, or an explicitly authorized source export where separately supported. It does not itself define device-sync authority, data migration, or how existing execution state is retired.

## Relationship to Earlier Decisions

This decision supersedes the Managed Conversation execution requirements in ADR 0015 and the Koed-managed continuation, execution handoff, and fork requirements in ADR 0016. Those ADRs remain historical records, not authorization to add or retain these workflows as current product capabilities. Independent decisions concerning presentation, capture, source provenance, Memory, access control, or transport are not automatically superseded.

Managed Conversation execution-specific requirements in dependent decisions, including ADRs 0017, 0021, 0029, 0035–0039, 0048, 0054, and 0055, are also superseded to the extent they require Koed to create, continue, or execute a Conversation. Their independent security, source provenance, Memory, realtime, and access requirements are not superseded by this decision. In particular, ADRs 0052 and 0053 continue to govern realtime outside managed execution, and ADRs 0014, 0045, and 0047 continue to govern source replication, checkpoints, and source access. The dependent decisions and documentation require a detailed inventory and scoped updates. This decision does not settle whether standalone terminal, file, preview, or source-control tools unrelated to managed Conversations are in scope. In particular, a read-only replica boundary must not be inferred solely from the removal of managed execution: existing V1 compatibility, native source-generation transitions, imports, and persisted state require their own design and validation.

## Consequences and Follow-up

- Existing code and documentation may still implement or describe Managed Conversations. This decision does not claim that routes, background work, UI, stored data, or deployment behavior have already changed.
- Plan and implement retirement separately, including treatment of existing Conversations, retained Memory, in-flight or persisted executions and handoffs, and compatibility. Do not discard User data merely to enact this decision.
- Review execution-dependent ADRs and implementation without removing independent capture, organization, source provenance, Recall, or access-control functionality.
- ADR 0066 proposes a separate peer-online profile. It depends on this product boundary but remains Proposed; accepted PDS V1 decisions and behavior continue until explicitly changed.

## Alternatives

**Continue Koed-managed Conversation execution:** retains integrated execution and handoff, but preserves the operational and authority responsibilities outside the current capture and recall scope.

**Remove Conversation organization along with execution:** would also remove useful inspection and Project grouping of captured Memory; organization does not require Koed to own execution.

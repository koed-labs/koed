# ADR 0030: Shared Durable Realtime Client Runtime

Status: Accepted.

Related decisions:

- [0013 Team Collaboration Authority](./0013-team-collaboration-authority.md)
- [0014 Hosted Personal Source Replication](./0014-hosted-personal-source-replication.md)
- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0023 Team Member Presence](./0023-team-member-presence.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)
- [0040 Portable Client State And Credential Custody](./0040-portable-client-state-and-credential-custody.md)

## Context

Koed has durable realtime surfaces for Personal and Team collaboration,
Conversation Source replication, managed Conversation execution, and Presence.
The current wire transport is authenticated HTTP plus Server-Sent Events (SSE),
but connection lifecycle policy has grown inside individual consumers.

Reconnect ownership cannot be split between renderer components, Electron main,
and domain clients. Multiple owners create duplicate streams, conflicting retry
timers, stale event application, and inconsistent offline state. At the same
time, transport code must not absorb authorization, cursor, acknowledgement, or
domain-schema authority merely to make it reusable.

Koed also needs a path to one authenticated realtime session per backend for
interactive commands and events without rewriting every product surface at
once. The planned primary path is HTTP/3 plus WebTransport, with WebSocket and
SSE compatibility fallback where deployment capability requires it. Bulk
transcript and artifact transfer remains better suited to bounded HTTP
requests, and future media transport has different requirements again.

## Decision

Koed uses one shared, transport-neutral durable realtime client runtime.

The runtime owns:

- one connection lifecycle for one caller-owned subscription;
- the active client binding identity after a domain client has selected and
  authorized an endpoint;
- deterministic transport selection from the endpoint's offered transports and
  the client's supported adapters;
- subscription deduplication, replacement, cancellation, and stale-generation
  cleanup;
- generation-bound, bounded client view caches and coordinated cache fills;
- initial connecting, live, reconnecting, and unavailable states;
- bounded retry windows, exponential backoff, jitter supplied by policy, and
  unavailable cooldown;
- cancellation and stale-runtime suppression; and
- transport attempt orchestration.

Transport adapters own framing and connection mechanics. The first adapter is a
bounded SSE parser. It accepts streamed bytes, enforces a per-frame byte limit,
handles SSE comments and multi-line data, and emits transport frames. It does
not interpret Koed domain payloads.

Domain clients continue to own:

- authentication and credential refresh;
- endpoint discovery, authorization, and validation before binding it to the
  runtime;
- subscription creation, durable cursors, replay, and acknowledgement;
- authorization and revocation handling;
- schema validation and resource binding;
- protected-state clearing and authoritative resnapshot rules; and
- mapping runtime lifecycle states into domain-safe UI events.

The Desktop collaboration broker and renderer collaboration client are the
first migrated consumers. The broker delegates retry, cooldown, cancellation,
transport selection, and SSE framing to the shared runtime. The renderer uses a
browser-safe collaboration runtime for backend/transport binding generations,
subscription ownership, and bounded selection-view caching. Both retain their
existing fail-closed Team and Personal collaboration rules. Their private retry,
SSE parser, subscription-coordination, and view-cache implementations are
removed.

The runtime is published from a browser-safe `@koed/shared/durable-realtime`
entry point. Browser-safe collaboration state is published from
`@koed/shared/collaboration-client-runtime`. Future WebTransport and WebSocket
adapters must implement the same lifecycle boundary and the allocation rules in
ADR 0031. Adopting either does not change durable server authority: events
remain replayable, ordered, acknowledged, and reauthorized. HTTPS remains the
bulk-transfer path. Future audio or video uses a media-specific transport such
as WebRTC rather than the durable application-event channel.

Portable clients share the authority-bound cache, protected draft, durable
outbox, notification-intent, and environment-selection rules in ADR 0040.
Transport lifecycle reuse does not permit credentials or protected state to
move into browser storage.

## Consequences

- Reconnect behavior has one tested owner for the migrated flow.
- Backend or principal replacement advances one client generation, preventing
  stale subscription attempts or cache fills from crossing an authority
  boundary.
- Existing SSE behavior and authorization boundaries remain unchanged.
- Future Desktop, web, and mobile clients can share lifecycle semantics without
  importing Electron or Node process code.
- Additional realtime consumers can migrate incrementally instead of requiring
  a flag-day protocol replacement.
- The shared runtime cannot grant access, advance a durable cursor, acknowledge
  delivery, or materialize protected data.

## Non-Goals

- Replacing SSE with WebTransport or WebSocket in this change.
- Moving collaboration authorization or durable replay into a generic runtime.
- Sending transcript or artifact bodies over the realtime event channel.
- Adding audio or video transport.

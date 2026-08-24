# ADR 0031: Realtime Transport Allocation And Negotiation

Status: Accepted.

Related decisions:

- [0012 Symmetric Replicated Personal Memory](./0012-symmetric-replicated-personal-memory.md)
- [0013 Team Collaboration Authority](./0013-team-collaboration-authority.md)
- [0014 Hosted Personal Source Replication](./0014-hosted-personal-source-replication.md)
- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0030 Shared Durable Realtime Client Runtime](./0030-shared-durable-realtime-client-runtime.md)

## Context

Koed currently uses bounded HTTPS requests and cursor-based Server-Sent Events
(SSE). That path has durable replay, explicit acknowledgement, resnapshot,
authorization rechecks, and bounded reconnect behavior. Those semantics are the
authority; SSE is only their first wire transport.

Coding, collaboration, Personal Device Sync, future web/mobile clients, and
interactive execution need lower-latency bidirectional traffic and independent
streams. Moving every payload onto one WebSocket would simplify the connection
count but would couple bulk transfer, durable events, disposable UI hints,
terminal traffic, and future media to one framing and backpressure policy.

Transport negotiation also crosses an authentication boundary. A successful
connection must never grant Team, Memory, execution, terminal, file, or source
access by itself. Long-lived browser sessions and device credentials must not
appear in transport URLs.

## Decision

Koed uses a capability-negotiated transport portfolio behind the shared durable
realtime client runtime. HTTP/3 plus WebTransport is the preferred application
realtime path when both client and deployment prove support. WebSocket and SSE
remain compatibility adapters. HTTPS remains the request, recovery, and bulk
transfer path. WebRTC is reserved for realtime media.

### Allocation Matrix

| Traffic class                                                                                                    | Primary path                                                                          | Compatibility path                                                                                     | Required properties                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Capability discovery, sign-in, enrollment, mutations, finite queries, authoritative snapshots, and recovery      | Bounded HTTPS, using HTTP/3 where available                                           | HTTP/2 or HTTP/1.1 over TLS                                                                            | Explicit request authorization, size and time limits, idempotency where applicable, redacted errors                       |
| Conversation source segments, Personal Device Sync packages, attachments, exports, and other bulk objects        | Bounded HTTPS upload/download with content identity and resumable ranges where needed | The same HTTPS contract over an older HTTP version                                                     | Integrity verification, resumability, independent backpressure, no realtime-session dependency                            |
| Durable collaboration, Conversation, Presence, execution, and sync notifications                                 | Reliable ordered WebTransport streams multiplexed within one backend session          | WebSocket, then cursor-based SSE plus bounded acknowledgement requests                                 | Snapshot, opaque replay cursor, idempotent delivery, explicit acknowledgement, reauthorization, bounded frames and queues |
| Interactive prompt lifecycle, approvals, user input, terminal bytes, and other bidirectional application traffic | Dedicated reliable WebTransport streams                                               | WebSocket channels with explicit framing and flow control; finite HTTPS commands where latency permits | Operation authorization, fencing or idempotency, independent cancellation and backpressure                                |
| Typing, pointer, transient progress, and other disposable hints                                                  | WebTransport datagrams when available                                                 | Coalesced reliable events or omission                                                                  | Loss-tolerant, bounded, never canonical, never an authority or cursor input                                               |
| Audio, video, and screen sharing                                                                                 | WebRTC with an explicitly selected SFU/STUN/TURN topology                             | Product-specific media fallback                                                                        | Separate signaling, consent, device lifecycle, E2EE policy, recording and retention decisions                             |

PostgreSQL `LISTEN`/`NOTIFY`, local IPC, and process stdio remain internal wakeup
or process transports. They are not remote client protocols and do not replace
durable database state.

### Session And Subscription Model

A client runtime owns at most one active application realtime session for one
resolved backend binding. Logical Personal, Team, Conversation, execution, and
other subscriptions are multiplexed through that session. Each logical
subscription retains its own authorization, snapshot, replay cursor, ordering,
acknowledgement, retention, and resnapshot semantics.

Ordering is guaranteed only inside the domain scope that defines it. Koed does
not invent a global order across unrelated Teams, Conversations, or terminal
streams. Independent reliable streams prevent a large or stalled traffic class
from blocking unrelated interactive work.

A transport replacement advances the client runtime generation. Cached queries
revalidate against the replacement generation, subscriptions resume from their
durable cursors, and stale operations cannot publish into the new binding.
Transport generation is never substituted for a domain revision, execution
fence, or durable cursor.

### Negotiation

The authenticated capability contract advertises transport identifiers,
protocol versions, endpoint roles, frame limits, and required ticket behavior.
The client intersects that ordered offer with adapters it actually supports.
Within equivalent deployment policy the preference is:

1. WebTransport;
2. WebSocket;
3. SSE with bounded HTTPS commands and acknowledgements.

The selected adapter remains sticky until its session fails, its capability
revision expires, or the backend binding changes. The shared client runtime is
the only retry and replacement owner.

Fallback is permitted for absent capability, unsupported protocol, network path
failure, or a deployment that explicitly disables a transport. Authentication,
authorization, revocation, schema, resource-binding, and protocol-integrity
failures stop closed. They must not be disguised as a transport problem and
retried through a weaker adapter.

Clients never infer transport support from hostname, port, browser brand, or
deployment profile. A deployment must prove the advertised path through its
actual TLS terminator, reverse proxy, tunnel, idle timeout, and load balancer.

Capability schema 8 expresses this as an ordered `offers` collection. The
currently instantiated SSE adapter is advertised as available. A WebTransport
or WebSocket offer is emitted only when that adapter is actually constructed by
the server runtime; configuration or deployment profile alone cannot make an
offer appear. The contract also publishes the ticket endpoint, version,
30-second lifetime, single-use rule, and admission-only authority.

The concrete HTTP/3 runtime uses one client-created control stream to admit the
WebTransport session. Its first bounded `session.admit` frame carries the
single-use ticket, connection identity, client-instance binding, client kind,
and native device identity where applicable. The control stream remains open
for the session lifetime. Its closure, an admission timeout, revocation, or
server shutdown aborts every owned application stream.

After admission, each logical durable subscription uses an independent
client-created bidirectional reliable stream. Its first bounded
`durable_events.attach` frame carries only the subscription binding, opaque
replay cursor, and Personal or Team scope; transport credentials are never
repeated across application streams. The server checks that the admitted
operation-family set includes the requested scope, revalidates the active
session or device credential, and writes bounded newline-delimited frames with
the same `event`, `data`, and optional cursor `id` semantics as the SSE adapter.
Ready, domain event, control, revocation, and heartbeat payloads are therefore
shared with SSE rather than translated into a second domain protocol.

Interactive streams use a distinct strict attach schema and handler registry.
The runtime defines the bounded `managed_execution` channel boundary without
attaching a production execution handler; the terminal and execution decisions
authorize and implement those handlers separately. Unknown channels, missing
operation families, streams opened before admission, malformed attach frames,
and excess concurrent streams fail closed.

Acknowledgements remain bounded authenticated HTTPS requests. Merely writing
an event to either SSE or WebTransport advances no durable acknowledged cursor;
disconnecting or revoking a stream causes unacknowledged events to replay from
the retained cursor. The offer is not advertised until the concrete HTTP/3
runtime owns the corresponding WebTransport sessions and reliable streams.

### Transport Tickets

Opening WebTransport or WebSocket uses a single-use, short-lived transport
ticket issued after normal session or device authentication. The ticket binds:

- principal and device identity;
- backend and client-instance identity;
- intended transport and protocol version;
- allowed session operation families;
- origin or native-client binding where applicable;
- issue time, expiry, nonce, and single-use state.

The ticket authorizes only admission to the transport session. Every
subscription and operation is authorized again against current server state.
Tickets are not API Tokens, session cookies, upstream device credentials,
execution fences, or Team grants. They are never reusable and are redacted from
logs, diagnostics, analytics, errors, and browser history. If a platform forces
the ticket into a URL, only this one-time admission ticket may be used there;
long-lived credentials remain forbidden.

Koed persists only a peppered digest of the random ticket secret. The durable
record binds the User to exactly one active browser session or device
credential, the verified deployment identity, client instance, client kind,
transport, protocol, operation-family set, and browser Origin or native device
identity. Browser issuance is same-origin CSRF protected. Personal API Tokens
cannot issue tickets. Admission consumes the record atomically and verifies
that the source session or device credential, User, expiry, and device
operation-family scope are still active. Replay, binding drift, revocation,
expiry, and scope reduction all produce the same content-free admission
failure.

### HTTP/3 Runtime Provider

The API owns an optional sibling UDP/TLS HTTP/3 listener. It is disabled by
default and uses the exact-versioned, pure-JavaScript `quico` provider through a
narrow Koed adapter. The provider owns QUIC, HTTP/3, and WebTransport socket
mechanics only. Koed retains framing, admission, authorization, durable state,
replay, limits, and metrics so the provider can be replaced without changing
domain semantics.

Enabling the listener requires an explicit canonical public HTTPS endpoint,
bind host and UDP port, and readable TLS certificate and private-key paths. A
configured listener that cannot load its provider, TLS material, or socket
fails startup clearly. An unconfigured listener leaves SSE available and emits
no WebTransport offer. The offer is registered only after the UDP listener has
successfully started. Operators must expose the UDP port directly or through a
proven HTTP/3-capable edge; an HTTP-only reverse proxy or ordinary Cloudflare
Tunnel does not prove this path.

`pnpm --filter @koed/api smoke:webtransport` creates an ephemeral certificate,
starts the real provider, completes a QUIC/HTTP/3 handshake, admits one native
session, opens a second durable stream, verifies its ready frame, and removes
its temporary TLS files.

### Datagram Policy

Datagrams are never canonical, durable, replayable, acknowledged, or accepted
as authority, cursor, revision, execution fence, or mutation input. The runtime
caps them at 1,200 bytes and validates a small disposable-hint envelope only
after session admission. Until a domain handler with its own resource
authorization is registered, every valid datagram is deliberately dropped.
Unauthenticated, oversized, malformed, and unsupported datagrams have separate
aggregate counters and never reach domain code.

### Backpressure And Failure

Every adapter enforces the same declared frame, queue, replay, heartbeat, and
idle limits. A client that cannot keep up receives a bounded resnapshot control
and loses no canonical state. Disposable datagrams may be dropped or coalesced
without recovery.

An involuntary transport close keeps durable subscriptions and cached
projections subject to their domain cache policy while the shared runtime
reconnects. Explicit sign-out, backend removal, principal replacement,
revocation, or unsupported protocol clears protected state and owned transport
credentials according to the domain decision.

## Consequences

- Koed can improve interactive latency without replacing its durable authority.
- Web, Desktop, mobile, and remote-runner clients can share one negotiation and
  lifecycle model.
- Bulk source replication does not block chat, execution, or terminal traffic.
- SSE remains a supported compatibility path rather than a second product
  architecture.
- WebTransport deployment requires end-to-end HTTP/3, ticket admission,
  observability, proxy compatibility, and fallback proof before becoming the
  default.
- The durable event codec and authorization engine are shared across SSE and
  WebTransport, while the HTTP/3 session implementation remains independently
  replaceable.

## Non-Goals

- Selecting an edge provider, SFU, or TURN vendor.
- Defining peer discovery or Personal Device Sync conflict semantics.
- Defining terminal command authority, file authority, or media recording
  policy.
- Replacing bounded HTTPS bulk transfer with realtime frames.
- Treating connection liveness as User Presence or execution ownership.

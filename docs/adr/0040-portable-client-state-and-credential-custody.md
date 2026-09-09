# ADR 0040: Portable Client State And Credential Custody

Status: Accepted.

Related decisions:

- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0012 Personal Device Sync Protocol](./0012-personal-device-sync-protocol.md)
- [0030 Shared Durable Realtime Client Runtime](./0030-shared-durable-realtime-client-runtime.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)

## Context

Desktop, broader web clients, and future native mobile clients need the same
backend selection, cache invalidation, offline intent, draft, and notification
semantics. Reimplementing those rules in each UI would create different replay
behavior and make it easy for credentials or protected content to enter browser
storage, logs, notification payloads, or a cache belonging to another backend.

The shared durable realtime runtime deliberately does not own authentication or
domain authorization. A portable client-state layer must preserve that boundary
while remaining usable outside Electron and Node.

## Decision

Koed publishes a browser-safe portable client foundation from
`@koed/shared/client-foundation`.

The foundation provides:

- strict, credential-free backend profiles selected by stable backend ID;
- an authority binding composed of backend, principal, credential generation,
  and authorization generation;
- bounded, generation-aware view caches;
- secure-store-backed drafts and durable mutation intents;
- explicit queued, dispatching, and indeterminate outbox states; and
- content-free notification intents.

The caller provides the secure-storage implementation. Desktop uses the
operating-system credential store through Electron main. A native mobile client
uses the platform keychain or keystore through its native bridge. A browser
uses an authenticated server session and must not place bearer credentials,
drafts, or protected outbox payloads in Web Storage. If a browser cannot provide
approved protected storage for an offline feature, that feature is unavailable
rather than downgraded to plaintext storage.

Changing backend, principal, credential generation, or authorization generation
creates a different storage and cache authority. State from the previous
authority is never returned under the new binding. Revocation advances the
generation and invalidates protected cached state.

An outbox item is persisted before dispatch. Only operations with a stable
idempotency key and request digest may enter it. A transport failure after
dispatch produces an indeterminate outcome; the client does not silently replay
the operation until the domain service proves the prior outcome absent. This
foundation does not invent conflict resolution or grant authority to execute a
queued item.

Notification payloads contain only a backend, principal, opaque resource
identity, event identity, kind, timestamp, and badge delta. Message, Memory,
source, prompt, and artifact content is fetched after authentication.

Desktop is the first product client using the shared realtime and
generation-bound cache model. Product-specific clients may adopt the portable
draft and outbox stores incrementally, but duplicate credential stores, retry
engines, and authority-independent caches are not retained as compatibility
paths.

## Consequences

- Mobile and broader web clients can share security and replay semantics without
  importing Electron APIs.
- Protected state remains under platform-specific secure custody.
- Offline behavior is explicit and bounded rather than an implicit replay of
  arbitrary requests.
- Backend switching cannot expose cached data or drafts from another authority.
- Push providers receive no protected Koed content.

## Non-Goals

- A mobile UI or browser product in this change.
- Background execution that bypasses operating-system policy.
- Offline mutation support for operations without an idempotent server contract.
- Moving authentication, authorization, durable cursors, or domain conflict
  resolution into the portable client foundation.

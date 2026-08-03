# Conversation Continuation Uses Exclusive Handoff And Explicit Fork Lineage

Status: Accepted.

Related decisions:

- [0014 Hosted Personal Replication Uses The Conversation Source Journal](./0014-hosted-personal-source-replication.md)
- [0015 Managed Conversation Execution Uses A Fenced Runtime And Durable Realtime Stream](./0015-managed-conversation-execution-and-realtime.md)
- [0017 Development Portability Uses Verified Workspace Snapshots](./0017-verified-development-workspace-snapshots.md)

## Context

Replicating exact provider Conversation source makes a Conversation viewable and
reprocessable on another device. It does not prove that the provider can resume
the same Conversation there, that the required repository state exists, or
that the original device has stopped writing.

Two devices appending independently to one provider Conversation identity would
corrupt chronology, source closure, prompt idempotency, and execution
authority. Conversely, always creating a new Conversation on another device
would lose continuity and hide an important fork.

Provider rollback, conversation fork, workspace rollback, and execution handoff
are different operations. Koed must represent them explicitly.

## Decision

At most one runner owns the writable execution lease for a managed Conversation
generation. Moving the same Conversation to another runner uses a transactional
handoff protocol with fencing. Independent continuation creates an explicit
fork with a new Captured Session and lineage.

### Execution Lease

The durable execution lease records:

- Captured Session and logical source identity;
- execution generation;
- opaque fencing token hash;
- owning runner deployment/device;
- acquired, renewed, expiry, quiescing, released, and transferred timestamps;
- provider adapter/version and provider Conversation identity;
- last accepted prompt sequence;
- last acknowledged durable source boundary;
- target handoff intent where present.

Lease acquisition and transfer use compare-and-swap on the current generation.
Every provider command, source append acknowledgement, and terminal execution
write carries the expected generation and fencing proof. A stale owner cannot
extend the lease, accept prompts, finalize a turn, or advance the source after
transfer.

The selected hosted Personal backend is lease authority when configured; the
local `koed-server` database is authority in local-only mode. A runner stores
the highest generation it has observed durably and fails closed when authority
freshness is uncertain.

Lease expiry alone does not prove the old provider process stopped. Automatic
takeover after expiry is prohibited. Recovery requires proof that the previous
runner is stopped or isolated, or an explicit forced-recovery action that
creates a fork rather than claiming same-Conversation continuation.

Direct same-Conversation handoff requires a linearizable authority available to
both runners or a countersigned append-only Personal Device authority log. A
transfer occupies one compare-and-swap log position binding prior log head,
source and execution generation, final closure, target device, target runner,
next generation, nonce, expiry, and certificate digest. The prior owner and
authority countersign it and commit an irreversible old-owner tombstone.
Conflicting certificates at one position quarantine the Conversation. Devices
persist the highest authority sequence/log head outside ordinary replica
rollback and reject stale or replayed transfers.

A self-signed transfer certificate or local tombstone is insufficient. Two
peers without a shared authority may exchange source and create a fork, but
cannot claim exclusive same-Conversation transfer.

### Handoff State Machine

Each handoff has a caller operation id, immutable source/workspace manifest
digest, current state version, restoration-attempt lease, and recovery owner.
Every state transition compare-and-swaps both operation id and state version.
The handoff state machine is:

```text
running
  -> quiesce_requested
  -> provider_stopped
  -> source_sealed
  -> workspace_prepared
  -> target_verified
  -> lease_transferred
  -> restoring
  -> identity_verified
  -> running
```

Failure before `lease_transferred` leaves the source owner authoritative and
allows an explicit resume there. Failure after transfer leaves the old owner
fenced and the target in recoverable `restoring` or `failed` state. It never
reactivates both writers.

The source runner must:

1. stop accepting new prompt commands;
2. allow the current provider operation to reach a declared safe boundary or
   fail the handoff;
3. terminate the provider process group under adapter or sandbox control;
4. drain the provider transcript to a stable end-of-file after process exit;
5. reconcile typed lifecycle observations and every complete provider record;
6. checkpoint canonical ingestion and terminal command states;
7. seal and publish the final pre-transfer source segment;
8. produce a deterministic source-boundary manifest;
9. prepare or reference a verified development workspace snapshot;
10. attest the stopped generation to the coordinator.

Koed does not detach a possibly writable provider process. Commands still
`queued`, `claimed`, `dispatching`, or `indeterminate` at the boundary become
terminal or require explicit reconciliation under the old generation; they
never cross into the new generation.

The target must:

1. authenticate and authorize the same Personal User and target device;
2. verify source-replica readiness and exact source-boundary manifest;
3. verify provider adapter and artifact compatibility;
4. verify provider credentials are locally available without receiving them
   from the source package;
5. materialize and verify the required workspace snapshot;
6. prove no conflicting writable runtime exists on the target;
7. atomically acquire the next execution generation;
8. restore through the provider adapter;
9. require `thread/resume(expectedThreadId)` without a `thread/start` fallback;
10. verify the returned thread id and provider session-tree identity;
11. verify restored rollout metadata is anchored to the transferred closure
    digest and exact source range;
12. publish `identity_verified`, then writable readiness.

The old runner receives the transferred generation and remains fenced. Delayed
events from the old provider may be retained as fenced diagnostics but cannot
alter canonical Conversation or execution state.

Every source segment, provider observation, canonical mutation, terminal
command update, and realtime outbox event records the execution/source
generation. Lease transfer atomically commits the closed prior chain head,
allocates a new source generation and origin key to the target, and binds that
generation to the prior closure, exact range, and next execution generation.
The old origin signing key is never transferred. Old-generation bytes are
retained only as fenced diagnostics and cannot advance canonical or derived
state.

After provider restoration, the target drains the restored transcript through
the transferred closure and proves that the exact prefix matches. Source
journalling for the new generation starts at the first complete provider record
strictly after that prefix. A missing, changed, or duplicated boundary is a
restoration conflict and prevents `identity_verified`.

Failure before transfer returns recovery ownership to the source only through
an idempotent recovery transition. Failure after transfer leaves the old owner
fenced and gives the target's restoration-attempt lease a single recovery
owner. Retrying the operation replays its stored state; it never creates a
second restoration.

Source, workspace, provider, target, and authority readiness are refreshed at
each transition that depends on them. Evidence is bound to the operation,
generation, manifest, target, and expiry. Missing, stale, mismatched, or
regressed evidence blocks progress rather than inheriting an earlier `ready`
label. Runner restart resumes the persisted operation and its recovery owner;
it does not reconstruct transfer state from process memory.

### Provider Restoration

Each provider adapter maintains a compatibility declaration covering:

- provider binary/app-server version;
- provider source artifact format and version;
- thread/session restoration capability;
- required provider-home files and layout;
- supported operating-system and architecture combinations;
- whether continuation preserves provider-native Conversation identity;
- safe quiesce and stop behavior.

Koed materializes provider artifacts only into a fresh isolated provider home.
It does not merge arbitrary provider-home directories or transfer provider
credentials, login state, global settings, caches, or unrelated Conversations.

Restoration is successful only after the identity proof above reaches
`identity_verified`. The first subsequent prompt is an ordinary fenced command,
not part of the identity proof. An adapter that cannot prove identity may
support viewing or explicit forking, but not same-Conversation handoff.

### Explicit Fork

A fork is an idempotent operation with states:

```text
requested -> provider_created -> child_bound -> running | indeterminate
```

The operation persists its caller id, request digest, exact parent boundary,
and provider creation correlation before side effects. An ambiguous provider
creation result becomes `indeterminate` and is reconciled rather than retried.
A runner restart reconciles only forks assigned to that runner and generation.
It may bind a child proven by the persisted provider correlation, but it never
issues a second provider-create side effect merely because the first response
was lost.
A successful fork:

- creates a new Captured Session, logical source identity, provider
  Conversation identity, source journal, execution lease, and prompt sequence;
- records parent Captured Session, parent source generation, exact parent source
  boundary, workspace snapshot, actor, reason, and timestamp;
- preserves the parent source immutably;
- may start from the same verified workspace snapshot;
- never merges later by content similarity or matching Project metadata.

Lineage points to the exact immutable parent boundary used to create the child,
not to all later content in a parent Conversation that may continue evolving.

The UI presents continuation and fork as distinct actions. If exact
continuation cannot be proven, Koed offers an explicit fork with an honest
reason rather than silently substituting one.

Provider-native fork or rollback operations are mapped into the same lineage
model when their semantics are verified. A provider rollback changes provider
history selection; it does not revert files. A development workspace rollback
requires a separate workspace operation.

### Multi-Device And Offline Behavior

A remote Personal backend can coordinate handoff while one device is offline
only if the old runner was previously quiesced and the necessary source and
workspace artifacts are durably available. An abruptly lost device with an
unproven live provider process cannot be taken over as the same Conversation.
The User may recover by reconnecting the origin or by creating an explicit
fork from the last verified durable boundary.

Without a hosted coordinator, two reachable trusted devices may transfer exact
source and workspace state directly. They may perform same-Conversation
handoff only when a configured Personal Device authority log can countersign and
commit the transfer position and old-owner tombstone. Otherwise the receiving
device creates an explicit fork. Direct reachability does not weaken the
one-writer rule.

### Authorization And Audit

Only the owning Personal User may initiate Personal handoff or fork. A scoped
enrolled device may execute the server-owned operation after browser/session
authorization. Personal API Tokens, Capture Hooks, MCP tools, Team Membership,
Workspace Access, and Share Grants do not grant execution-transfer authority.

Audit records contain identities, generations, states, reason codes, hashes,
timestamps, and actors, but no prompt text, source content, repository content,
paths, credentials, keys, or raw provider artifacts.

## Consequences

- Same-Conversation continuation is honest and provider-verified.
- Split-brain provider execution fails closed.
- Abrupt device loss may require an explicit fork rather than unsafe takeover.
- Handoff latency includes source sealing, workspace verification, lease
  transfer, and provider restoration.
- Fork history becomes durable product lineage rather than an inferred UI
  relationship.

## Rejected Alternatives

- Last-write-wins execution ownership.
- Taking over automatically when a heartbeat expires.
- Copying a provider home while its process is still writing.
- Treating source replication as proof of executable continuation.
- Silently starting a new provider Conversation when restoration fails.
- Merging divergent histories by text or embedding similarity.
- Reusing Team sharing authority for execution control.

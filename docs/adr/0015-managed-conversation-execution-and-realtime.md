# Managed Conversation Execution Uses A Fenced Runtime And Durable Realtime Stream

Execution owner routing is defined in [Managed Conversation AI Client Routing](../managed-conversation-ai-client-routing.md). Every execution persists explicit AI Client instance identity; runtime lifecycle selection is fail-closed and provider-neutral.

Status: Accepted.

Related decisions:

- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](./0013-team-collaboration-authority.md)
- [0014 Hosted Personal Replication Uses The Conversation Source Journal](./0014-hosted-personal-source-replication.md)

## Context

Koed can ingest provider Conversations created outside Koed and can use Codex
app-server mode for local Koed-owned background work. To let a User begin and
continue an AI coding Conversation from Koed Desktop, Koed also needs to own the
interactive execution lifecycle.

The UI cannot safely spawn provider processes, hold provider credentials, write
provider transcript files, infer execution ownership, or treat a WebSocket
connection as durable state. A remote Koed backend cannot assume that a local
execution device is online or that it may run arbitrary commands on that
device.

Conversation source, canonical product state, realtime delivery, prompt
commands, and provider execution are related but distinct:

- the Conversation Source Journal is the durable provider-native source;
- canonical Conversation rows are the durable product read model;
- realtime events make committed state appear promptly;
- prompt commands request an execution owner to act;
- the provider adapter owns provider-specific process and session behavior.

## Decision

`koed-server` owns managed Conversation execution through a provider-adapter
interface. Desktop and Explorer are clients of `koed-server`; they never launch
or control Codex directly.

A managed execution has exactly one active execution owner and one current
fencing generation. Every mutating provider action requires the current
execution lease and generation. Stale owners and stale commands cannot append
source or report terminal state after ownership changes.

### Runtime Placement

An execution runner may be:

- the User's local `koed-server`, using provider credentials and a development
  workspace installed on that device; or
- a Koed-managed execution worker, using credentials and an isolated workspace
  explicitly provisioned for that hosted runtime.

The selected runner is recorded per execution. A remote Personal backend may
coordinate a local runner through an outbound authenticated command channel,
but it does not receive local provider or repository credentials.

### Project Binding And First Conversation Start

A local runner resolves a Project execution path from trusted local Project
metadata under `KOED_HOME`. Existing captured-memory metadata may be used only
as a fallback for a Project that is already known locally. Starting the first
managed Conversation in a newly discovered Project must not require fake
captured memory or a pre-existing Conversation.

Local filesystem paths never cross the remote authority boundary. A local edge
sends only the opaque Project id when requesting hosted coordination. The
hosted authority may accept that id from a scoped Personal Device credential
and persist a deferred execution, but the initial command remains blocked. The
selected local runner must persist its verified runtime binding and acknowledge
the matching execution generation before the authority releases that command.
An unknown local Project, missing path, stale generation, or failed readiness
acknowledgement fails closed.

### Provider Adapter

The provider adapter must expose explicit capabilities rather than relying on
filesystem guesses:

- create a provider Conversation;
- attach to or restore a compatible provider Conversation;
- submit one User prompt with a caller idempotency key;
- stream typed lifecycle events;
- report provider Conversation, turn, and item identities;
- seal and report the durable source boundary;
- declare provider and artifact format compatibility;
- confirm whether restoration preserved the same provider Conversation
  identity.

The current published AI Client contract keeps cancellation, approval
interaction, and provider-token streaming unsupported for Codex, Claude Code,
and Pi Managed Conversation UI. Desktop exposes no controls for these bounded
differences. Codex uses app-server mode behind this interface. Provider credentials,
provider home, app-server stdio, and raw protocol messages remain inside the
runner boundary.

### Isolated Runtime

Each managed execution records:

- Koed Captured Session and provider Conversation identity;
- owning Personal User;
- provider adapter and version;
- execution runner deployment/device;
- workspace snapshot or local Project binding;
- lifecycle state;
- current lease generation and opaque fencing token;
- current durable source boundary;
- last accepted prompt command sequence;
- compatibility and failure state.

Hosted execution runs in an isolated runtime home with bounded CPU, memory,
process, disk, and network policy appropriate to the deployment profile.
Provider and repository credentials are injected through the runtime's secret
boundary and never persisted in Conversation source, canonical rows, queues,
logs, diagnostics, or browser state.

### Prompt Command Contract

Prompt submission is a durable command, not a direct provider call from the UI.
The API:

1. authenticates the User or scoped enrolled device;
2. authorizes Personal ownership and current execution control;
3. validates current lifecycle, runner availability, lease generation, prompt
   bounds, and provider capability;
4. writes an idempotent command with a caller-generated command id;
5. returns the durable command identity and accepted sequence.

API idempotency and provider-side prompt acceptance are distinct. The command
row stores the canonical request digest, deterministic
`clientUserMessageId`, execution generation, command sequence, and provider
adapter before dispatch. The runner:

1. claims the command through a bounded lease;
2. rechecks execution fencing;
3. atomically moves the command to `dispatching`;
4. submits the persisted `clientUserMessageId`;
5. binds the resulting provider turn only after transcript reconciliation.

A repeated API request with the same command id and digest returns the existing
command. The same id with different content is rejected.

If provider acceptance is ambiguous, the runner stops automatic dispatch and
reconciles the provider transcript for the persisted `clientUserMessageId`. A
match binds the existing turn. Proven absence permits a controlled retry only
when the adapter can establish that no side effect occurred. Otherwise the
command becomes `indeterminate` and is never submitted automatically again.
Koed claims exactly-once provider submission only for an adapter with a tested
native deduplication contract; Codex prompt execution otherwise uses this
at-most-one-automatic-attempt and reconciliation rule.

The initial Personal contract permits only the owning User's authenticated
browser session or enrolled Personal device to submit prompts. Team members who
can view a shared Conversation remain read-only. Team execution delegation or
sponsorship requires a separate accepted authority decision.

### Lease Authority

The authoritative execution lease is stored by the selected hosted Personal
backend when one is configured, or by the local `koed-server` database in
local-only mode. A runner durably records the highest generation it has observed
and refuses commands when authority freshness, lease ownership, or generation
is uncertain.

Every command and acknowledgement binds backend identity, runner identity,
Captured Session, command id and digest, generation, command sequence, and
lease deadline. A network connection, process id, or heartbeat is never lease
authority. Same-Conversation transfer between two directly connected local
servers requires an external linearizable witness or the signed transfer
protocol in ADR 0016; without one Koed permits only an explicit fork.

### Local Execution Command Channel

When a hosted Personal backend coordinates a local execution runner, the local
`koed-server` establishes an outbound authenticated streaming subscription to
the selected backend using the existing snapshot, SSE stream, durable cursor,
and explicit acknowledgement pattern. The channel:

- uses a scoped revocable device credential;
- advertises redacted runner capabilities and current execution ids;
- receives only commands already authorized and persisted by the backend;
- rechecks local execution ownership and fencing before acting;
- carries acknowledgements, lifecycle state, and redacted failure codes;
- never carries reusable provider, repository, browser, API, KMS, or database
  credentials;
- reconnects with a durable command cursor and idempotently catches up;
- is not the source of truth for command or execution state.

No inbound port is required on the local device. If the local runner is offline,
commands remain visibly queued or unavailable according to policy; the backend
does not silently execute them elsewhere.

### Durable Realtime Delivery

Koed delivers Conversation updates through a cursor-based SSE stream with an
authenticated snapshot and explicit acknowledgement endpoint. Polling is not
part of the normal UI path.

Managed-execution events normatively inherit ADR 0013's transaction and outbox
contract: the product mutation and durable outbox row commit atomically,
PostgreSQL `LISTEN`/`NOTIFY` is only a wake-up signal, and the opaque
subscription cursor is the replay cursor. A per-Session sequence is a domain
revision and must not be substituted for the subscription cursor.

Every durable event references committed canonical/product state and carries:

- event protocol version;
- Captured Session id;
- monotonically ordered stream sequence within that Session;
- durable event kind and object id;
- source or product revision where applicable;
- source timestamp and committed timestamp;
- redacted readiness state.

The stream is a notification and ordered catch-up transport, not the only copy.
On connect or reconnect, a client supplies its last committed cursor.
The server sends retained durable events after that cursor or instructs the
client to reload a bounded canonical snapshot when retention has elapsed.
Duplicate delivery is expected and idempotent.

Incremental provider deltas may be sent as explicitly transient events for
typing/progress UX. They are never persisted as canonical messages or Memory
Events and never advance the durable cursor. Final provider items become
durable only after the source journal and canonical transaction commit.

### Conversation UI

Desktop exposes:

- Personal managed Conversations grouped through the existing Project and
  Captured Session hierarchy;
- complete canonical Conversation history with source/processing status;
- a prompt composer only when the current User has execution authority and the
  runtime reports a writable state;
- queued, accepted, dispatching, running, completed, failed, indeterminate,
  quiescing, transferred, and read-only states;
- live durable updates and transient progress without manual refresh;
- clear distinction between source durability and semantic processing.

The UI does not expose provider credentials, raw app-server protocol, local
paths from another device, fencing tokens, or internal queue controls.

### Failure And Recovery

Process crash, stream loss, duplicate command delivery, lost response, and
server restart recover from durable command, lease, journal, and stream
cursors. A runner that loses its execution lease stops accepting commands and
cannot publish fenced terminal state.

At startup and after authority reconnection, a runner reconciles only commands
assigned to its deployment/device and current execution generation. An
abandoned claimed command may return to the durable queue when no provider side
effect was possible. An abandoned dispatching prompt is reconciled through its
persisted `clientUserMessageId`; it completes from matching source evidence or
becomes `indeterminate`. It is never blindly resubmitted. Reconciliation,
command claims, and source-readiness changes use durable database state;
PostgreSQL notifications and remote SSE are wake signals, not authority or
polling loops.

Clean shutdown and authority reconfiguration first stop new claims, then await
in-flight command draining and startup recovery before closing provider
sessions and releasing every lease owned by that runner. Recovery must also
release an execution immediately if shutdown wins the acquisition race. A
replacement runner therefore does not wait for an avoidable stale lease from a
process that exited cleanly; crash recovery still relies on the bounded durable
lease expiry.

An unknown provider protocol, incompatible source artifact, missing workspace,
missing credentials, stale device credential, conflicting command, or
uncertain execution owner fails visibly and closed. Koed never starts a fresh
provider Conversation while presenting it as continuation of the old one.

## Consequences

- Koed can provide prompt entry and live Conversation viewing without putting
  provider control in renderer code.
- Local and hosted runners share one execution contract.
- Remote coordination of local execution remains outbound and revocable.
- Durable state survives UI, network, and process failure.
- The implementation requires execution leases, command persistence, a runner,
  realtime event retention, and provider compatibility checks.
- Handoff and fork behavior remain governed by the separate execution-transfer
  decision.

## Rejected Alternatives

- Letting Electron spawn or communicate with Codex directly.
- Treating WebSocket presence as execution ownership.
- Polling Conversation endpoints for normal live updates.
- Sending prompt text as an unaudited transient socket message.
- Allowing the remote backend to run local commands merely because a device is
  enrolled.
- Reusing Personal API Tokens as execution-channel credentials.
- Allowing Team viewers to submit prompts under the owner's authority.

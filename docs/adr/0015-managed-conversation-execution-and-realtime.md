# Managed Conversation Execution Uses A Fenced Runtime And Durable Realtime Stream

Execution owner routing is defined in [Managed Conversation AI Client Routing](../managed-conversation-ai-client-routing.md). Every execution persists explicit AI Client instance identity; runtime lifecycle selection is fail-closed and provider-neutral.

Status: Accepted.

Related decisions:

- [0007 Desktop Control Plane Consumes koed-server](./0007-desktop-control-plane-consumes-koed-server.md)
- [0008 Explorer-First Auth And Device Enrollment](./0008-explorer-first-auth-and-device-enrollment.md)
- [0013 Team Collaboration Uses Device-Mediated, Server-Authorized Operations](./0013-team-collaboration-authority.md)
- [0014 Hosted Personal Replication Uses The Conversation Source Journal](./0014-hosted-personal-source-replication.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)
- [0032 AI Client Instance, Capability, And Permission Contracts](./0032-ai-client-instance-capability-and-permission-contracts.md)
- [0033 Runner-Owned Worktrees And Execution Checkpoints](./0033-runner-owned-worktrees-and-execution-checkpoints.md)
- [0042 Conversation Source Presentation Is Independent From Memory Projection](./0042-conversation-source-presentation-policy.md)

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
API persists only a pending local source locator and wakes the selected runner.
The runner creates or selects the execution workspace, verifies its filesystem
and VCS identity, persists the immutable workspace binding, and only then
acknowledges the matching execution generation so the authority can release
that command.
An unknown local Project, missing path, stale generation, or failed readiness
acknowledgement fails closed.

Starting a managed Conversation persists its complete launch configuration on
the execution before a command can be released: AI Client driver and instance,
model, optional reasoning effort, Koed permission mode, and exact runner kind.
Desktop obtains the selectable values from the current redacted capability
snapshot; it does not construct provider names, models, permissions, or runner
identities. The local edge validates the selection against that snapshot, and
the selected runner resolves the same instance and native permission mapping
again before launch. A stale capability, unavailable instance, unsupported
model, inexact permission mapping, or mismatched runner fails closed.

The launch configuration is immutable for one execution. Resume, recovery,
handoff, and fork execution paths consume the persisted values rather than
current process defaults. A failed resume never silently creates a new
provider Conversation. Changing AI Client, account, model, or permissions is a
separate explicit product operation with its own provider capability and
identity semantics; it is not an incidental side effect of reconnecting.

### Provider Adapter

The provider adapter must expose explicit capabilities rather than relying on
filesystem guesses:

- create a provider Conversation;
- attach to or restore a compatible provider Conversation;
- submit one User prompt with a caller idempotency key;
- stream typed lifecycle events;
- surface provider approval and structured User-input requests;
- interrupt the active turn without waiting behind its prompt command;
- report provider Conversation, turn, and item identities;
- seal and report the durable source boundary;
- declare provider and artifact format compatibility;
- confirm whether restoration preserved the same provider Conversation
  identity.

Codex uses its native app-server, Claude Code uses the official Agent SDK,
and Pi uses its installed public SDK with the native RPC server. Each adapter
provides cancellation, approval interaction, and streaming presentation through
the shared capability contract. Provider credentials,
provider home, app-server stdio, and raw protocol messages remain inside the
runner boundary.

A local Codex execution uses the Codex home belonging to the selected AI Client
instance. The default instance uses the User's existing `CODEX_HOME`, normally
`~/.codex`. Koed does not create a per-Conversation Codex home, copy credentials
into one, or replace the User's Codex configuration. The selected Project
checkout or explicit managed worktree is passed as the app-server process
working directory and as the working directory for thread start, resume, and
fork operations. Codex home selects provider identity and configuration;
working directory selects the code being changed. Neither substitutes for the
other.

The managed app-server process registers Koed's packaged stdio MCP entry with
the active local `KOED_HOME`. This process-scoped overlay keeps Memory Answer
bound to the same runtime as Desktop without rewriting the User's Codex
configuration, replacing other MCP entries, or placing API credentials on the
command line. Claude's strict SDK MCP configuration uses the same connection.

Multiple managed Conversations may use the same Codex home concurrently. Koed
fences commands and writable execution workspaces, not the User's provider
configuration directory. Stopping or cleaning up an execution must never
remove or rewrite that Codex home.

Provider-reported token and context-window snapshots are durable product
telemetry, not Conversation Source or Memory. The execution runner records one
idempotent usage row per completed prompt command. A local runner keeps that row
on the local edge even when execution authority is hosted; only a bounded,
owner-authorized presentation projection reaches Desktop. Missing or estimated
usage never becomes an invented exact value.

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

The start command is also a durable acceptance boundary. Once it is accepted,
Desktop may open the Conversation immediately and accept an initial prompt
while the provider runtime is still starting. The prompt is stored against the
accepted execution generation, but command claiming enforces predecessor order:
the start command must reach a terminal successful state and bind the canonical
Captured Session and provider Conversation identities before the prompt can be
claimed. A failed or indeterminate predecessor blocks later prompts instead of
letting them run against provisional identity.

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

### Provider terminal evidence

Claude and Pi preserve the managed semantic Projection hold. Their local runner
requests release only after canonical capture, and the API independently verifies
native terminal records in digest-checked retained journal bytes. Runtime
completion and Capture Hook signals alone do not authorize release. Source
identity, owner, session, generation, lifecycle, exact captured blocks, and
Claude completion-control frontiers are checked before the normal Projection
path proceeds. See [service ordering](../service-sequence-overview.md#verified-managed-terminal-projection)
for the provider checks and bounded verification contract.

### Interactive Runtime Items And Controls

Provider approvals, structured User-input requests, and transient assistant
output use bounded runtime items owned by the same Personal User and execution.
They are not canonical Conversation items, Conversation Source, Memory Events,
or a second command authority.

Runtime items and provider deltas feed the owner-facing Conversation
presentation path immediately. Their presentation policy is independent from
Memory Projection. Once matching canonical source arrives, stable provider
identity replaces the provisional item without duplicating it. A completed
turn may be displayed before terminal Projection and embedding work finish.

Each provider request is identified by a digest of its provider method and
provider callback identity, then bound to the execution generation and optional
provider turn/item identities. Request payloads and User responses are
encrypted at the application layer. Replaying the same identity and digest
returns the existing item; reusing an identity for different content fails
closed. A response is accepted once. An exact replay returns the settled
response, while a conflicting second response, stale generation, wrong owner,
or terminal item is rejected.

The execution runner waits on the existing durable wake path for a response; it
does not poll. The runner translates the bounded Koed response into the exact
current provider protocol response and resolves the runtime item. Turn
completion, interruption, stop, fencing, and runner loss cancel unresolved
items so an old request cannot authorize later work.

Interrupt and stop are durable, idempotent control commands claimed through a
separate concurrent control lane. They remain owner-, runner-, device-, lease-,
and generation-fenced. Interrupt targets only the currently active provider
turn. Stop first enters `stopping`, prevents later prompt failure handling from
reviving the execution, closes the provider session, cancels runtime items, and
then records `stopped`.

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

Koed currently delivers Conversation updates through a cursor-based SSE stream
with an authenticated snapshot and explicit acknowledgement endpoint. Polling
is not part of the normal UI path. ADR 0031 assigns the same durable semantics
to the negotiated WebTransport, WebSocket, or SSE adapter; changing wire
transport does not change Conversation authority.

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

Desktop materializes ordinary managed-Conversation changes directly from the
authorized durable event. The event contains the current versioned execution,
the latest command identity and sequence, and at most one changed runtime item
with its execution generation and item revision. The client reducer rejects
stale generations, command sequences, and item revisions; a removal revision
also prevents a delayed upsert from resurrecting an item. This application
materialization contract is independent of whether SSE or WebTransport carries
the event.

Desktop loads one versioned runtime snapshot when it first attaches. It loads
another only after authoritative stream recovery, an execution-generation
change, or an explicit runtime reset that cannot be represented safely as one
item delta. Updates received while a snapshot is in flight are replayed over
that snapshot before it is exposed. An ordinary output, command, approval, or
input event must not trigger a second runtime-snapshot request. Missing or
incompatible delta state fails into snapshot recovery rather than inference.

Incremental provider deltas may be coalesced into encrypted, size-bounded
runtime rows for immediate typing/progress UX. They never become canonical
messages or Memory Events and never advance the durable cursor. A transient row
is revised in place for its exact execution/turn/item identity. Its final
revision remains available across the provider-completion race until the
matching canonical source item replaces it in the UI; starting the next turn or
ending the execution removes retained transient rows. Final provider items
become durable only after the source journal and canonical transaction commit.

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

Creating a Conversation does not wait for provider startup before navigating.
Desktop opens an execution-backed provisional surface after durable start
acceptance, keeps draft entry available, and reconciles the canonical Captured
Session and provider Conversation identities through realtime events. A prompt
submitted on that surface is durably queued behind startup. Startup failure is
shown in the same surface with an explicit retry that creates a new execution;
it never silently reuses a failed provider operation.

Provider approval and input cards are rendered only from active, validated
runtime items. Indeterminate command dispatch is shown explicitly and is never
presented as successful or automatically retried. Provider child-Agent threads
use their durable parent-thread lineage and may nest recursively; UI grouping
does not change their source identity or authority.

Desktop keeps an unsent prompt draft outside canonical Conversation state.
When platform secure storage is available, Desktop main encrypts it under a
key derived from the authenticated User, backend identity, Project, Captured
Session, and provider thread. The renderer never receives the secure-store
key or provider credentials. Drafts are local presentation state, do not sync,
do not enter source ingestion or Memory, and are deleted only after durable
prompt-command acceptance. A failed or indeterminate submission retains the
draft for recovery.

Desktop distinguishes a definitive pre-dispatch refusal from an indeterminate
provider acceptance. A definitive refusal removes the optimistic Conversation
row and restores the draft and attachments because no prompt was submitted. An
indeterminate result keeps the optimistic row visible and fences further
submission until durable command and source reconciliation establish the
outcome; it is never represented as a successful canonical turn.

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

For Git Projects, each mutating prompt is additionally fenced by the local
content-baseline contract in ADR 0033. Terminal checkpoint retry is a durable
post-provider phase and never causes prompt replay. These local refs are not
execution ownership, source replication, or handoff artifacts.

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

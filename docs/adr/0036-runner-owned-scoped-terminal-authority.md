# ADR 0036: Terminals Are Runner-Owned Scoped Executions

- Status: Accepted
- Date: 2026-08-18

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0016 Exclusive Execution Handoff And Fork Lineage](./0016-exclusive-execution-handoff-and-fork-lineage.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)
- [0033 Runner-Owned Worktrees And Execution Checkpoints](./0033-runner-owned-worktrees-and-execution-checkpoints.md)
- [0035 Runner-Owned Rooted File Authority](./0035-runner-owned-rooted-file-authority.md)

## Context

A coding workspace needs an interactive terminal for build, test, development
server, source-control, and diagnostic work that does not belong inside an AI
Client turn. A terminal is materially more powerful than file inspection. It
can read credentials, mutate the workspace, start listeners, access the
network, and leave descendant processes running after its visible shell exits.

This terminal is also distinct from commands an AI Client executes through its
own provider runtime. Provider tool calls continue to use the selected AI
Client's permission and approval bridge. A terminal does not intercept,
duplicate, or become an alternate audit path for those tool calls.

Desktop, Explorer, and remote coordinators do not own the execution workspace
or its process namespace. A renderer-provided working directory, command,
environment, process id, or open stream cannot become authority. Connection
liveness also cannot prove that a process is alive or that a User remains
authorized.

Terminal traffic has different delivery needs from durable collaboration
events. Output and input are low-latency bidirectional bytes, while lifecycle,
ownership, and recovery state must survive reconnects. Treating every byte as
a durable outbox event would add storage, expose secret-bearing content, and
couple terminal backpressure to canonical product state.

## Decision

The runner that owns a verified managed execution-workspace binding is the
sole authority for terminal processes in that workspace. Koed provides a
bounded terminal service, not a generic remote command endpoint. Desktop and
Explorer use typed Koed APIs and negotiated realtime streams; they never spawn
or signal operating-system processes directly.

The initial capability is Personal and owner-only. Team Membership, Workspace
Access, Conversation visibility, a Share Grant, or permission to watch a
shared Conversation does not grant terminal access. Team terminal delegation,
co-control, sponsorship, or observation requires a later explicit authority
decision.

Every terminal operation is bound to:

- the owning Personal User;
- an authenticated browser session or enrolled device credential with the
  separate `managed_terminal` operation family;
- one managed execution id and current fencing generation;
- the exact execution-workspace binding and assigned runner;
- one opaque terminal id and lifecycle generation; and
- the requested action, stream attachment, and protocol limits.

Personal API Tokens remain Memory-only and cannot create, attach, write,
resize, signal, inspect, or stop terminals.

For a local execution profile, Electron main may use Koed's encrypted,
owner-bound Desktop Local Credential with the exact `managed_terminal`
operation family over the loopback API. The credential remains outside preload
and renderer code and is rejected on non-loopback requests. This does not grant
Team, remote-device, or generic process authority.

### Terminal And Process Ownership

A managed execution may own a bounded number of terminals. Each terminal has
one server-derived opaque id, one runner, one workspace binding, one process
group, and one lifecycle generation. Terminal records persist only bounded
lifecycle metadata: owner, execution, runner, generation, shell profile id,
dimensions, state, exit classification, timestamps, and redacted failure code.
They do not contain commands, environment values, terminal bytes, local paths,
or process ids visible outside the runner.

The runner creates the pseudoterminal and the entire descendant process group.
It verifies the current execution lease and workspace binding immediately
before spawn. The child starts in the verified workspace root. A caller cannot
select another directory, executable, user, container, namespace, or process
to attach.

Execution handoff does not migrate a live terminal. The source runner must
quiesce and terminate its terminal process groups before handoff can attest
exclusive execution release. The target may create new terminals only after
the new execution generation and workspace binding are authoritative. A fork
never copies a live process or terminal byte stream.

### Shell And Environment

The runner selects a versioned shell profile from Operator and platform policy.
The renderer may select only an advertised profile id. It cannot submit an
executable path, arguments, startup file, environment map, login mode, or shell
initialization command.

Local Personal mode may expose the User's verified default interactive shell
through an explicit local profile. Hosted runners expose only provisioned
shells inside their isolated runtime. Unsupported, missing, changed, or
unverified profiles fail closed rather than falling back to another shell.

Koed constructs the environment at spawn time. It begins with a runner-owned
platform baseline, adds the execution workspace and explicitly configured
toolchain values, and supplies only secret references resolved inside the
runner boundary. Renderer, prompt, Project metadata, Team data, and remote
coordinator payloads cannot add arbitrary environment variables. Control
variables that can inject code or alter loaders, hooks, credential helpers,
runtimes, or Koed internals are denied unless the selected local shell profile
explicitly owns them.

Terminal startup files remain User-controlled code in Local Personal mode.
Koed reports that boundary honestly and does not claim sandboxing merely
because the process uses a pseudoterminal. Hosted profiles use an isolated
runtime with explicit CPU, memory, process, disk, network, and credential
policy.

### Lifecycle And Controls

The principal lifecycle is:

```text
creating -> running <-> detached -> stopping -> exited
    |          |           |
    |          +-----------+-> exited
    +--------------------------> failed
runner loss from an active state -> unknown -> exited | failed
```

Creation is an idempotent durable mutation. Reusing an idempotency key with the
same request returns the same terminal; a changed request fails. A terminal is
`running` only after the assigned runner has created the PTY and published the
matching lifecycle generation.

Attach, input, resize, interrupt, and stop reauthorize the current User,
credential scope, execution generation, workspace, runner, and terminal
generation. Resize accepts bounded positive rows and columns. Input accepts
bounded binary frames, not shell command strings or server-side interpolation.
No endpoint accepts an arbitrary signal number or operating-system process id.

Interrupt sends the platform's terminal interrupt semantics to the owned
foreground process group. Stop closes input, requests graceful process-group
termination, waits for a bounded deadline, and escalates through the
platform-specific hard-stop mechanism. The runner reaps descendants and
records one terminal exit classification. Conversation stop, workspace
cleanup, execution handoff, runner shutdown, credential revocation, or lost
ownership invokes the same idempotent process-group cleanup path.

Settling, snoozing, hiding, or archiving a Conversation does not stop its
terminal. Workspace cleanup cannot begin while any terminal is non-terminal.
An unexpected runner loss marks terminal state `unknown` until bounded
reconciliation proves exit; Koed never claims that a remote process stopped
from lease expiry alone.

### Interactive Transport

Terminal bytes use the interactive traffic class from ADR 0031. The preferred
path is a dedicated reliable WebTransport stream within the admitted backend
session. WebSocket uses the same typed framing and flow-control contract as a
compatibility adapter. Finite create, list, stop, and recovery operations use
bounded HTTPS. SSE and the durable collaboration outbox do not carry terminal
bytes.

Opening a network interactive stream requires a short-lived, single-use
transport ticket admitted for `managed_terminal`, followed by exactly one
attach frame. Electron main may instead open the local WebSocket compatibility
adapter with its loopback-only Desktop Local Credential; the API validates that
credential before attach and periodically for the stream lifetime.
The attach frame binds principal, device or browser session, backend, client,
execution generation, workspace, runner, terminal generation, and requested
direction. Transport admission grants no terminal authority; the runner and
authority recheck authorization on attach and periodically while attached.

Input frames carry one attachment generation and monotonically increasing
sequence. The runner acknowledges the highest applied sequence and deduplicates
within that attachment. A client may retry an unacknowledged frame only while
the same attachment remains authoritative. It must not replay ambiguous input
after reconnect, generation change, or process recovery because duplicate
shell input can repeat side effects.

Output frames carry a monotonically increasing terminal sequence. The runner
retains a bounded in-memory replay ring for the terminal lifetime. Reattach may
request a sequence in that ring. If the cursor is too old, the service emits an
explicit gap and the retained tail; it never presents the tail as complete
history. Output is not written to the canonical collaboration outbox,
Conversation Source, Memory, logs, analytics, or ordinary database rows.

Each attachment has independent byte, frame, queue, and time bounds. Slow
consumers are detached before they can block unrelated durable events,
approvals, terminals, or collaboration. The runner may apply PTY backpressure
within a short bound; persistent overflow produces an explicit gap or stops the
terminal according to deployment policy. It never grows an unbounded queue.

### Disconnect And Recovery

Closing a renderer, losing a network path, or switching views detaches the
stream; it does not immediately kill the terminal. The owning runner keeps a
detached terminal for a bounded Operator-configured lifetime, subject to
resource limits. The lifecycle API exposes `running`, `detached`, `unknown`,
and terminal states without exposing bytes or local process identity.

Reattach requires fresh authorization and the same authoritative execution and
terminal generations. Revoked credentials, access suspension, execution
handoff, workspace mismatch, terminal expiry, runner mismatch, or stale
generation fails closed. A process that cannot be proved alive is not silently
recreated. Starting a replacement terminal is a new explicit operation and id.

### Terminal Context References

Terminal output is not automatically captured as Conversation Source, Memory,
an AI Client prompt, or a Team artifact. The owning User may explicitly create
a short-lived structured terminal-context reference from a bounded range still
present in the runner's replay ring.

The reference binds terminal and execution generations, exact output sequence
range, content digest, issuing principal, purpose, and expiry. Prompt
submission carries only the opaque reference. The runner reauthorizes it,
verifies the exact retained bytes, applies current content and secret policy,
and supplies bounded inert text to the AI Client. Expired, truncated, changed,
binary, denied, stale, or unavailable context fails rather than attaching a
different tail. No automatic terminal summarization or Memory capture is added
by this capability.

### Security, Privacy, And Audit

Terminal content is sensitive. Commands, output, environment values, cwd,
local paths, process ids, stream tickets, and terminal-context bytes do not
enter logs, traces, metrics, diagnostics, audit summaries, crash reports, or
support views. Remote transport uses the deployment's authenticated TLS
boundary and carries bytes only to the current authorized owning client and
runner. A coordinator may route frames in memory but does not persist terminal
content.

Audit and telemetry are content-free: operation class, terminal state,
principal and runner ids, execution generation, shell profile id, redacted
reason code, duration, byte-count buckets, gap count, and stop classification.
Transport tickets, device credentials, provider credentials, repository
credentials, and resolved environment secrets are never exposed to the
renderer or terminal child environment unless the selected runner policy
explicitly injects a task credential for that terminal.

Terminal rendering treats output as terminal data, not HTML. Escape sequences
are parsed by a maintained terminal emulator with bounded buffers and no URI,
clipboard, file, notification, or host-command side effects unless a later
explicit policy enables one. OSC hyperlinks and other rich sequences remain
inert by default. Paste is an explicit User action and bracketed-paste support
does not weaken input authorization.

## Required Evidence

Implementation must prove:

- owning-User create, attach, resize, input, interrupt, stop, and reattach;
- denial for another User, Team viewer, Personal API Token, wrong operation
  family, revoked device, stale execution or terminal generation, wrong runner,
  cleaned workspace, and suspended access;
- no caller-selected cwd, executable, environment, process id, signal, or
  terminal id substitution;
- process-group cleanup for shell exit, descendants, Conversation stop,
  handoff, workspace cleanup, runner crash/restart, and graceful-stop timeout;
- ordered input acknowledgement and deduplication, no ambiguous reconnect
  replay, output replay within bounds, explicit output gaps, resize ordering,
  flow control, and slow-consumer isolation;
- WebTransport and WebSocket behavior through one codec, ticket admission,
  periodic reauthorization, fallback, reconnect, and transport downgrade;
- terminal-context issue, exact prompt-time resolution, expiry, stale range,
  secret denial, capacity, and truncation behavior;
- content-free database rows, logs, metrics, diagnostics, audits, crash paths,
  and remote coordination; and
- native PTY, process-group, signal, resize, shell-profile, and cleanup behavior
  on Linux, WSL, macOS, and Windows before each platform is claimed.

## Consequences

- Koed gains one terminal authority for local and hosted managed coding without
  giving renderers or remote coordinators ambient process access.
- Terminal bytes remain low-latency and bounded without becoming durable
  product data or competing with collaboration replay.
- A disconnected terminal can survive briefly, but output older than the
  bounded replay ring is honestly reported as a gap.
- Live terminals cannot migrate across execution handoff; portability remains
  source and workspace based rather than process based.
- Team terminal collaboration, terminal recording, automatic Memory capture,
  arbitrary command APIs, and shell-profile customization require separate
  decisions.

## Rejected Alternatives

- Exposing Node process or PTY APIs to Electron renderers.
- Treating an open socket, process id, Project path, or Team visibility as
  terminal authority.
- Sending shell command strings through a generic remote-exec endpoint.
- Letting the renderer choose cwd, executable, arguments, environment, signals,
  or startup files.
- Persisting every terminal byte in the durable collaboration outbox or
  Conversation Source.
- Replaying unacknowledged terminal input after an ambiguous reconnect.
- Treating terminal output as automatic AI Client context or Memory.
- Keeping live terminals through execution handoff or copying process state to
  another device.
- Allowing Team viewers to attach because they can watch the Conversation.

# ADR 0037: Development Previews Are Runner-Owned And Browser-Isolated

- Status: Accepted
- Date: 2026-08-19

Related decisions:

- [0015 Managed Conversation Execution And Realtime](./0015-managed-conversation-execution-and-realtime.md)
- [0024 Tiered Desktop Action Approval](./0024-tiered-desktop-action-approval.md)
- [0031 Realtime Transport Allocation And Negotiation](./0031-realtime-transport-allocation-and-negotiation.md)
- [0033 Runner-Owned Worktrees And Execution Checkpoints](./0033-runner-owned-worktrees-and-execution-checkpoints.md)
- [0035 File Access Uses Runner-Owned Rooted Capabilities](./0035-runner-owned-rooted-file-authority.md)
- [0036 Terminals Are Runner-Owned Scoped Executions](./0036-runner-owned-scoped-terminal-authority.md)

## Context

A managed coding Conversation needs to show a development server running in its
execution workspace. A renderer-provided URL, an open TCP port, terminal text,
or a Project path is not sufficient authority to expose a service. Local
machines commonly run databases, control planes, cloud metadata emulators,
debuggers, and services carrying credentials. Blind port scanning or navigating
to an arbitrary URL would turn preview into a local-network request primitive.

Development applications are also untrusted browser content. They can execute
JavaScript, navigate, open windows, request permissions, download files, retain
cookies, contact private network addresses, and attempt to reach Koed's own
authenticated origin. Loading that content in Koed's application renderer or
its authenticated browser partition would cross a critical credential and code
execution boundary.

Local and remote runners complicate the path but not the authority. The runner
owns the process namespace and listener; a coordinator or Desktop may present a
preview without acquiring a reusable runner credential or exposing the port to
the public network. Team access to a Conversation likewise does not imply
access to a live application, its cookies, or browser automation.

## Decision

The runner that owns the current managed execution and execution-workspace
binding is the sole authority for development-server discovery and preview
publication. Koed exposes only verified, opaque preview identities. It does not
offer a general URL browser, port scanner, reverse proxy, or Chrome DevTools
Protocol endpoint.

The initial preview is owner-only and interactive as ordinary browser content,
but Koed automation is disabled. Team viewing, automated interaction,
recording, screenshots, annotations, and provider control are distinct future
capabilities with separate authorization and consent.

Every preview binds:

- the owning Personal User;
- the managed execution id and current fencing generation;
- the exact execution-workspace binding and assigned runner;
- a runner-verified process group and listener identity;
- one normalized loopback HTTP or HTTPS origin;
- a lifecycle generation, creation source, and expiry; and
- the network, navigation, storage, and permission policy version.

Personal API Tokens, Team Membership, Workspace Access, Conversation Source
Access, Share Grants, file-read authority, and terminal authority do not grant
preview access.

### Discovery And Listener Proof

Discovery is event-driven and bounded. The runner may nominate a candidate when
a process in an execution-owned terminal or provider process group emits a
well-formed loopback HTTP or HTTPS URL. A User may also submit a port candidate
for the current execution. Neither path is authority by itself.

Before publication, the runner must prove that:

- the listener is bound to loopback, not a wildcard, LAN, VPN, container-host,
  metadata, or public address;
- the listener belongs to the current execution's process group or a verified
  descendant;
- the process and workspace generations still match;
- the port and scheme satisfy deployment policy; and
- a bounded HTTP readiness probe returns a valid response without following a
  redirect outside the candidate origin.

Koed does not sweep port ranges, inspect unrelated processes, trust terminal
text alone, or probe caller-selected hosts. Platform support requires a native
listener-ownership implementation and tests. If ownership cannot be proved,
the candidate remains unavailable with a stable reason code.

The runner emits lifecycle changes when a verified listener appears, changes,
or closes. UI refresh uses durable state plus realtime wake signals; normal
operation does not poll preview endpoints or the Conversation API.

### Local And Remote Delivery

For a local runner, Electron main connects to the verified loopback origin. The
renderer receives only an opaque preview id and typed lifecycle data. It never
receives the runner URL, port, process id, absolute path, or Desktop Local
Credential.

For a remote runner, the runner establishes an outbound authenticated preview
stream through the accepted interactive transport. The coordinator exposes a
dedicated preview origin and relays bounded HTTP and WebSocket traffic to the
verified listener. No inbound runner port is required. The relay reauthorizes
the owning User, execution generation, preview generation, and runner lease;
applies flow, body, header, connection, and duration limits; and closes on
revocation or fencing.

Preview admission uses a single-use, short-lived ticket exchanged for an
HttpOnly preview-session cookie scoped to the dedicated preview origin and
preview generation. The ticket is never placed in browser history, application
content, logs, analytics, or a reusable query string. Koed API session cookies,
API Tokens, device credentials, Desktop Local Credentials, upstream
credentials, provider credentials, and source-control credentials are never
forwarded to preview content.

Each preview origin is isolated from Koed's API and application origins. A
deployment that cannot provide that origin boundary does not advertise remote
preview capability.

### Browser Isolation

Desktop owns preview web contents in the main process. It uses an ephemeral,
non-persistent partition unique to the User, execution generation, and preview
generation, with:

- sandbox enabled;
- Node integration disabled;
- context isolation enabled;
- no preload bridge or Electron API exposure;
- web security enabled;
- permission requests denied by default;
- downloads, popups, external protocols, and automatic external navigation
  denied;
- DevTools disabled in normal product operation; and
- cache, cookies, storage, service workers, and permissions destroyed when the
  preview generation closes.

The application renderer controls only typed attach, bounds, focus, reload,
viewport, and detach commands for an opaque preview id. It cannot navigate the
web contents to an arbitrary URL or inspect its DOM, cookies, console,
network traffic, or Chrome DevTools Protocol.

The preview network policy permits its verified origin and same-generation
hot-reload endpoint. Other loopback, private-network, link-local, metadata,
file, custom-scheme, and Koed origins are denied. Public HTTP(S) subresources
are denied by default and may be enabled only through an explicit per-preview
origin grant shown to the owning User. Redirects, DNS results, WebSockets,
workers, and service workers are checked against the same policy for every
request; DNS rebinding or a changed resolved address fails closed.

Navigation inside the verified origin is allowed. Cross-origin top-level
navigation, `window.open`, downloads, protocol handlers, and requests for
camera, microphone, screen capture, geolocation, notifications, MIDI, USB,
serial, Bluetooth, clipboard, filesystem, or persistent storage are blocked.
The UI may offer an explicit `Open in system browser` action after showing the
destination, but preview content cannot invoke it directly.

### Cookies, Credentials, And Application Data

Development-application cookies and storage belong only to the ephemeral
preview partition. They are never copied from the system browser, Koed
renderer, another preview, another device, or another User. Koed does not
inject application login credentials or rewrite authorization headers.

A User may type test credentials into the preview as they could in a private
browser window, but Koed does not retain, sync, record, attach, summarize, or
expose them. Password managers and system credential providers are unavailable
inside the initial embedded preview. Closing or invalidating the preview
destroys its browser state.

### Automation, Recording, And Team Viewing

Browser automation is not part of the initial preview capability. A later
automation capability must use structured, bounded operations implemented by
the preview owner. It must not expose raw Chrome DevTools Protocol, arbitrary
JavaScript evaluation, renderer-selected network requests, or reusable browser
credentials to an AI Client, Team viewer, or remote coordinator.

Automation requires an explicit action grant bound to User, preview,
execution, generation, operation family, target, expiry, and provider command.
Sensitive operations require foreground confirmation. Revocation, handoff,
navigation outside policy, or generation change cancels in-flight automation.

Recording, screenshots, DOM snapshots, console output, and network traces are
off by default. Enabling any capture requires a visible indicator and explicit
scope. Captured data is treated as potentially secret source material, remains
outside Personal Memory and Team Memory by default, and follows a separate
encrypted artifact, retention, redaction, consent, and sharing policy.

Team viewers receive no preview access from Conversation or Memory sharing.
Future Team viewing requires an explicit, revocable preview-view grant, a
separate clean browser partition, current authorization on every connection,
and no owner cookies, local storage, automation, terminal, file, or source
control authority. Owner and viewer sessions are never the same browser
session.

### Lifecycle, Recovery, And Telemetry

A preview is unavailable when its listener, process ownership, runner lease,
execution generation, workspace binding, or authorization cannot be verified.
It is invalidated by execution handoff, runner disconnect beyond the bounded
reconnect window, workspace cleanup, device revocation, access suspension,
process exit, port reuse, or policy change. Reusing the same port creates a new
preview generation and browser partition.

Detaching the UI does not stop the development server. Stopping a terminal
follows ADR 0036 process-group policy and may stop its preview. Workspace
cleanup remains blocked while an active preview or development-server process
owns the workspace.

Logs, metrics, traces, audits, diagnostics, and durable events contain only
opaque ids, lifecycle state, reason codes, byte/connection/duration buckets,
policy versions, and runner class. URLs beyond normalized origin class, page
content, query strings, fragments, headers, cookies, DOM, console output,
screenshots, and response bodies are excluded.

## Required Evidence

The implementation must prove:

- listener ownership and denial for arbitrary, wildcard, unrelated-process,
  stale-generation, wrong-runner, reused-port, and non-loopback candidates;
- owner access and denial for another User, Team viewer, Personal API Token,
  revoked device, stale ticket, replayed ticket, wrong preview, and expired
  generation;
- local and remote delivery without exposing runner ports, paths, process ids,
  or reusable credentials;
- isolation from Koed cookies, other previews, system-browser state, filesystem,
  Electron APIs, Node APIs, downloads, popups, protocols, and denied device
  permissions;
- request and navigation blocking for loopback peers, private networks,
  link-local and metadata addresses, DNS rebinding, redirects, workers,
  WebSockets, and Koed origins;
- bounded HTTP, WebSocket, header, body, connection, duration, and backpressure
  behavior;
- hot reload, reload, resize, detach, reconnect, process exit, crash, handoff,
  port reuse, cleanup, and revocation behavior; and
- content-free logs, events, metrics, diagnostics, and audit records.

Native listener-ownership and browser-isolation evidence covers Linux, WSL on
a Linux filesystem, WSL on DrvFS, macOS, and Windows before each platform is
claimed. Unsupported paths remain explicit and do not fall back to blind scan
or arbitrary navigation.

## Consequences

- Koed can present local and remote development servers without turning
  preview into ambient browser, network, or credential authority.
- Development applications retain normal same-origin behavior and hot reload
  inside a disposable browser profile.
- Some applications need explicit public-origin grants, and unsupported
  listener ownership prevents preview publication.
- Team preview, automation, and recording remain deliberate later features
  rather than accidental extensions of Conversation access.
- Remote preview requires a dedicated origin, ticket exchange, bounded relay,
  and end-to-end deployment proof.

## Rejected Alternatives

- Loading development content in Koed's application renderer or authenticated
  browser partition.
- Accepting an arbitrary URL, hostname, port, or redirect from the renderer,
  terminal output, AI Client, or Team viewer.
- Scanning local port ranges or treating a successful HTTP response as process
  ownership.
- Exposing a runner port publicly or requiring inbound access to a local
  device.
- Forwarding Koed, provider, source-control, device, or Desktop credentials to
  preview content.
- Sharing owner cookies or preview authority with Team viewers.
- Exposing raw Chrome DevTools Protocol or arbitrary JavaScript execution as an
  automation API.
- Recording preview content by default or treating it as Memory automatically.
